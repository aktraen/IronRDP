//! Headless RemoteApp (RAIL) probe for xrdp.
//!
//! Connects in RemoteApp mode, wakes xrdp's RAIL channel with `RailClient::initiate`, runs a
//! script of RAIL operations and tracks the server's windows with `RailWindowTracker`, exactly as
//! the web client does. Optionally saves the desktop and a crop per window as PNG files.
//!
//! # Usage example
//!
//! ```shell
//! cargo run --example=railprobe -- --host <HOST> -u <USER> --password-file <FILE> \
//!     --steps 'wait:3;exec:/usr/bin/xterm;wait:5;move:xterm=40,40,640,400;shot:t1;close:xterm;wait:3' \
//!     --dump-orders --report report.json --out shots/
//! ```
//!
//! Steps, separated by `;`: `wait:<seconds>`, `exec:<path>`, `move:<window>=<x>,<y>,<w>,<h>`,
//! `activate:<window>`, `close:<window>`, `minimize:<window>`, `restore:<window>`, `resync`,
//! `shot:<tag>`. A `<window>` is an id (`0x1400007`) or a title substring.

#![allow(unused_crate_dependencies)] // false positives because there is both a library and a binary
#![allow(clippy::print_stdout)]

use core::fmt::Write as _;
use core::time::Duration;
use std::io::Write as _;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::Context as _;
use connector::Credentials;
use ironrdp::connector;
use ironrdp::connector::ConnectionResult;
use ironrdp::pdu::gcc::{ConnectionType, KeyboardType};
use ironrdp::pdu::rdp::capability_sets::{MajorPlatformType, RailSupportLevel};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput, WindowOrderErrorPolicy};
use ironrdp_core::ReadCursor;
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::window::{decode_forwarded_windowing_orders, try_decode_slow_path_windowing_orders};
use ironrdp_rail::client::{
    RailClient, RailEvent, RailInputEvent, RailServerCompat, RailSvcMessages, RailWindow, RailWindowEvent,
    RailWindowTracker,
};
use ironrdp_rail::pdu::{
    ActivatePdu, ClientStatusPdu, ExecutePdu, Rectangle, SystemCommand, SystemCommandPdu, WindowMovePdu,
};
use sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
use tokio_rustls::rustls;
use tracing::debug;

const RESEND_INTERVAL: Duration = Duration::from_secs(5);

fn main() -> anyhow::Result<()> {
    setup_logging()?;
    let options = Options::parse()?;
    let started = Instant::now();
    let mut report = Report::default();

    let (connection_result, mut framed) =
        connect(options.connector_config()?, options.host.clone(), options.port).context("connect")?;
    report.window_support_level = format!("{:?}", connection_result.window_support_level);
    println!(
        "[{:>6}] connected {}x{}, window support {}",
        started.elapsed().as_millis(),
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
        report.window_support_level
    );

    let mut image = DecodedImage::new(
        ironrdp_graphics::image_processing::PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );
    let window_support_level = connection_result.window_support_level;
    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();
    active_stage.set_window_support_level(window_support_level);
    active_stage.set_window_order_error_policy(WindowOrderErrorPolicy::Skip);

    let bootstrap = execute(&options.bootstrap);
    send_rail(&mut active_stage, &mut framed, |rail| rail.initiate(bootstrap))?;
    report.initiation_attempts = 1;
    let mut last_initiation = Instant::now();

    let mut tracker = RailWindowTracker::new();
    let mut steps = options.steps.clone().into_iter().peekable();
    let mut step_deadline: Option<Instant> = None;
    let mut steps_done_at: Option<Instant> = None;

    'session: loop {
        if let Some(done) = steps_done_at
            && done.elapsed() >= options.linger
        {
            break;
        }
        if started.elapsed() >= options.timeout {
            report.notes.push("timed out".to_owned());
            break;
        }

        if report.established_ms.is_none() && last_initiation.elapsed() >= RESEND_INTERVAL {
            let resent = send_rail(&mut active_stage, &mut framed, RailClient::resend_initiation)?;
            if resent {
                report.initiation_attempts += 1;
                println!("[{:>6}] initiation resent", started.elapsed().as_millis());
            }
            last_initiation = Instant::now();
        }

        if report.established_ms.is_some() && step_deadline.is_none_or(|deadline| Instant::now() >= deadline) {
            step_deadline = None;
            match steps.next() {
                Some(step) => {
                    println!("[{:>6}] step {step:?}", started.elapsed().as_millis());
                    step_deadline = run_step(&step, &mut active_stage, &mut framed, &mut tracker, &image, &options)?;
                }
                None => {
                    if steps_done_at.is_none() {
                        steps_done_at = Some(Instant::now());
                    }
                }
            }
        }

        let (action, payload) = match framed.read_pdu() {
            Ok(frame) => frame,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(error) => return Err(anyhow::Error::new(error).context("read frame")),
        };

        for output in active_stage.process(&mut image, action, &payload)? {
            match output {
                ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame).context("write response")?,
                ActiveStageOutput::WindowingOrders(forwarded) => {
                    if options.dump_orders {
                        dump_orders(&forwarded);
                    }
                    if report.first_new_window_order.is_none() {
                        report.first_new_window_order = first_new_window_order(&forwarded);
                    }
                    for event in tracker.apply_update(&forwarded) {
                        report.record_window_event(&event);
                        print_window_event(started, &event);
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    report.notes.push(format!("terminated: {reason}"));
                    break 'session;
                }
                _ => {}
            }
        }

        let events = active_stage
            .get_svc_processor_mut::<RailClient>()
            .map(RailClient::take_events)
            .unwrap_or_default();
        for event in events {
            println!("[{:>6}] rail {event:?}", started.elapsed().as_millis());
            match event {
                RailEvent::Handshake { .. } => {
                    report.established_ms = Some(started.elapsed().as_millis());
                }
                RailEvent::ServerReinitialized { .. } => {
                    report.server_reinitializations += 1;
                }
                RailEvent::ProtocolWarning { description } => report.warnings.push(description),
                RailEvent::InitiationExhausted { attempts } => {
                    report
                        .notes
                        .push(format!("initiation exhausted after {attempts} attempts"));
                    break 'session;
                }
                _ => {}
            }
        }
    }

    report.skipped_window_orders = active_stage.skipped_window_orders();
    report.decode_errors = tracker.decode_errors();
    report.windows = tracker.windows().cloned().collect();
    if let Some(dir) = &options.out {
        save_shots(&image, &tracker, dir, "final")?;
    }
    let json = report.to_json();
    match &options.report {
        Some(path) => std::fs::write(path, &json).with_context(|| format!("write {}", path.display()))?,
        None => println!("{json}"),
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    Wait(Duration),
    Exec(String),
    Move { window: String, rect: [i32; 4] },
    Activate(String),
    Command { window: String, command: SystemCommand },
    Resync,
    Shot(String),
}

impl Step {
    fn parse(text: &str) -> anyhow::Result<Self> {
        let (name, argument) = text.split_once(':').unwrap_or((text, ""));
        let step = match name {
            "wait" => Self::Wait(Duration::from_secs_f64(argument.parse().context("wait seconds")?)),
            "exec" => Self::Exec(argument.to_owned()),
            "move" => {
                let (window, rect) = argument.split_once('=').context("move:<window>=<x>,<y>,<w>,<h>")?;
                let values = rect
                    .split(',')
                    .map(|value| value.trim().parse::<i32>())
                    .collect::<Result<Vec<_>, _>>()
                    .context("move rectangle")?;
                let rect: [i32; 4] = values.try_into().map_err(|_| anyhow::anyhow!("move needs 4 numbers"))?;
                Self::Move {
                    window: window.to_owned(),
                    rect,
                }
            }
            "activate" => Self::Activate(argument.to_owned()),
            "close" | "minimize" | "restore" => Self::Command {
                window: argument.to_owned(),
                command: match name {
                    "close" => SystemCommand::Close,
                    "minimize" => SystemCommand::Minimize,
                    _ => SystemCommand::Restore,
                },
            },
            "resync" => Self::Resync,
            "shot" => Self::Shot(argument.to_owned()),
            other => anyhow::bail!("unknown step `{other}`"),
        };
        Ok(step)
    }
}

/// Runs one step and returns when the next one may start.
fn run_step(
    step: &Step,
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    tracker: &mut RailWindowTracker,
    image: &DecodedImage,
    options: &Options,
) -> anyhow::Result<Option<Instant>> {
    match step {
        Step::Wait(duration) => return Ok(Some(Instant::now() + *duration)),
        Step::Exec(path) => {
            let launch = execute(path);
            send_rail(active_stage, framed, |rail| rail.queue_execute(launch))?;
        }
        Step::Move { window, rect } => {
            let id = find_window(tracker, window)?;
            let edge = |value: i32| i16::try_from(value).context("move rectangle out of range");
            let rectangle = Rectangle {
                left: edge(rect[0])?,
                top: edge(rect[1])?,
                right: edge(rect[0].saturating_add(rect[2]))?,
                bottom: edge(rect[1].saturating_add(rect[3]))?,
            };
            let input = RailInputEvent::WindowMove(WindowMovePdu {
                window_id: id,
                rectangle,
            });
            send_rail(active_stage, framed, |rail| rail.queue_input(input))?;
        }
        Step::Activate(window) => {
            let input = RailInputEvent::Activate(ActivatePdu {
                window_id: find_window(tracker, window)?,
                enabled: true,
            });
            send_rail(active_stage, framed, |rail| rail.queue_input(input))?;
        }
        Step::Command { window, command } => {
            let input = RailInputEvent::SystemCommand(SystemCommandPdu {
                window_id: find_window(tracker, window)?,
                command: *command,
            });
            send_rail(active_stage, framed, |rail| rail.queue_input(input))?;
        }
        Step::Resync => {
            tracker.begin_resync();
            send_rail(active_stage, framed, |rail| Ok(rail.request_work_area()))?;
            return Ok(Some(Instant::now() + Duration::from_secs(3)));
        }
        Step::Shot(tag) => {
            for event in tracker.end_resync() {
                println!("resync pruned {event:?}");
            }
            if let Some(dir) = &options.out {
                save_shots(image, tracker, dir, tag)?;
            }
        }
    }
    Ok(None)
}

fn find_window(tracker: &RailWindowTracker, selector: &str) -> anyhow::Result<u32> {
    if let Some(hex) = selector.strip_prefix("0x") {
        return u32::from_str_radix(hex, 16).context("window id");
    }
    tracker
        .windows()
        .find(|window| window.title.contains(selector))
        .map(|window| window.id)
        .with_context(|| format!("no window titled `{selector}`"))
}

fn execute(path: &str) -> ExecutePdu {
    ExecutePdu {
        flags: 0,
        executable: path.to_owned(),
        working_directory: String::new(),
        arguments: String::new(),
    }
}

/// Runs a RAIL operation and writes what it sends; returns whether anything was sent.
fn send_rail(
    active_stage: &mut ActiveStage,
    framed: &mut UpgradedFramed,
    operation: impl FnOnce(&mut RailClient) -> ironrdp_pdu::PduResult<RailSvcMessages>,
) -> anyhow::Result<bool> {
    let rail = active_stage
        .get_svc_processor_mut::<RailClient>()
        .context("the RAIL channel was not joined")?;
    let messages: Vec<_> = operation(rail)?.into();
    if messages.is_empty() {
        return Ok(false);
    }
    let frame = active_stage.process_svc_processor_messages(RailSvcMessages::from(messages))?;
    framed.write_all(&frame).context("write RAIL frame")?;
    Ok(true)
}

fn dump_orders(forwarded: &[u8]) {
    let raw = forwarded
        .get(2..)
        .and_then(|update| try_decode_slow_path_windowing_orders(&mut ReadCursor::new(update)).ok());
    let typed = decode_forwarded_windowing_orders(forwarded);
    for (index, order) in raw.iter().flat_map(|update| update.orders.iter()).enumerate() {
        println!("order {index} hex={}", hex(order.encoded));
    }
    println!("orders {typed:?}");
}

fn first_new_window_order(forwarded: &[u8]) -> Option<String> {
    let update = try_decode_slow_path_windowing_orders(&mut ReadCursor::new(forwarded.get(2..)?)).ok()?;
    update
        .orders
        .iter()
        .find(|order| order.fields_present & 0x1100_0000 == 0x1100_0000)
        .map(|order| hex(order.encoded))
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn print_window_event(started: Instant, event: &RailWindowEvent) {
    let elapsed = started.elapsed().as_millis();
    match event {
        RailWindowEvent::Created(window) => println!("[{elapsed:>6}] created {}", describe(window)),
        RailWindowEvent::Updated {
            window,
            changes,
            reannounced,
        } => println!(
            "[{elapsed:>6}] updated {} {changes:?} reannounced={reannounced}",
            describe(window)
        ),
        RailWindowEvent::Deleted { id } => println!("[{elapsed:>6}] deleted {id:#x}"),
    }
}

fn describe(window: &RailWindow) -> String {
    format!(
        "{:#x} {:?} {:?} owner={:?} {:?} rect={:?} visible={:?}",
        window.id,
        window.title,
        window.role,
        window.owner,
        window.show_state,
        window.window_rect,
        window.visibility_rects
    )
}

fn save_shots(
    image: &DecodedImage,
    tracker: &RailWindowTracker,
    dir: &std::path::Path,
    tag: &str,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let full: image::RgbaImage = image::ImageBuffer::from_raw(
        u32::from(image.width()),
        u32::from(image.height()),
        image.data().to_vec(),
    )
    .context("invalid image")?;
    full.save(dir.join(format!("{tag}-desktop.png")))?;
    for window in tracker.windows() {
        let rect = window.window_rect;
        let (Ok(left), Ok(top)) = (u32::try_from(rect.left.max(0)), u32::try_from(rect.top.max(0))) else {
            continue;
        };
        if left >= full.width() || top >= full.height() || rect.width == 0 || rect.height == 0 {
            continue;
        }
        let width = rect.width.min(full.width() - left);
        let height = rect.height.min(full.height() - top);
        image::imageops::crop_imm(&full, left, top, width, height)
            .to_image()
            .save(dir.join(format!("{tag}-window-{:x}.png", window.id)))?;
    }
    Ok(())
}

#[derive(Debug, Default)]
struct Report {
    window_support_level: String,
    initiation_attempts: u32,
    established_ms: Option<u128>,
    server_reinitializations: u32,
    created: u32,
    updated: u32,
    reannounced: u32,
    deleted: u32,
    warnings: Vec<String>,
    notes: Vec<String>,
    skipped_window_orders: u64,
    decode_errors: u64,
    first_new_window_order: Option<String>,
    windows: Vec<RailWindow>,
}

impl Report {
    fn record_window_event(&mut self, event: &RailWindowEvent) {
        match event {
            RailWindowEvent::Created(_) => self.created += 1,
            RailWindowEvent::Updated { reannounced, .. } => {
                self.updated += 1;
                if *reannounced {
                    self.reannounced += 1;
                }
            }
            RailWindowEvent::Deleted { .. } => self.deleted += 1,
        }
    }

    fn to_json(&self) -> String {
        let strings = |values: &[String]| {
            let quoted = values.iter().map(|value| json_string(value)).collect::<Vec<_>>();
            format!("[{}]", quoted.join(", "))
        };
        let windows = self
            .windows
            .iter()
            .map(|window| {
                format!(
                    "{{\"id\": {}, \"title\": {}, \"role\": \"{:?}\", \"owner\": {}, \"left\": {}, \"top\": {}, \"width\": {}, \"height\": {}}}",
                    window.id,
                    json_string(&window.title),
                    window.role,
                    window.owner.map_or_else(|| "null".to_owned(), |owner| owner.to_string()),
                    window.window_rect.left,
                    window.window_rect.top,
                    window.window_rect.width,
                    window.window_rect.height
                )
            })
            .collect::<Vec<_>>();
        format!(
            "{{\n  \"window_support_level\": {},\n  \"initiation_attempts\": {},\n  \"established_ms\": {},\n  \
             \"server_reinitializations\": {},\n  \"created\": {},\n  \"updated\": {},\n  \"reannounced\": {},\n  \
             \"deleted\": {},\n  \"warnings\": {},\n  \"notes\": {},\n  \"skipped_window_orders\": {},\n  \
             \"decode_errors\": {},\n  \"first_new_window_order\": {},\n  \"windows\": [{}]\n}}",
            json_string(&self.window_support_level),
            self.initiation_attempts,
            self.established_ms
                .map_or_else(|| "null".to_owned(), |ms| ms.to_string()),
            self.server_reinitializations,
            self.created,
            self.updated,
            self.reannounced,
            self.deleted,
            strings(&self.warnings),
            strings(&self.notes),
            self.skipped_window_orders,
            self.decode_errors,
            self.first_new_window_order
                .as_deref()
                .map_or_else(|| "null".to_owned(), json_string),
            windows.join(", ")
        )
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            control if u32::from(control) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(control));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[derive(Debug, Clone)]
struct Options {
    host: String,
    port: u16,
    username: String,
    password: String,
    shell: String,
    bootstrap: String,
    width: u16,
    height: u16,
    steps: Vec<Step>,
    linger: Duration,
    timeout: Duration,
    dump_orders: bool,
    report: Option<PathBuf>,
    out: Option<PathBuf>,
}

impl Options {
    fn parse() -> anyhow::Result<Self> {
        let mut args = pico_args::Arguments::from_env();
        let password_file: PathBuf = args.value_from_str("--password-file")?;
        let steps: Option<String> = args.opt_value_from_str("--steps")?;
        let options = Self {
            host: args.value_from_str("--host")?,
            port: args.opt_value_from_str("--port")?.unwrap_or(3389),
            username: args.value_from_str("-u")?,
            password: std::fs::read_to_string(&password_file)
                .with_context(|| format!("read {}", password_file.display()))?
                .trim()
                .to_owned(),
            shell: args
                .opt_value_from_str("--shell")?
                .unwrap_or_else(|| "aktraen-rail".to_owned()),
            bootstrap: args
                .opt_value_from_str("--bootstrap")?
                .unwrap_or_else(|| "/usr/bin/true".to_owned()),
            width: args.opt_value_from_str("--width")?.unwrap_or(1600),
            height: args.opt_value_from_str("--height")?.unwrap_or(900),
            steps: steps
                .as_deref()
                .unwrap_or("")
                .split(';')
                .map(str::trim)
                .filter(|step| !step.is_empty())
                .map(Step::parse)
                .collect::<anyhow::Result<_>>()?,
            linger: Duration::from_secs(args.opt_value_from_str("--linger")?.unwrap_or(5)),
            timeout: Duration::from_secs(args.opt_value_from_str("--timeout")?.unwrap_or(180)),
            dump_orders: args.contains("--dump-orders"),
            report: args.opt_value_from_str("--report")?,
            out: args.opt_value_from_str("--out")?,
        };
        let rest = args.finish();
        anyhow::ensure!(rest.is_empty(), "unexpected arguments: {rest:?}");
        Ok(options)
    }

    fn connector_config(&self) -> anyhow::Result<connector::Config> {
        Ok(connector::Config {
            credentials: Credentials::UsernamePassword {
                username: self.username.clone(),
                password: self.password.clone(),
            },
            domain: None,
            enable_tls: true,
            enable_credssp: false,
            enable_standard_rdp_security: false,
            keyboard_type: KeyboardType::IBM_ENHANCED,
            keyboard_subtype: 0,
            keyboard_layout: 0x040C,
            keyboard_functional_keys_count: 12,
            connection_type: ConnectionType::Lan,
            ime_file_name: String::new(),
            dig_product_id: String::new(),
            desktop_size: connector::DesktopSize {
                width: self.width,
                height: self.height,
            },
            monitor_layout: None,
            bitmap: None,
            client_build: 0,
            client_name: "aktraen-railprobe".to_owned(),
            client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
            platform: MajorPlatformType::UNIX,
            enable_server_pointer: false,
            request_data: None,
            autologon: true,
            enable_audio_playback: false,
            enable_audio_capture: false,
            compression_type: Some(CompressionType::Rdp61),
            pointer_software_rendering: true,
            multitransport_flags: None,
            support_dyn_vc_gfx_protocol: false,
            performance_flags: PerformanceFlags::default(),
            desktop_scale_factor: 0,
            hardware_id: None,
            license_cache: None,
            timezone_info: TimezoneInfo::default(),
            alternate_shell: self.shell.clone(),
            work_dir: String::new(),
            remote_application_mode: true,
            rail_support_level: RailSupportLevel::SUPPORTED,
            remote_application_send_alternate_shell: true,
        })
    }
}

/// The RAIL channel as the web client configures it for xrdp.
fn rail_client(width: u16, height: u16) -> RailClient {
    RailClient::new(7601, width, height)
        .with_server_compat(RailServerCompat::XRDP)
        .with_client_status_flags(ClientStatusPdu::ALLOW_LOCAL_MOVE_SIZE)
}

fn setup_logging() -> anyhow::Result<()> {
    use tracing::metadata::LevelFilter;
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::prelude::*;

    let env_filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::WARN.into())
        .with_env_var("IRONRDP_LOG")
        .from_env_lossy();

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().compact())
        .with(env_filter)
        .try_init()
        .context("failed to set tracing global subscriber")?;

    Ok(())
}

type UpgradedFramed = ironrdp_blocking::Framed<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>;

fn connect(
    config: connector::Config,
    server_name: String,
    port: u16,
) -> anyhow::Result<(ConnectionResult, UpgradedFramed)> {
    let rail_client = rail_client(config.desktop_size.width, config.desktop_size.height);
    let server_addr = lookup_addr(&server_name, port).context("lookup addr")?;
    let tcp_stream = TcpStream::connect(server_addr).context("TCP connect")?;
    tcp_stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .context("set read timeout")?;
    let client_addr = tcp_stream.local_addr().context("get socket local address")?;
    let mut framed = ironrdp_blocking::Framed::new(tcp_stream);
    let mut connector = connector::ClientConnector::new(config, client_addr).with_static_channel(rail_client);
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("begin connection")?;
    let initial_stream = framed.into_inner_no_leftover();
    let (upgraded_stream, server_public_key) =
        tls_upgrade(initial_stream, server_name.clone()).context("TLS upgrade")?;
    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed = ironrdp_blocking::Framed::new(upgraded_stream);
    let mut network_client = ReqwestNetworkClient;
    let connection_result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut network_client,
        server_name.into(),
        server_public_key,
        None,
    )
    .context("finalize connection")?;
    Ok((connection_result, upgraded_framed))
}

fn lookup_addr(hostname: &str, port: u16) -> anyhow::Result<core::net::SocketAddr> {
    use std::net::ToSocketAddrs as _;
    let addr = (hostname, port)
        .to_socket_addrs()?
        .next()
        .context("socket address not found")?;
    Ok(addr)
}

fn tls_upgrade(
    stream: TcpStream,
    server_name: String,
) -> anyhow::Result<(rustls::StreamOwned<rustls::ClientConnection, TcpStream>, Vec<u8>)> {
    let mut config = rustls::client::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();
    config.key_log = std::sync::Arc::new(rustls::KeyLogFile::new());
    // CredSSP does not support TLS session resumption.
    config.resumption = rustls::client::Resumption::disabled();
    let config = std::sync::Arc::new(config);
    let server_name = server_name.try_into()?;
    let client = rustls::ClientConnection::new(config, server_name)?;
    let mut tls_stream = rustls::StreamOwned::new(client, stream);
    // Flushing drives the TLS handshake so the peer certificate is available below.
    tls_stream.flush()?;
    let cert = tls_stream
        .conn
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .context("peer certificate is missing")?;
    let server_public_key = extract_tls_server_public_key(cert)?;
    Ok((tls_stream, server_public_key))
}

fn extract_tls_server_public_key(cert: &[u8]) -> anyhow::Result<Vec<u8>> {
    use x509_cert::der::Decode as _;

    let cert = x509_cert::Certificate::from_der(cert)?;
    debug!(subject = %cert.tbs_certificate().subject());
    let server_public_key = cert
        .tbs_certificate()
        .subject_public_key_info()
        .subject_public_key
        .as_bytes()
        .context("subject public key BIT STRING is not aligned")?
        .to_owned();
    Ok(server_public_key)
}

mod danger {
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use tokio_rustls::rustls::{DigitallySignedStruct, Error, SignatureScheme, pki_types};

    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            vec![
                SignatureScheme::RSA_PKCS1_SHA1,
                SignatureScheme::ECDSA_SHA1_Legacy,
                SignatureScheme::RSA_PKCS1_SHA256,
                SignatureScheme::ECDSA_NISTP256_SHA256,
                SignatureScheme::RSA_PKCS1_SHA384,
                SignatureScheme::ECDSA_NISTP384_SHA384,
                SignatureScheme::RSA_PKCS1_SHA512,
                SignatureScheme::ECDSA_NISTP521_SHA512,
                SignatureScheme::RSA_PSS_SHA256,
                SignatureScheme::RSA_PSS_SHA384,
                SignatureScheme::RSA_PSS_SHA512,
                SignatureScheme::ED25519,
                SignatureScheme::ED448,
            ]
        }
    }
}
