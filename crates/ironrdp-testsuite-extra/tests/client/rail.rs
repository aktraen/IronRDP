use ironrdp_client::rail::{RailClient, RailEvent, RailInputEvent};
use ironrdp_core::{decode, encode_vec};
use ironrdp_rail::client::RailServerCompat;
use ironrdp_rail::pdu::{
    ClientStatusPdu, ClientSystemParameter, ClientSystemParametersPdu, ExecutePdu, HandshakePdu, RailPdu,
    SystemCommand, SystemCommandPdu, SystemParameterRectangle,
};
use ironrdp_svc::{SvcMessage, SvcProcessor as _};

#[test]
fn queued_execute_is_released_after_handshake_fallback() {
    let mut client = RailClient::new(1, 1024, 768);
    client
        .queue_execute(ExecutePdu {
            flags: 0,
            executable: "app".to_owned(),
            working_directory: String::new(),
            arguments: String::new(),
        })
        .unwrap();
    client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    let messages: Vec<_> = client.release_queued_after_handshake().unwrap().into();
    assert_eq!(messages.len(), 1);
    assert!(matches!(
        decode::<RailPdu>(&messages[0].encode_unframed_pdu().unwrap()).unwrap(),
        RailPdu::Execute(_)
    ));
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
fn server_cannot_send_client_input() {
    let mut client = RailClient::new(1, 1, 1);
    client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    assert!(
        client
            .process(
                &encode_vec(&RailPdu::Execute(ExecutePdu {
                    flags: 0,
                    executable: "app".to_owned(),
                    working_directory: String::new(),
                    arguments: String::new(),
                }))
                .unwrap()
            )
            .is_err()
    );
}

#[test]
fn handshake_advertises_supported_server_controls() {
    let mut client = RailClient::new(1, 1, 1);
    let messages = client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    assert!(matches!(
            decode::<RailPdu>(&messages[1].encode_unframed_pdu().unwrap()).unwrap(),
            RailPdu::ClientStatus(ClientStatusPdu { flags })
                if flags
                    == ClientStatusPdu::Z_ORDER_SYNC
                        | ClientStatusPdu::POWER_DISPLAY_REQUEST
                        | ClientStatusPdu::BIDIRECTIONAL_CLOAK
    ));
}

#[test]
fn handshake_advertises_configured_client_status_flags() {
    let mut client = RailClient::new(1, 1, 1).with_client_status_flags(0);
    let messages = client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    assert!(matches!(
        decode::<RailPdu>(&messages[1].encode_unframed_pdu().unwrap()).unwrap(),
        RailPdu::ClientStatus(ClientStatusPdu { flags: 0 })
    ));
}

#[test]
fn desktop_synchronization_releases_queued_execute() {
    let mut client = RailClient::new(1, 1, 1);
    client
        .queue_execute(ExecutePdu {
            flags: 0,
            executable: "app".to_owned(),
            working_directory: String::new(),
            arguments: String::new(),
        })
        .unwrap();
    client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    let messages: Vec<_> = client.complete_desktop_synchronization().unwrap().into();

    assert!(matches!(
        decode::<RailPdu>(&messages[0].encode_unframed_pdu().unwrap()).unwrap(),
        RailPdu::Execute(_)
    ));
    assert!(matches!(
        client.take_events().as_slice(),
        [
            RailEvent::Handshake { .. },
            RailEvent::DesktopSynchronized {
                released_execute_count: 1
            }
        ]
    ));
}

#[test]
fn desktop_size_update_sends_display_change_and_work_area() {
    let mut client = RailClient::new(1, 1, 1);
    client
        .process(&encode_vec(&RailPdu::Handshake(HandshakePdu { build_number: 1 })).unwrap())
        .unwrap();

    let messages: Vec<_> = client.update_desktop_size(1024, 768).into();

    assert!(matches!(
        decode::<RailPdu>(&messages[0].encode_unframed_pdu().unwrap()).unwrap(),
        RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
            parameter: ClientSystemParameter::DisplayChange(SystemParameterRectangle {
                right: 1024,
                bottom: 768,
                ..
            })
        })
    ));
    assert!(matches!(
        decode::<RailPdu>(&messages[1].encode_unframed_pdu().unwrap()).unwrap(),
        RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
            parameter: ClientSystemParameter::WorkArea(SystemParameterRectangle {
                right: 1024,
                bottom: 768,
                ..
            })
        })
    ));
}

fn sent(messages: impl Into<Vec<SvcMessage>>) -> Vec<RailPdu> {
    messages
        .into()
        .iter()
        .map(|message| decode::<RailPdu>(&message.encode_unframed_pdu().unwrap()).unwrap())
        .collect()
}

fn launch(executable: &str) -> ExecutePdu {
    ExecutePdu {
        flags: 0,
        executable: executable.to_owned(),
        working_directory: String::new(),
        arguments: String::new(),
    }
}

fn work_area(width: u16, height: u16) -> Vec<RailPdu> {
    let screen = SystemParameterRectangle {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };
    vec![
        RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
            parameter: ClientSystemParameter::DisplayChange(screen),
        }),
        RailPdu::ClientSystemParameters(ClientSystemParametersPdu {
            parameter: ClientSystemParameter::WorkArea(screen),
        }),
    ]
}

#[test]
fn xrdp_compat_full_launch_sequence() {
    const XRDP_HANDSHAKE: [u8; 8] = [0x05, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00];

    let mut client = RailClient::new(7601, 1600, 900)
        .with_server_compat(RailServerCompat::XRDP)
        .with_client_status_flags(ClientStatusPdu::ALLOW_LOCAL_MOVE_SIZE);

    // xrdp stays silent until a client Execute reaches it, so the client starts and retries.
    let bootstrap = sent(client.initiate(launch("/usr/bin/true")).unwrap());
    assert_eq!(bootstrap.len(), 3);
    assert!(matches!(bootstrap[2], RailPdu::Execute(_)));
    assert_eq!(sent(client.resend_initiation().unwrap()), bootstrap);
    assert!(
        sent(
            client
                .queue_execute(launch("/usr/local/lib/aktraen/apps/wireshark"))
                .unwrap()
        )
        .is_empty()
    );

    // The bootstrap Execute runs rail_startup, which sends a Handshake with a body-only length.
    let mut expected = work_area(1600, 900);
    expected.push(RailPdu::Execute(launch("/usr/local/lib/aktraen/apps/wireshark")));
    assert_eq!(sent(client.process(&XRDP_HANDSHAKE).unwrap()), expected);
    assert!(sent(client.resend_initiation().unwrap()).is_empty());

    // That Execute runs rail_startup again; the work area makes xrdp restore its mapped windows.
    assert_eq!(sent(client.process(&XRDP_HANDSHAKE).unwrap()), work_area(1600, 900));

    // No Execute Result ever arrives, so launches never pile up.
    for _ in 0..100 {
        assert_eq!(sent(client.queue_execute(launch("/usr/bin/xterm")).unwrap()).len(), 1);
    }

    let close = RailInputEvent::SystemCommand(SystemCommandPdu {
        window_id: 0x0140_0007,
        command: SystemCommand::Close,
    });
    assert_eq!(sent(client.queue_input(close).unwrap()), [RailPdu::from(close)]);

    assert!(client.process(&[0x7F, 0x00, 0x04, 0x00]).unwrap().is_empty());
    assert_eq!(sent(client.update_desktop_size(1280, 720)), work_area(1280, 720));

    assert!(matches!(
        client.take_events().as_slice(),
        [
            RailEvent::Handshake {
                queued_execute_count: 1,
                ..
            },
            RailEvent::PostHandshakeQueueReleased {
                released_execute_count: 1
            },
            RailEvent::ServerReinitialized {
                handshake_ex_flags: None
            },
            RailEvent::ProtocolWarning { .. },
        ]
    ));
}
