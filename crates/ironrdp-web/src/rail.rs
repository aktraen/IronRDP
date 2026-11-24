//! RemoteApp (RAIL) sessions: drives the RAIL channel against xrdp, tracks its windows and
//! batches the graphics damage a host needs to repaint window crops.
//!
//! Everything here is opt-in: a session only gets a [`WebRail`] when the `remote_app`
//! extension is set, and damage is only batched when `graphics_region_callback` is set.

use core::cell::RefCell;
use std::rc::Rc;

use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::PduResult;
use ironrdp_pdu::window::WindowShowState;
use ironrdp_rail::client::{
    RailClient, RailEvent, RailInputEvent, RailRect, RailServerCompat, RailSvcMessages, RailWindow, RailWindowChanges,
    RailWindowEvent, RailWindowRole, RailWindowTracker,
};
use ironrdp_rail::pdu::{
    ActivatePdu, ClientStatusPdu, ExecutePdu, RailPdu, Rectangle, SystemCommand, SystemCommandPdu, WindowMovePdu,
};
use ironrdp_svc::SvcMessage;
use tracing::{debug, warn};

/// Client build number announced in the RAIL Handshake (Windows 7 SP1, as mstsc).
const RAIL_BUILD_NUMBER: u32 = 7601;
const DEFAULT_BOOTSTRAP_EXECUTABLE: &str = "/usr/bin/true";
const DEFAULT_MAX_INIT_ATTEMPTS: u32 = 24;
/// Above this many damaged rectangles in one loop, a single bounding box is reported instead.
const MAX_DAMAGE_RECTS: usize = 64;
/// Ticks (5 s each) to wait for re-announced windows before pruning the others.
const RESYNC_TICKS: u8 = 2;

/// RemoteApp settings from the `remote_app` builder extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteAppConfig {
    /// Sent in the Client Info PDU; xrdp starts the RemoteApp session from it.
    pub(crate) alternate_shell: String,
    pub(crate) work_dir: String,
    /// Executed once to wake xrdp's RAIL channel, which waits for a client Execute.
    pub(crate) bootstrap_executable: String,
    pub(crate) max_init_attempts: u32,
}

impl RemoteAppConfig {
    pub(crate) fn new(alternate_shell: String) -> Self {
        Self {
            alternate_shell,
            work_dir: String::new(),
            bootstrap_executable: DEFAULT_BOOTSTRAP_EXECUTABLE.to_owned(),
            max_init_attempts: DEFAULT_MAX_INIT_ATTEMPTS,
        }
    }

    /// Creates the RAIL channel processor for an xrdp RemoteApp session.
    pub(crate) fn rail_client(&self, desktop_width: u16, desktop_height: u16) -> RailClient {
        RailClient::new(RAIL_BUILD_NUMBER, desktop_width, desktop_height)
            .with_server_compat(RailServerCompat::XRDP)
            .with_client_status_flags(ClientStatusPdu::ALLOW_LOCAL_MOVE_SIZE)
            .with_max_initiation_attempts(self.max_init_attempts)
    }

    fn bootstrap(&self) -> ExecutePdu {
        ExecutePdu {
            flags: 0,
            executable: self.bootstrap_executable.clone(),
            working_directory: String::new(),
            arguments: String::new(),
        }
    }
}

/// Lifecycle of the RAIL channel as reported to the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RailPhase {
    /// Waiting for the server Handshake; the initiation is resent every tick.
    Initiating,
    Established,
    /// The server restarted its RAIL state; windows it does not re-announce are pruned.
    Resyncing,
    /// No Handshake after the configured number of attempts.
    Exhausted,
}

impl RailPhase {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Initiating => "initiating",
            Self::Established => "established",
            Self::Resyncing => "resyncing",
            Self::Exhausted => "exhausted",
        }
    }
}

/// The state reported through `rail_state_callback` and `rail_state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RailStateSnapshot {
    pub(crate) phase: RailPhase,
    pub(crate) attempt: u32,
    pub(crate) desktop_width: u16,
    pub(crate) desktop_height: u16,
    pub(crate) warning: Option<String>,
}

/// A RAIL operation requested by the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RailOp {
    Execute(ExecutePdu),
    Activate { window_id: u32, enabled: bool },
    SysCommand { window_id: u32, command: SystemCommand },
    WindowMove(WindowMovePdu),
    SetWorkArea { width: u16, height: u16 },
    Resync,
}

impl RailOp {
    pub(crate) fn execute(executable: String, working_directory: String, arguments: String) -> Result<Self, String> {
        let execute = ExecutePdu {
            flags: 0,
            executable,
            working_directory,
            arguments,
        };
        RailPdu::Execute(execute.clone())
            .validate()
            .map_err(|error| format!("invalid RAIL execute: {error}"))?;
        Ok(Self::Execute(execute))
    }

    pub(crate) fn sys_command(window_id: u32, command: &str) -> Result<Self, String> {
        let command = match command {
            "close" => SystemCommand::Close,
            "minimize" => SystemCommand::Minimize,
            "maximize" => SystemCommand::Maximize,
            "restore" => SystemCommand::Restore,
            "move" => SystemCommand::Move,
            "size" => SystemCommand::Size,
            "keymenu" => SystemCommand::KeyMenu,
            "default" => SystemCommand::Default,
            other => return Err(format!("unknown RAIL system command `{other}`")),
        };
        Ok(Self::SysCommand { window_id, command })
    }

    /// A window move to `left, top` with the given size, in desktop coordinates.
    pub(crate) fn window_move(window_id: u32, left: i32, top: i32, width: u32, height: u32) -> Result<Self, String> {
        let coordinate = |value: i64| {
            i16::try_from(value).map_err(|_| format!("RAIL window move out of range for window {window_id:#x}"))
        };
        let rectangle = Rectangle {
            left: coordinate(i64::from(left))?,
            top: coordinate(i64::from(top))?,
            right: coordinate(i64::from(left) + i64::from(width))?,
            bottom: coordinate(i64::from(top) + i64::from(height))?,
        };
        Ok(Self::WindowMove(WindowMovePdu { window_id, rectangle }))
    }

    pub(crate) fn set_work_area(width: u32, height: u32) -> Result<Self, String> {
        match (u16::try_from(width), u16::try_from(height)) {
            (Ok(width), Ok(height)) if width > 0 && height > 0 => Ok(Self::SetWorkArea { width, height }),
            _ => Err(format!("invalid RAIL work area {width}x{height}")),
        }
    }
}

/// A damaged area of the desktop image; `right` and `bottom` are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GraphicsRegion {
    pub(crate) left: u32,
    pub(crate) top: u32,
    pub(crate) right: u32,
    pub(crate) bottom: u32,
}

impl GraphicsRegion {
    fn from_inclusive(region: &InclusiveRectangle) -> Self {
        Self {
            left: u32::from(region.left),
            top: u32::from(region.top),
            right: u32::from(region.right) + 1,
            bottom: u32::from(region.bottom) + 1,
        }
    }

    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }
}

/// Graphics damage collected during one session loop iteration.
#[derive(Debug, Default)]
pub(crate) struct DamageBatch {
    rects: Vec<GraphicsRegion>,
    bounds: Option<GraphicsRegion>,
}

impl DamageBatch {
    pub(crate) fn push(&mut self, region: &InclusiveRectangle) {
        let region = GraphicsRegion::from_inclusive(region);
        self.bounds = Some(self.bounds.map_or(region, |bounds| bounds.union(region)));
        if self.rects.len() <= MAX_DAMAGE_RECTS {
            self.rects.push(region);
        }
    }

    /// Returns the batched regions (at most 64, else their bounding box) and starts a new batch.
    pub(crate) fn take(&mut self) -> Vec<GraphicsRegion> {
        let bounds = self.bounds.take();
        let rects = core::mem::take(&mut self.rects);
        if rects.len() > MAX_DAMAGE_RECTS {
            bounds.into_iter().collect()
        } else {
            rects
        }
    }
}

/// Where [`WebRail`] reports window and state changes.
pub(crate) trait RailSink {
    fn window_event(&self, event: &RailWindowEvent);
    fn state(&self, state: &RailStateSnapshot);
}

/// The latest RAIL state and windows, read synchronously by the `rail_state` extension.
#[derive(Debug, Default)]
pub(crate) struct RailShared {
    pub(crate) state: Option<RailStateSnapshot>,
    pub(crate) windows: Vec<RailWindow>,
}

/// Drives the RAIL channel of a RemoteApp session from the session loop.
pub(crate) struct WebRail<S> {
    config: RemoteAppConfig,
    sink: S,
    shared: Rc<RefCell<RailShared>>,
    tracker: RailWindowTracker,
    phase: RailPhase,
    attempt: u32,
    desktop_width: u16,
    desktop_height: u16,
    resync_ticks: Option<u8>,
}

impl<S: RailSink> WebRail<S> {
    pub(crate) fn new(
        config: RemoteAppConfig,
        sink: S,
        shared: Rc<RefCell<RailShared>>,
        desktop_width: u16,
        desktop_height: u16,
    ) -> Self {
        Self {
            config,
            sink,
            shared,
            tracker: RailWindowTracker::new(),
            phase: RailPhase::Initiating,
            attempt: 0,
            desktop_width,
            desktop_height,
            resync_ticks: None,
        }
    }

    /// Sends the first initiation bundle.
    pub(crate) fn start(&mut self, client: &mut RailClient) -> PduResult<RailSvcMessages> {
        let pending: Vec<SvcMessage> = client
            .update_desktop_size(self.desktop_width, self.desktop_height)
            .into();
        debug_assert!(pending.is_empty(), "the work area is only sent once established");
        let messages = client.initiate(self.config.bootstrap())?;
        self.attempt = 1;
        self.set_phase(RailPhase::Initiating);
        Ok(messages)
    }

    /// Runs on the session's 5-second timer: resends the initiation and ends a resync.
    pub(crate) fn on_tick(&mut self, client: &mut RailClient) -> PduResult<RailSvcMessages> {
        match self.phase {
            RailPhase::Initiating => {
                let messages = client.resend_initiation()?;
                let messages: Vec<SvcMessage> = messages.into();
                if !messages.is_empty() {
                    self.attempt = self.attempt.saturating_add(1);
                    self.publish_state(None);
                }
                self.drain_channel_events(client);
                Ok(messages.into())
            }
            RailPhase::Resyncing => {
                let ticks = self.resync_ticks.unwrap_or_default().saturating_add(1);
                if ticks >= RESYNC_TICKS {
                    self.finish_resync();
                } else {
                    self.resync_ticks = Some(ticks);
                }
                Ok(Vec::new().into())
            }
            RailPhase::Established | RailPhase::Exhausted => Ok(Vec::new().into()),
        }
    }

    /// Applies the events the RAIL channel accumulated while processing server PDUs.
    pub(crate) fn drain_channel_events(&mut self, client: &mut RailClient) {
        for event in client.take_events() {
            match event {
                RailEvent::Handshake { handshake_ex_flags, .. } => {
                    debug!(?handshake_ex_flags, attempt = self.attempt, "RAIL established");
                    self.set_phase(RailPhase::Established);
                }
                RailEvent::ServerReinitialized { .. } => self.begin_resync(),
                RailEvent::InitiationExhausted { attempts } => {
                    warn!(attempts, "RAIL server never answered");
                    self.set_phase(RailPhase::Exhausted);
                }
                RailEvent::ProtocolWarning { description } => {
                    warn!(%description, "Ignored RAIL protocol violation");
                    self.publish_state(Some(description));
                }
                RailEvent::DesktopSynchronized { .. }
                | RailEvent::PostHandshakeQueueReleased { .. }
                | RailEvent::ExecuteResult(_)
                | RailEvent::ApplicationId { .. }
                | RailEvent::Control(_) => debug!(?event, "RAIL event"),
            }
        }
    }

    /// Applies a forwarded windowing orders update to the window set.
    pub(crate) fn on_windowing_orders(&mut self, forwarded: &[u8]) {
        let decode_errors = self.tracker.decode_errors();
        let events = self.tracker.apply_update(forwarded);
        if self.tracker.decode_errors() != decode_errors {
            warn!(
                decode_errors = self.tracker.decode_errors(),
                "Ignored undecodable windowing orders"
            );
        }
        self.publish_windows(&events);
    }

    pub(crate) fn on_op(&mut self, client: &mut RailClient, op: RailOp) -> PduResult<RailSvcMessages> {
        match op {
            RailOp::Execute(execute) => client.queue_execute(execute),
            RailOp::Activate { window_id, enabled } => {
                client.queue_input(RailInputEvent::Activate(ActivatePdu { window_id, enabled }))
            }
            RailOp::SysCommand { window_id, command } => {
                client.queue_input(RailInputEvent::SystemCommand(SystemCommandPdu { window_id, command }))
            }
            RailOp::WindowMove(window_move) => client.queue_input(RailInputEvent::WindowMove(window_move)),
            RailOp::SetWorkArea { width, height } => Ok(self.on_desktop_resized(client, width, height)),
            RailOp::Resync => {
                if !client.is_established() {
                    return Ok(Vec::new().into());
                }
                self.begin_resync();
                Ok(client.request_work_area())
            }
        }
    }

    /// Sends the new work area after the desktop size changed; the server re-announces its windows.
    pub(crate) fn on_desktop_resized(&mut self, client: &mut RailClient, width: u16, height: u16) -> RailSvcMessages {
        self.desktop_width = width;
        self.desktop_height = height;
        self.publish_state(None);
        client.update_desktop_size(width, height)
    }

    #[cfg(test)]
    pub(crate) fn phase(&self) -> RailPhase {
        self.phase
    }

    fn begin_resync(&mut self) {
        self.tracker.begin_resync();
        self.resync_ticks = Some(0);
        self.set_phase(RailPhase::Resyncing);
    }

    fn finish_resync(&mut self) {
        let events = self.tracker.end_resync();
        self.resync_ticks = None;
        self.publish_windows(&events);
        self.set_phase(RailPhase::Established);
    }

    fn set_phase(&mut self, phase: RailPhase) {
        self.phase = phase;
        self.publish_state(None);
    }

    fn publish_state(&mut self, warning: Option<String>) {
        let state = RailStateSnapshot {
            phase: self.phase,
            attempt: self.attempt,
            desktop_width: self.desktop_width,
            desktop_height: self.desktop_height,
            warning,
        };
        self.sink.state(&state);
        self.shared.borrow_mut().state = Some(state);
    }

    fn publish_windows(&mut self, events: &[RailWindowEvent]) {
        if events.is_empty() {
            return;
        }
        for event in events {
            self.sink.window_event(event);
        }
        self.shared.borrow_mut().windows = self.tracker.windows().cloned().collect();
    }
}

const fn role_str(role: RailWindowRole) -> &'static str {
    match role {
        RailWindowRole::App => "app",
        RailWindowRole::Dialog => "dialog",
        RailWindowRole::Popup => "popup",
    }
}

const fn show_state_str(show_state: WindowShowState) -> &'static str {
    match show_state {
        WindowShowState::Hidden => "hidden",
        WindowShowState::Minimized => "minimized",
        WindowShowState::Maximized => "maximized",
        WindowShowState::Shown => "shown",
    }
}

fn changed_names(changes: RailWindowChanges) -> Vec<&'static str> {
    [
        (changes.title, "title"),
        (changes.geometry, "geometry"),
        (changes.visibility, "visibility"),
        (changes.show_state, "showState"),
        (changes.style, "style"),
        (changes.owner, "owner"),
    ]
    .into_iter()
    .filter_map(|(changed, name)| changed.then_some(name))
    .collect()
}

/// JavaScript views of the RAIL types, matching `iron-remote-desktop-rdp`'s `rail.ts`.
pub(crate) mod js {
    use js_sys::{Array, Function, Object, Reflect};
    use tracing::error;
    use wasm_bindgen::{JsCast as _, JsValue};

    use super::{
        GraphicsRegion, RailRect, RailShared, RailSink, RailStateSnapshot, RailWindow, RailWindowEvent, changed_names,
        role_str, show_state_str,
    };

    fn set(object: &Object, key: &str, value: &JsValue) {
        if let Err(error) = Reflect::set(object, &JsValue::from_str(key), value) {
            error!(?error, key, "Failed to set a property");
        }
    }

    fn number(value: impl Into<f64>) -> JsValue {
        JsValue::from_f64(value.into())
    }

    fn rect(rect: &RailRect) -> JsValue {
        let object = Object::new();
        set(&object, "left", &number(rect.left));
        set(&object, "top", &number(rect.top));
        set(&object, "width", &number(rect.width));
        set(&object, "height", &number(rect.height));
        object.into()
    }

    fn rects(rects: &[RailRect]) -> JsValue {
        rects.iter().map(rect).collect::<Array>().into()
    }

    pub(crate) fn window(window: &RailWindow) -> JsValue {
        let object = Object::new();
        set(&object, "id", &number(window.id));
        set(&object, "ownerId", &window.owner.map_or(JsValue::NULL, number));
        set(&object, "role", &JsValue::from_str(role_str(window.role)));
        set(
            &object,
            "showState",
            &JsValue::from_str(show_state_str(window.show_state)),
        );
        set(&object, "title", &JsValue::from_str(&window.title));
        set(&object, "style", &number(window.style));
        set(&object, "extendedStyle", &number(window.extended_style));
        set(&object, "rect", &rect(&window.window_rect));
        set(
            &object,
            "clientRect",
            &window.client_rect.as_ref().map_or(JsValue::NULL, rect),
        );
        set(&object, "windowRects", &rects(&window.window_rects));
        set(&object, "visibilityRects", &rects(&window.visibility_rects));
        object.into()
    }

    pub(crate) fn window_event(event: &RailWindowEvent) -> JsValue {
        let object = Object::new();
        match event {
            RailWindowEvent::Created(created) => {
                set(&object, "kind", &JsValue::from_str("created"));
                set(&object, "id", &number(created.id));
                set(&object, "window", &window(created));
            }
            RailWindowEvent::Updated {
                window: updated,
                changes,
                reannounced,
            } => {
                set(&object, "kind", &JsValue::from_str("updated"));
                set(&object, "id", &number(updated.id));
                set(&object, "window", &window(updated));
                let changed = changed_names(*changes)
                    .into_iter()
                    .map(JsValue::from_str)
                    .collect::<Array>();
                set(&object, "changed", &changed.into());
                set(&object, "reannounced", &JsValue::from_bool(*reannounced));
            }
            RailWindowEvent::Deleted { id } => {
                set(&object, "kind", &JsValue::from_str("deleted"));
                set(&object, "id", &number(*id));
            }
        }
        object.into()
    }

    pub(crate) fn state_object(state: &RailStateSnapshot) -> Object {
        let object = Object::new();
        set(&object, "state", &JsValue::from_str(state.phase.as_str()));
        set(&object, "attempt", &number(state.attempt));
        set(&object, "desktopWidth", &number(state.desktop_width));
        set(&object, "desktopHeight", &number(state.desktop_height));
        if let Some(warning) = &state.warning {
            set(&object, "warning", &JsValue::from_str(warning));
        }
        object
    }

    pub(crate) fn shared(shared: &RailShared) -> JsValue {
        let object = shared.state.as_ref().map_or_else(Object::new, state_object);
        let windows = shared.windows.iter().map(window).collect::<Array>();
        set(&object, "windows", &windows.into());
        object.into()
    }

    pub(crate) fn regions(regions: &[GraphicsRegion]) -> JsValue {
        regions
            .iter()
            .map(|region| {
                let object = Object::new();
                set(&object, "left", &number(region.left));
                set(&object, "top", &number(region.top));
                set(&object, "right", &number(region.right));
                set(&object, "bottom", &number(region.bottom));
                JsValue::from(object)
            })
            .collect::<Array>()
            .into()
    }

    /// Calls `callback(argument)` in a microtask, after the session loop releases its borrows.
    pub(crate) fn defer_call(callback: &Function, argument: JsValue) {
        let callback = callback.clone();
        let deferred = wasm_bindgen::closure::Closure::once_into_js(move || {
            if let Err(error) = callback.call1(&JsValue::NULL, &argument) {
                error!(?error, "RAIL callback failed");
            }
        });
        crate::session::queue_microtask(deferred.unchecked_ref());
    }

    /// Reports RAIL changes to the `rail_window_callback` and `rail_state_callback` functions.
    pub(crate) struct JsRailSink {
        pub(crate) window_callback: Option<Function>,
        pub(crate) state_callback: Option<Function>,
    }

    impl RailSink for JsRailSink {
        fn window_event(&self, event: &RailWindowEvent) {
            if let Some(callback) = &self.window_callback {
                defer_call(callback, window_event(event));
            }
        }

        fn state(&self, state: &RailStateSnapshot) {
            if let Some(callback) = &self.state_callback {
                defer_call(callback, state_object(state).into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use core::cell::RefCell;
    use std::rc::Rc;

    use ironrdp::pdu::geometry::InclusiveRectangle;
    use ironrdp_core::decode;
    use ironrdp_pdu::window::{
        DecodedWindowingOrder, WindowExtent, WindowInfoOrder, WindowPoint, WindowRectangle, WindowShowState,
        WindowStyles, encode_forwarded_windowing_orders,
    };
    use ironrdp_rail::client::{RailClient, RailWindowEvent};
    use ironrdp_rail::pdu::{RailPdu, SystemCommand};
    use ironrdp_svc::{SvcMessage, SvcProcessor as _};

    use super::{
        DamageBatch, GraphicsRegion, RailOp, RailPhase, RailShared, RailSink, RailStateSnapshot, RemoteAppConfig,
        WebRail,
    };

    const XRDP_HANDSHAKE: [u8; 8] = [0x05, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00];

    #[derive(Default)]
    struct RecordingSink {
        windows: RefCell<Vec<RailWindowEvent>>,
        states: RefCell<Vec<RailStateSnapshot>>,
    }

    impl RailSink for Rc<RecordingSink> {
        fn window_event(&self, event: &RailWindowEvent) {
            self.windows.borrow_mut().push(event.clone());
        }

        fn state(&self, state: &RailStateSnapshot) {
            self.states.borrow_mut().push(state.clone());
        }
    }

    struct Harness {
        rail: WebRail<Rc<RecordingSink>>,
        client: RailClient,
        sink: Rc<RecordingSink>,
        shared: Rc<RefCell<RailShared>>,
    }

    fn harness(max_init_attempts: u32) -> Harness {
        let mut config = RemoteAppConfig::new("aktraen-rail".to_owned());
        config.max_init_attempts = max_init_attempts;
        let sink = Rc::new(RecordingSink::default());
        let shared = Rc::new(RefCell::new(RailShared::default()));
        Harness {
            client: config.rail_client(1600, 900),
            rail: WebRail::new(config, Rc::clone(&sink), Rc::clone(&shared), 1600, 900),
            sink,
            shared,
        }
    }

    fn sent(messages: impl Into<Vec<SvcMessage>>) -> Vec<RailPdu> {
        messages
            .into()
            .iter()
            .map(|message| decode::<RailPdu>(&message.encode_unframed_pdu().unwrap()).unwrap())
            .collect()
    }

    fn established() -> Harness {
        let mut harness = harness(24);
        harness.rail.start(&mut harness.client).unwrap();
        harness.client.process(&XRDP_HANDSHAKE).unwrap();
        harness.rail.drain_channel_events(&mut harness.client);
        harness
    }

    fn app_window(id: u32) -> Vec<u8> {
        let rect = vec![WindowRectangle {
            left: 0,
            top: 0,
            right: 640,
            bottom: 480,
        }];
        encode_forwarded_windowing_orders(&[DecodedWindowingOrder::Window(WindowInfoOrder {
            window_id: id,
            is_new: true,
            owner_window_id: Some(0x221),
            styles: Some(WindowStyles {
                style: 0x00CF_0000,
                extended_style: 0x0004_0000,
            }),
            show_state: Some(WindowShowState::Shown),
            title: Some(format!("window {id}")),
            root_parent: Some(0x221),
            window_offset: Some(WindowPoint { x: 10, y: 10 }),
            window_size: Some(WindowExtent {
                width: 640,
                height: 480,
            }),
            window_rects: Some(rect.clone()),
            visible_offset: Some(WindowPoint { x: 10, y: 10 }),
            visibility_rects: Some(rect),
            ..WindowInfoOrder::default()
        })])
        .unwrap()
    }

    fn inclusive(left: u16, top: u16, right: u16, bottom: u16) -> InclusiveRectangle {
        InclusiveRectangle {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn damage_regions_are_exclusive_and_reset_per_batch() {
        let mut batch = DamageBatch::default();
        batch.push(&inclusive(0, 0, 9, 19));
        batch.push(&inclusive(100, 50, 100, 50));

        assert_eq!(
            batch.take(),
            [
                GraphicsRegion {
                    left: 0,
                    top: 0,
                    right: 10,
                    bottom: 20
                },
                GraphicsRegion {
                    left: 100,
                    top: 50,
                    right: 101,
                    bottom: 51
                },
            ]
        );
        assert!(batch.take().is_empty());
    }

    #[test]
    fn damage_beyond_64_rects_collapses_to_the_bounding_box() {
        let mut batch = DamageBatch::default();
        for index in 0..64u16 {
            batch.push(&inclusive(index, index, index, index));
        }
        assert_eq!(batch.take().len(), 64);

        for index in 0..65u16 {
            batch.push(&inclusive(10 + index, 5, 10 + index, 7 + index));
        }
        assert_eq!(
            batch.take(),
            [GraphicsRegion {
                left: 10,
                top: 5,
                right: 75,
                bottom: 72
            }]
        );
    }

    #[test]
    fn rail_ops_validate_their_arguments() {
        assert!(
            RailOp::execute(
                "/usr/local/lib/aktraen/apps/wireshark".to_owned(),
                String::new(),
                String::new()
            )
            .is_ok()
        );
        assert!(RailOp::execute(String::new(), String::new(), String::new()).is_err());
        assert_eq!(
            RailOp::sys_command(7, "close").unwrap(),
            RailOp::SysCommand {
                window_id: 7,
                command: SystemCommand::Close
            }
        );
        assert!(RailOp::sys_command(7, "explode").is_err());
        assert!(RailOp::window_move(7, -20, 30, 800, 600).is_ok());
        assert!(RailOp::window_move(7, 32_000, 0, 800, 600).is_err());
        assert!(RailOp::window_move(7, i32::MIN, 0, 1, 1).is_err());
        assert!(RailOp::set_work_area(1280, 720).is_ok());
        assert!(RailOp::set_work_area(0, 720).is_err());
        assert!(RailOp::set_work_area(70_000, 720).is_err());
    }

    #[test]
    fn start_initiates_and_ticks_resend_until_established() {
        let mut harness = harness(24);

        assert_eq!(sent(harness.rail.start(&mut harness.client).unwrap()).len(), 3);
        assert_eq!(sent(harness.rail.on_tick(&mut harness.client).unwrap()).len(), 3);
        assert_eq!(harness.sink.states.borrow().last().unwrap().attempt, 2);

        harness.client.process(&XRDP_HANDSHAKE).unwrap();
        harness.rail.drain_channel_events(&mut harness.client);

        assert_eq!(harness.rail.phase(), RailPhase::Established);
        assert!(sent(harness.rail.on_tick(&mut harness.client).unwrap()).is_empty());
        let shared = harness.shared.borrow();
        assert_eq!(shared.state.as_ref().unwrap().phase, RailPhase::Established);
        assert_eq!(shared.state.as_ref().unwrap().desktop_width, 1600);
    }

    #[test]
    fn exhausted_initiation_is_reported() {
        let mut harness = harness(2);
        harness.rail.start(&mut harness.client).unwrap();
        harness.rail.on_tick(&mut harness.client).unwrap();
        harness.rail.on_tick(&mut harness.client).unwrap();

        assert_eq!(harness.rail.phase(), RailPhase::Exhausted);
        assert_eq!(
            harness
                .sink
                .states
                .borrow()
                .iter()
                .map(|state| state.phase)
                .collect::<Vec<_>>(),
            [RailPhase::Initiating, RailPhase::Initiating, RailPhase::Exhausted]
        );
    }

    #[test]
    fn windows_are_tracked_and_pruned_after_a_server_restart() {
        let mut harness = established();
        harness.rail.on_windowing_orders(&app_window(7));
        harness.rail.on_windowing_orders(&app_window(8));
        assert_eq!(harness.shared.borrow().windows.len(), 2);

        harness.client.process(&XRDP_HANDSHAKE).unwrap();
        harness.rail.drain_channel_events(&mut harness.client);
        assert_eq!(harness.rail.phase(), RailPhase::Resyncing);
        harness.rail.on_windowing_orders(&app_window(7));
        harness.rail.on_tick(&mut harness.client).unwrap();
        assert_eq!(harness.shared.borrow().windows.len(), 2);
        harness.rail.on_tick(&mut harness.client).unwrap();

        assert_eq!(harness.rail.phase(), RailPhase::Established);
        assert_eq!(
            harness.shared.borrow().windows.iter().map(|w| w.id).collect::<Vec<_>>(),
            [7]
        );
        let windows = harness.sink.windows.borrow();
        assert!(matches!(windows[0], RailWindowEvent::Created(_)));
        assert!(matches!(windows[2], RailWindowEvent::Updated { reannounced: true, .. }));
        assert_eq!(windows[3], RailWindowEvent::Deleted { id: 8 });
    }

    #[test]
    fn ops_are_sent_on_the_rail_channel() {
        let mut harness = established();
        let execute = RailOp::execute("/usr/bin/xterm".to_owned(), String::new(), String::new()).unwrap();

        assert!(matches!(
            sent(harness.rail.on_op(&mut harness.client, execute).unwrap()).as_slice(),
            [RailPdu::Execute(_)]
        ));
        let activate = RailOp::Activate {
            window_id: 7,
            enabled: true,
        };
        assert!(matches!(
            sent(harness.rail.on_op(&mut harness.client, activate).unwrap()).as_slice(),
            [RailPdu::Activate(_)]
        ));
        let window_move = RailOp::window_move(7, 0, 0, 100, 100).unwrap();
        assert!(matches!(
            sent(harness.rail.on_op(&mut harness.client, window_move).unwrap()).as_slice(),
            [RailPdu::WindowMove(_)]
        ));
        assert_eq!(
            sent(harness.rail.on_op(&mut harness.client, RailOp::Resync).unwrap()).len(),
            2
        );
        assert_eq!(harness.rail.phase(), RailPhase::Resyncing);
        let work_area = RailOp::set_work_area(1280, 720).unwrap();
        assert_eq!(
            sent(harness.rail.on_op(&mut harness.client, work_area).unwrap()).len(),
            2
        );
        assert_eq!(harness.shared.borrow().state.as_ref().unwrap().desktop_width, 1280);
    }
}
