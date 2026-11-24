mod windows;

use std::collections::VecDeque;

use ironrdp_core::{AsAny, decode};
use ironrdp_pdu::gcc::{ChannelName, ChannelOptions};
use ironrdp_pdu::{PduError, PduErrorExt as _, PduErrorKind, PduResult, decode_err};
use ironrdp_svc::{ChannelFlags, SvcClientProcessor, SvcMessage, SvcProcessor, SvcProcessorMessages};

use crate::pdu::{
    ActivatePdu, ClientStatusPdu, ClientSystemParameter, ClientSystemParametersPdu, CloakPdu, CompartmentInfoPdu,
    ExecutePdu, ExecuteResultPdu, GetApplicationIdRequestPdu, GetApplicationIdResponseExPdu,
    GetApplicationIdResponsePdu, HandshakeExPdu, HandshakePdu, LanguageBarInfoPdu, NotifyEventPdu,
    PowerDisplayRequestPdu, RailPdu, ServerSystemParametersPdu, SystemCommandPdu, SystemMenuPdu,
    SystemParameterRectangle, WindowMovePdu, ZOrderSyncPdu, decode_server_pdu_lenient,
};

pub use self::windows::{RailRect, RailWindow, RailWindowChanges, RailWindowEvent, RailWindowRole, RailWindowTracker};

/// Client-originated RAIL events exposed through this host-neutral boundary.
///
/// IME controls are not exposed yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RailInputEvent {
    Activate(ActivatePdu),
    SystemMenu(SystemMenuPdu),
    SystemCommand(SystemCommandPdu),
    NotifyEvent(NotifyEventPdu),
    GetApplicationId(GetApplicationIdRequestPdu),
    WindowMove(WindowMovePdu),
}

impl From<RailInputEvent> for RailPdu {
    fn from(event: RailInputEvent) -> Self {
        match event {
            RailInputEvent::Activate(pdu) => Self::Activate(pdu),
            RailInputEvent::SystemMenu(pdu) => Self::SystemMenu(pdu),
            RailInputEvent::SystemCommand(pdu) => Self::SystemCommand(pdu),
            RailInputEvent::NotifyEvent(pdu) => Self::NotifyEvent(pdu),
            RailInputEvent::GetApplicationId(pdu) => Self::GetApplicationIdRequest(pdu),
            RailInputEvent::WindowMove(pdu) => Self::WindowMove(pdu),
        }
    }
}

/// Portable server-originated RAIL controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RailControlEvent {
    SystemParameters(ServerSystemParametersPdu),
    LanguageBar(LanguageBarInfoPdu),
    Compartment(CompartmentInfoPdu),
    ZOrderSync(ZOrderSyncPdu),
    Cloak(CloakPdu),
    PowerDisplayRequest(PowerDisplayRequestPdu),
}

/// Events emitted by a client-side RAIL channel processor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RailEvent {
    Handshake {
        handshake_ex_flags: Option<u32>,
        initialization_message_count: usize,
        queued_execute_count: usize,
    },
    DesktopSynchronized {
        released_execute_count: usize,
    },
    PostHandshakeQueueReleased {
        released_execute_count: usize,
    },
    ExecuteResult(ExecuteResultPdu),
    ApplicationId {
        window_id: u32,
        application_id: String,
        process_id: Option<u32>,
        process_image_name: Option<String>,
    },
    Control(RailControlEvent),
    /// The server sent another Handshake after initialization and restarted its RAIL state.
    ///
    /// The client answered with the desktop work area; the server re-announces its windows.
    ServerReinitialized {
        handshake_ex_flags: Option<u32>,
    },
    /// [`RailClient::initiate`] got no Handshake after the configured number of attempts.
    InitiationExhausted {
        attempts: u32,
    },
    /// A server PDU violated the protocol and was ignored under [`RailServerCompat::warn_instead_of_fail`].
    ProtocolWarning {
        description: String,
    },
}

/// Tolerances for RAIL servers that deviate from [MS-RDPERP].
///
/// [MS-RDPERP]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[expect(clippy::struct_excessive_bools, reason = "each tolerance is an independent switch")]
pub struct RailServerCompat {
    /// Accept a Handshake whose `orderLength` counts only the body.
    pub lenient_handshake_length: bool,
    /// Treat a Handshake after initialization as a server restart instead of an error.
    pub accept_repeated_handshake: bool,
    /// Do not expect an Execute Result for each Execute.
    pub untracked_executes: bool,
    /// Report protocol violations as [`RailEvent::ProtocolWarning`] instead of failing.
    pub warn_instead_of_fail: bool,
}

impl RailServerCompat {
    /// Strict [MS-RDPERP] behavior (the default).
    ///
    /// [MS-RDPERP]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/
    pub const STRICT: Self = Self {
        lenient_handshake_length: false,
        accept_repeated_handshake: false,
        untracked_executes: false,
        warn_instead_of_fail: false,
    };

    /// xrdp's chansrv: Handshake length counts only the body, every Execute restarts its RAIL
    /// state (and re-sends the Handshake), and no Execute Result is ever sent.
    pub const XRDP: Self = Self {
        lenient_handshake_length: true,
        accept_repeated_handshake: true,
        untracked_executes: true,
        warn_instead_of_fail: true,
    };
}

/// PDUs emitted by [`RailClient`].
pub type RailSvcMessages = SvcProcessorMessages<RailClient>;

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum RailState {
    WaitingForHandshake,
    Established,
}

#[derive(Debug)]
enum QueuedRailPdu {
    Execute(ExecutePdu),
    Input(RailInputEvent),
}

#[derive(Debug, PartialEq, Eq)]
struct PendingExecute {
    flags: u16,
    executable: String,
}

#[derive(Debug)]
struct Initiation {
    bootstrap: ExecutePdu,
    attempts: u32,
    exhausted: bool,
}

/// Client-side processor for the RAIL static virtual channel.
#[derive(Debug)]
pub struct RailClient {
    build_number: u32,
    desktop_width: u16,
    desktop_height: u16,
    client_status_flags: u32,
    server_compat: RailServerCompat,
    max_initiation_attempts: u32,
    initiation: Option<Initiation>,
    state: RailState,
    desktop_synchronized: bool,
    queued_pdus: VecDeque<QueuedRailPdu>,
    pending_executes: VecDeque<PendingExecute>,
    events: VecDeque<RailEvent>,
}

impl RailClient {
    const CHANNEL_NAME: ChannelName = ChannelName::from_static(b"rail\0\0\0\0");
    const MAX_QUEUED_PDUS: usize = 128;
    const MAX_PENDING_EXECUTES: usize = 64;
    const MAX_EVENTS: usize = 256;
    const DEFAULT_MAX_INITIATION_ATTEMPTS: u32 = 24;

    /// Creates a RAIL static-channel processor for the client's build and desktop size.
    pub fn new(build_number: u32, desktop_width: u16, desktop_height: u16) -> Self {
        Self {
            build_number,
            desktop_width,
            desktop_height,
            client_status_flags: ClientStatusPdu::Z_ORDER_SYNC
                | ClientStatusPdu::POWER_DISPLAY_REQUEST
                | ClientStatusPdu::BIDIRECTIONAL_CLOAK,
            server_compat: RailServerCompat::STRICT,
            max_initiation_attempts: Self::DEFAULT_MAX_INITIATION_ATTEMPTS,
            initiation: None,
            state: RailState::WaitingForHandshake,
            desktop_synchronized: false,
            queued_pdus: VecDeque::new(),
            pending_executes: VecDeque::new(),
            events: VecDeque::new(),
        }
    }

    /// Overrides the RAIL Client Status flags advertised during initialization.
    #[must_use]
    pub fn with_client_status_flags(mut self, flags: u32) -> Self {
        self.client_status_flags = flags;
        self
    }

    /// Selects the tolerances applied to the server ([`RailServerCompat::STRICT`] by default).
    #[must_use]
    pub fn with_server_compat(mut self, server_compat: RailServerCompat) -> Self {
        self.server_compat = server_compat;
        self
    }

    /// Bounds how many times [`Self::initiate`] plus [`Self::resend_initiation`] send the bundle (24 by default).
    #[must_use]
    pub fn with_max_initiation_attempts(mut self, attempts: u32) -> Self {
        self.max_initiation_attempts = attempts.max(1);
        self
    }

    /// Returns the tolerances applied to the server.
    pub const fn server_compat(&self) -> RailServerCompat {
        self.server_compat
    }

    /// Returns whether the server Handshake was received.
    pub const fn is_established(&self) -> bool {
        matches!(self.state, RailState::Established)
    }

    /// Starts RAIL from the client side for servers that wait for a client Execute.
    ///
    /// Sends Handshake, Client Status and `bootstrap` (no work area: the server re-announces its
    /// windows when the work area arrives after its own Handshake). Once the server Handshake
    /// arrives, the client answers with the work area and releases queued PDUs at once.
    pub fn initiate(&mut self, bootstrap: ExecutePdu) -> PduResult<RailSvcMessages> {
        if self.is_established() {
            return Err(Self::protocol_error("RAIL is already established"));
        }
        Self::validate_queued_pdu(&QueuedRailPdu::Execute(bootstrap.clone()))?;
        let messages = self.initiation_messages(bootstrap.clone())?;
        self.initiation = Some(Initiation {
            bootstrap,
            attempts: 1,
            exhausted: false,
        });
        Ok(messages.into())
    }

    /// Sends the initiation bundle again while no server Handshake has arrived.
    ///
    /// Returns nothing once established or after the attempt limit, which emits
    /// [`RailEvent::InitiationExhausted`] once.
    pub fn resend_initiation(&mut self) -> PduResult<RailSvcMessages> {
        if self.is_established() {
            return Ok(Vec::new().into());
        }
        let max_attempts = self.max_initiation_attempts;
        let Some(initiation) = self.initiation.as_mut() else {
            return Ok(Vec::new().into());
        };
        if initiation.exhausted {
            return Ok(Vec::new().into());
        }
        if initiation.attempts >= max_attempts {
            initiation.exhausted = true;
            let attempts = initiation.attempts;
            self.push_event(RailEvent::InitiationExhausted { attempts })?;
            return Ok(Vec::new().into());
        }
        initiation.attempts = initiation.attempts.saturating_add(1);
        let bootstrap = initiation.bootstrap.clone();
        Ok(self.initiation_messages(bootstrap)?.into())
    }

    /// Queues a RemoteApp launch until initialization and desktop synchronization complete.
    pub fn queue_execute(&mut self, execute: ExecutePdu) -> PduResult<RailSvcMessages> {
        self.queue_pdu(QueuedRailPdu::Execute(execute))
    }

    /// Queues a client-originated RAIL input event.
    pub fn queue_input(&mut self, event: RailInputEvent) -> PduResult<RailSvcMessages> {
        self.queue_pdu(QueuedRailPdu::Input(event))
    }

    /// Releases queued RAIL input after the server completes desktop synchronization.
    pub fn complete_desktop_synchronization(&mut self) -> PduResult<RailSvcMessages> {
        if self.desktop_synchronized {
            return Ok(Vec::new().into());
        }

        self.desktop_synchronized = true;
        if !self.is_established() {
            return Ok(Vec::new().into());
        }

        let (messages, released_execute_count) = self.drain_queued_pdus()?;
        self.push_event(RailEvent::DesktopSynchronized { released_execute_count })?;
        Ok(messages.into())
    }

    /// Releases queued input after initialization when desktop synchronization is not observable.
    pub fn release_queued_after_handshake(&mut self) -> PduResult<RailSvcMessages> {
        if self.desktop_synchronized || !self.is_established() {
            return Ok(Vec::new().into());
        }

        self.desktop_synchronized = true;
        let (messages, released_execute_count) = self.drain_queued_pdus()?;
        self.push_event(RailEvent::PostHandshakeQueueReleased { released_execute_count })?;
        Ok(messages.into())
    }

    /// Updates the RAIL work area after the client desktop size changes.
    pub fn update_desktop_size(&mut self, desktop_width: u16, desktop_height: u16) -> RailSvcMessages {
        self.desktop_width = desktop_width;
        self.desktop_height = desktop_height;
        self.request_work_area()
    }

    /// Sends the current display and work area again once established.
    ///
    /// xrdp re-announces every mapped window when it receives a work area.
    pub fn request_work_area(&self) -> RailSvcMessages {
        if !self.is_established() {
            return Vec::new().into();
        }

        self.desktop_system_parameter_messages().into()
    }

    /// Returns and clears server events accumulated while processing channel PDUs.
    pub fn take_events(&mut self) -> Vec<RailEvent> {
        self.events.drain(..).collect()
    }

    fn queue_pdu(&mut self, pdu: QueuedRailPdu) -> PduResult<RailSvcMessages> {
        Self::validate_queued_pdu(&pdu)?;
        if !self.is_established() || !self.desktop_synchronized {
            if self.queued_pdus.len() >= Self::MAX_QUEUED_PDUS {
                return Err(Self::resource_limit_error("queued RAIL PDUs"));
            }
            if matches!(&pdu, QueuedRailPdu::Execute(_))
                && self.pending_executes.len() + self.queued_execute_count() >= Self::MAX_PENDING_EXECUTES
            {
                return Err(Self::resource_limit_error("RAIL execute requests"));
            }
            self.queued_pdus.push_back(pdu);
            return Ok(Vec::new().into());
        }

        Ok(self.send_pdu(pdu)?.into())
    }

    fn initiation_messages(&mut self, bootstrap: ExecutePdu) -> PduResult<Vec<SvcMessage>> {
        let mut messages = vec![
            Self::service_message(RailPdu::Handshake(HandshakePdu {
                build_number: self.build_number,
            })),
            Self::service_message(RailPdu::ClientStatus(ClientStatusPdu {
                flags: self.client_status_flags,
            })),
        ];
        messages.extend(self.send_pdu(QueuedRailPdu::Execute(bootstrap))?);
        Ok(messages)
    }

    fn initialization_messages(&self) -> Vec<SvcMessage> {
        let mut messages = vec![
            Self::service_message(RailPdu::Handshake(HandshakePdu {
                build_number: self.build_number,
            })),
            Self::service_message(RailPdu::ClientStatus(ClientStatusPdu {
                flags: self.client_status_flags,
            })),
        ];
        messages.extend(self.desktop_system_parameter_messages());
        messages.extend([
            Self::service_message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::FullWindowDrag(false),
            })),
            Self::service_message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::KeyboardCues(false),
            })),
            Self::service_message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::KeyboardPreference(false),
            })),
            Self::service_message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::MouseButtonSwap(false),
            })),
        ]);
        messages
    }

    fn desktop_system_parameter_messages(&self) -> Vec<SvcMessage> {
        let screen = SystemParameterRectangle {
            left: 0,
            top: 0,
            right: self.desktop_width,
            bottom: self.desktop_height,
        };
        [
            ClientSystemParameter::DisplayChange(screen),
            ClientSystemParameter::WorkArea(screen),
        ]
        .into_iter()
        .map(|parameter| {
            Self::service_message(RailPdu::ClientSystemParameters(ClientSystemParametersPdu { parameter }))
        })
        .collect()
    }

    fn queued_execute_count(&self) -> usize {
        self.queued_pdus
            .iter()
            .filter(|pdu| matches!(pdu, QueuedRailPdu::Execute(_)))
            .count()
    }

    fn finish_handshake(&mut self, handshake_ex_flags: Option<u32>) -> PduResult<Vec<SvcMessage>> {
        self.state = RailState::Established;
        let queued_execute_count = self.queued_execute_count();
        if self.initiation.is_some() {
            let mut messages = self.desktop_system_parameter_messages();
            self.push_event(RailEvent::Handshake {
                handshake_ex_flags,
                initialization_message_count: messages.len(),
                queued_execute_count,
            })?;
            self.desktop_synchronized = true;
            let (queued_messages, released_execute_count) = self.drain_queued_pdus()?;
            messages.extend(queued_messages);
            self.push_event(RailEvent::PostHandshakeQueueReleased { released_execute_count })?;
            return Ok(messages);
        }

        let mut messages = self.initialization_messages();
        self.push_event(RailEvent::Handshake {
            handshake_ex_flags,
            initialization_message_count: messages.len(),
            queued_execute_count,
        })?;
        if self.desktop_synchronized {
            let (queued_messages, released_execute_count) = self.drain_queued_pdus()?;
            messages.extend(queued_messages);
            self.push_event(RailEvent::DesktopSynchronized { released_execute_count })?;
        }
        Ok(messages)
    }

    fn repeated_handshake(&mut self, handshake_ex_flags: Option<u32>) -> PduResult<Vec<SvcMessage>> {
        if !self.server_compat.accept_repeated_handshake {
            return self.violation(Self::protocol_error("received duplicate RAIL server handshake"));
        }
        self.push_event(RailEvent::ServerReinitialized { handshake_ex_flags })?;
        Ok(self.desktop_system_parameter_messages())
    }

    fn send_pdu(&mut self, pdu: QueuedRailPdu) -> PduResult<Vec<SvcMessage>> {
        match pdu {
            QueuedRailPdu::Execute(execute) => {
                if !self.server_compat.untracked_executes {
                    if self.pending_executes.len() >= Self::MAX_PENDING_EXECUTES {
                        return Err(Self::resource_limit_error("pending RAIL execute requests"));
                    }
                    self.pending_executes.push_back(PendingExecute {
                        flags: execute.flags,
                        executable: execute.executable.clone(),
                    });
                }
                Ok(vec![Self::service_message(RailPdu::Execute(execute))])
            }
            QueuedRailPdu::Input(event) => Ok(vec![Self::service_message(RailPdu::from(event))]),
        }
    }

    fn drain_queued_pdus(&mut self) -> PduResult<(Vec<SvcMessage>, usize)> {
        let mut messages = Vec::new();
        let mut released_execute_count = 0;
        while let Some(pdu) = self.queued_pdus.pop_front() {
            if matches!(pdu, QueuedRailPdu::Execute(_)) {
                released_execute_count += 1;
            }
            messages.extend(self.send_pdu(pdu)?);
        }
        Ok((messages, released_execute_count))
    }

    fn execute_result(&mut self, result: ExecuteResultPdu) -> PduResult<Vec<SvcMessage>> {
        let index = self
            .pending_executes
            .iter()
            .position(|request| request.flags == result.flags && request.executable == result.executable);
        match index {
            Some(index) => {
                self.pending_executes.remove(index);
            }
            None if self.server_compat.untracked_executes => {}
            None => return self.violation(Self::protocol_error("received unmatched RAIL execute result")),
        }
        self.push_event(RailEvent::ExecuteResult(result))?;
        Ok(Vec::new())
    }

    fn violation(&mut self, error: PduError) -> PduResult<Vec<SvcMessage>> {
        if !self.server_compat.warn_instead_of_fail {
            return Err(error);
        }
        if self.events.len() < Self::MAX_EVENTS {
            self.events.push_back(RailEvent::ProtocolWarning {
                description: error.to_string(),
            });
        }
        Ok(Vec::new())
    }

    fn push_event(&mut self, event: RailEvent) -> PduResult<()> {
        if self.events.len() >= Self::MAX_EVENTS {
            return Err(Self::resource_limit_error("queued RAIL events"));
        }
        self.events.push_back(event);
        Ok(())
    }

    fn validate_queued_pdu(pdu: &QueuedRailPdu) -> PduResult<()> {
        let pdu = match pdu {
            QueuedRailPdu::Execute(execute) => RailPdu::Execute(execute.clone()),
            QueuedRailPdu::Input(event) => RailPdu::from(*event),
        };
        pdu.validate()
            .map_err(|error| PduError::encode("RAIL client request", error))
    }

    fn service_message(pdu: RailPdu) -> SvcMessage {
        SvcMessage::from(pdu).with_flags(ChannelFlags::SHOW_PROTOCOL)
    }

    fn protocol_error(description: &'static str) -> PduError {
        PduError::new("RAIL", PduErrorKind::Other { description })
    }

    fn resource_limit_error(description: &'static str) -> PduError {
        PduError::new("RAIL", PduErrorKind::Other { description })
    }
}

impl SvcClientProcessor for RailClient {}

impl AsAny for RailClient {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl SvcProcessor for RailClient {
    fn channel_name(&self) -> ChannelName {
        Self::CHANNEL_NAME
    }

    fn channel_options(&self) -> ChannelOptions {
        ChannelOptions::INITIALIZED | ChannelOptions::SHOW_PROTOCOL
    }

    fn process(&mut self, payload: &[u8]) -> PduResult<Vec<SvcMessage>> {
        let decoded = if self.server_compat.lenient_handshake_length {
            decode_server_pdu_lenient(payload)
        } else {
            decode::<RailPdu>(payload)
        };
        let pdu = match decoded {
            Ok(pdu) => pdu,
            Err(error) => return self.violation(decode_err!(error)),
        };
        if self.is_established() && !pdu.is_server_to_client() {
            return self.violation(Self::protocol_error("received client-originated RAIL PDU from server"));
        }

        match (self.state, pdu) {
            (RailState::WaitingForHandshake, RailPdu::Handshake(HandshakePdu { .. })) => self.finish_handshake(None),
            (RailState::WaitingForHandshake, RailPdu::HandshakeEx(HandshakeExPdu { flags, .. })) => {
                self.finish_handshake(Some(flags))
            }
            (RailState::WaitingForHandshake, _) => {
                self.violation(Self::protocol_error("received RAIL PDU before server handshake"))
            }
            (RailState::Established, RailPdu::Handshake(_)) => self.repeated_handshake(None),
            (RailState::Established, RailPdu::HandshakeEx(HandshakeExPdu { flags, .. })) => {
                self.repeated_handshake(Some(flags))
            }
            (RailState::Established, RailPdu::ExecuteResult(result)) => self.execute_result(result),
            (
                RailState::Established,
                RailPdu::GetApplicationIdResponse(GetApplicationIdResponsePdu {
                    window_id,
                    application_id,
                }),
            ) => {
                self.push_event(RailEvent::ApplicationId {
                    window_id,
                    application_id,
                    process_id: None,
                    process_image_name: None,
                })?;
                Ok(Vec::new())
            }
            (
                RailState::Established,
                RailPdu::GetApplicationIdResponseEx(GetApplicationIdResponseExPdu {
                    window_id,
                    application_id,
                    process_id,
                    process_image_name,
                }),
            ) => {
                self.push_event(RailEvent::ApplicationId {
                    window_id,
                    application_id,
                    process_id: Some(process_id),
                    process_image_name: Some(process_image_name),
                })?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::ServerSystemParameters(parameters)) => {
                self.push_event(RailEvent::Control(RailControlEvent::SystemParameters(parameters)))?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::LanguageBarInfo(info)) => {
                self.push_event(RailEvent::Control(RailControlEvent::LanguageBar(info)))?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::CompartmentInfo(info)) => {
                self.push_event(RailEvent::Control(RailControlEvent::Compartment(info)))?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::ZOrderSync(sync)) => {
                self.push_event(RailEvent::Control(RailControlEvent::ZOrderSync(sync)))?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::Cloak(cloak)) => {
                self.push_event(RailEvent::Control(RailControlEvent::Cloak(cloak)))?;
                Ok(Vec::new())
            }
            (RailState::Established, RailPdu::PowerDisplayRequest(request)) => {
                self.push_event(RailEvent::Control(RailControlEvent::PowerDisplayRequest(request)))?;
                Ok(Vec::new())
            }
            (RailState::Established, _) => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use ironrdp_core::{decode, encode_vec};
    use ironrdp_svc::SvcProcessor as _;

    use super::{RailClient, RailEvent, RailInputEvent, RailServerCompat};
    use crate::pdu::{
        ActivatePdu, ClientStatusPdu, ClientSystemParameter, ClientSystemParametersPdu, ExecutePdu, HandshakePdu,
        RailPdu, Rectangle, SystemParameterRectangle, WindowMovePdu,
    };

    const XRDP_HANDSHAKE: [u8; 8] = [0x05, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00];

    fn execute(executable: &str) -> ExecutePdu {
        ExecutePdu {
            flags: 0,
            executable: executable.to_owned(),
            working_directory: String::new(),
            arguments: String::new(),
        }
    }

    fn decode_all(messages: impl Into<Vec<ironrdp_svc::SvcMessage>>) -> Vec<RailPdu> {
        messages
            .into()
            .iter()
            .map(|message| decode::<RailPdu>(&message.encode_unframed_pdu().unwrap()).unwrap())
            .collect()
    }

    fn work_area(width: u16, height: u16) -> [RailPdu; 2] {
        let screen = SystemParameterRectangle {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        [
            RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::DisplayChange(screen),
            }),
            RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
                parameter: ClientSystemParameter::WorkArea(screen),
            }),
        ]
    }

    fn xrdp_client() -> RailClient {
        RailClient::new(7601, 1600, 900)
            .with_server_compat(RailServerCompat::XRDP)
            .with_client_status_flags(ClientStatusPdu::ALLOW_LOCAL_MOVE_SIZE)
    }

    fn established_xrdp_client() -> RailClient {
        let mut client = xrdp_client();
        client.initiate(execute("/usr/bin/true")).unwrap();
        client.process(&XRDP_HANDSHAKE).unwrap();
        client.take_events();
        client
    }

    #[test]
    fn queued_executes_do_not_exceed_pending_limit() {
        let mut client = RailClient::new(1, 1, 1);
        for _ in 0..RailClient::MAX_PENDING_EXECUTES {
            client.queue_execute(execute("app")).unwrap();
        }

        assert!(client.queue_execute(execute("app")).is_err());

        client
            .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
            .unwrap();
        let messages: Vec<_> = client.complete_desktop_synchronization().unwrap().into();

        assert_eq!(messages.len(), RailClient::MAX_PENDING_EXECUTES);
    }

    #[test]
    fn initiate_sends_handshake_status_and_execute_without_work_area() {
        let mut client = xrdp_client();

        assert_eq!(
            decode_all(client.initiate(execute("/usr/bin/true")).unwrap()),
            [
                RailPdu::Handshake(HandshakePdu { build_number: 7601 }),
                RailPdu::ClientStatus(ClientStatusPdu {
                    flags: ClientStatusPdu::ALLOW_LOCAL_MOVE_SIZE
                }),
                RailPdu::Execute(execute("/usr/bin/true")),
            ]
        );
        assert!(!client.is_established());
        assert!(client.initiate(execute("")).is_err());
    }

    #[test]
    fn resend_initiation_stops_after_handshake() {
        let mut client = xrdp_client();
        client.initiate(execute("/usr/bin/true")).unwrap();
        assert_eq!(decode_all(client.resend_initiation().unwrap()).len(), 3);

        client.process(&XRDP_HANDSHAKE).unwrap();

        assert!(client.is_established());
        assert!(decode_all(client.resend_initiation().unwrap()).is_empty());
        assert!(client.initiate(execute("/usr/bin/true")).is_err());
    }

    #[test]
    fn xrdp_handshake_establishes_in_xrdp_mode() {
        let mut client = xrdp_client();
        client.initiate(execute("/usr/bin/true")).unwrap();

        let reply = decode_all(client.process(&XRDP_HANDSHAKE).unwrap());

        assert_eq!(reply, work_area(1600, 900));
        assert!(client.is_established());
        assert_eq!(
            client.take_events(),
            [
                RailEvent::Handshake {
                    handshake_ex_flags: None,
                    initialization_message_count: 2,
                    queued_execute_count: 0,
                },
                RailEvent::PostHandshakeQueueReleased {
                    released_execute_count: 0
                },
            ]
        );
    }

    #[test]
    fn xrdp_handshake_fails_in_strict_mode() {
        let mut client = RailClient::new(7601, 1600, 900);
        client.initiate(execute("/usr/bin/true")).unwrap();

        assert!(client.process(&XRDP_HANDSHAKE).is_err());
        assert!(!client.is_established());
    }

    #[test]
    fn repeated_handshake_resends_work_area() {
        let mut client = established_xrdp_client();

        assert_eq!(
            decode_all(client.process(&XRDP_HANDSHAKE).unwrap()),
            work_area(1600, 900)
        );
        assert_eq!(
            client.take_events(),
            [RailEvent::ServerReinitialized {
                handshake_ex_flags: None
            }]
        );
        assert_eq!(decode_all(client.request_work_area()), work_area(1600, 900));
    }

    #[test]
    fn repeated_handshake_errs_in_strict_mode() {
        let mut client = RailClient::new(1, 1, 1);
        let handshake = encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap();
        client.process(&handshake).unwrap();

        assert!(client.process(&handshake).is_err());
    }

    #[test]
    fn garbage_becomes_a_warning_in_xrdp_mode() {
        let mut client = established_xrdp_client();

        assert!(client.process(&[0xFF, 0xFF, 0x04, 0x00]).unwrap().is_empty());
        assert!(
            client
                .process(&encode_vec(&RailPdu::Execute(execute("app"))).unwrap())
                .unwrap()
                .is_empty()
        );
        let events = client.take_events();
        assert_eq!(events.len(), 2);
        assert!(
            events
                .iter()
                .all(|event| matches!(event, RailEvent::ProtocolWarning { description } if !description.is_empty()))
        );
        assert!(client.is_established());

        let mut strict = RailClient::new(1, 1, 1);
        assert!(strict.process(&[0xFF, 0xFF, 0x04, 0x00]).is_err());
    }

    #[test]
    fn executes_are_untracked_in_xrdp_mode() {
        let mut client = established_xrdp_client();

        for _ in 0..(RailClient::MAX_PENDING_EXECUTES * 2) {
            assert_eq!(
                decode_all(
                    client
                        .queue_execute(execute("/usr/local/lib/aktraen/apps/wireshark"))
                        .unwrap()
                ),
                [RailPdu::Execute(execute("/usr/local/lib/aktraen/apps/wireshark"))]
            );
        }
        assert!(client.pending_executes.is_empty());
    }

    #[test]
    fn window_move_input_encodes() {
        let mut client = established_xrdp_client();
        let window_move = WindowMovePdu {
            window_id: 0x0140_0007,
            rectangle: Rectangle {
                left: 20,
                top: 30,
                right: 770,
                bottom: 580,
            },
        };

        let messages = client.queue_input(RailInputEvent::WindowMove(window_move)).unwrap();
        let encoded: Vec<_> = messages.into();
        let bytes = encoded[0].encode_unframed_pdu().unwrap();

        assert_eq!(
            bytes,
            [
                0x08, 0x00, 0x10, 0x00, 0x07, 0x00, 0x40, 0x01, 20, 0, 30, 0, 0x02, 0x03, 0x44, 0x02
            ]
        );
        assert_eq!(decode::<RailPdu>(&bytes).unwrap(), RailPdu::WindowMove(window_move));
    }

    #[test]
    fn queued_input_is_released_by_the_initiated_handshake() {
        let mut client = xrdp_client();
        client.initiate(execute("/usr/bin/true")).unwrap();
        let activate = ActivatePdu {
            window_id: 7,
            enabled: true,
        };
        assert!(decode_all(client.queue_input(RailInputEvent::Activate(activate)).unwrap()).is_empty());
        assert!(decode_all(client.queue_execute(execute("/usr/bin/xterm")).unwrap()).is_empty());

        let reply = decode_all(client.process(&XRDP_HANDSHAKE).unwrap());

        let mut expected = work_area(1600, 900).to_vec();
        expected.extend([RailPdu::Activate(activate), RailPdu::Execute(execute("/usr/bin/xterm"))]);
        assert_eq!(reply, expected);
        assert!(matches!(
            client.take_events().as_slice(),
            [
                RailEvent::Handshake {
                    queued_execute_count: 1,
                    ..
                },
                RailEvent::PostHandshakeQueueReleased {
                    released_execute_count: 1
                }
            ]
        ));
    }

    #[test]
    fn initiation_gives_up_after_max_attempts() {
        let mut client = xrdp_client().with_max_initiation_attempts(3);
        client.initiate(execute("/usr/bin/true")).unwrap();

        assert_eq!(decode_all(client.resend_initiation().unwrap()).len(), 3);
        assert_eq!(decode_all(client.resend_initiation().unwrap()).len(), 3);
        assert!(decode_all(client.resend_initiation().unwrap()).is_empty());
        assert!(decode_all(client.resend_initiation().unwrap()).is_empty());

        assert_eq!(client.take_events(), [RailEvent::InitiationExhausted { attempts: 3 }]);
    }
}
