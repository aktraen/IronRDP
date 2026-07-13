#[cfg(windows)]
use core::time::Duration;
#[cfg(windows)]
use std::sync::mpsc;
#[cfg(windows)]
use std::{env, process::Command};

#[cfg(windows)]
use ironrdp_dvc::DvcProcessor as _;
#[cfg(windows)]
use ironrdp_dvc_pipe_proxy::DvcNamedPipeProxy;
#[cfg(windows)]
use tokio::io::AsyncWriteExt as _;
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;

#[cfg(windows)]
#[tokio::test]
async fn connects_and_forwards_windows_pipe_data() {
    let name = format!("ironrdp-dvc-pipe-proxy-test-{}", std::process::id());
    let (proxy, callback_rx) = start_proxy(&name);

    let pipe_path = format!(r"\\.\pipe\{name}");
    let mut client = (0..200)
        .find_map(|_| match ClientOptions::new().open(&pipe_path) {
            Ok(client) => Some(client),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(10));
                None
            }
        })
        .expect("DVC pipe proxy must create the pipe within two seconds");

    client.write_all(b"test data").await.expect("write to DVC pipe");
    assert_forwarded_data(callback_rx);

    drop(proxy);
}

#[cfg(windows)]
#[tokio::test]
async fn connects_from_a_separate_process() {
    let name = format!("ironrdp-dvc-pipe-proxy-cross-process-test-{}", std::process::id());
    let (proxy, callback_rx) = start_proxy(&name);
    let current_exe = env::current_exe().expect("current test executable");
    let status = Command::new(current_exe)
        .arg("--exact")
        .arg("dvc_pipe_proxy::child_process_connects_and_forwards_windows_pipe_data")
        .arg("--nocapture")
        .env("IRONRDP_DVC_PIPE_PROXY_TEST_NAME", &name)
        .status()
        .expect("spawn DVC pipe client process");

    assert!(status.success(), "DVC pipe client process must succeed");
    assert_forwarded_data(callback_rx);

    drop(proxy);
}

#[cfg(windows)]
#[tokio::test]
async fn child_process_connects_and_forwards_windows_pipe_data() {
    let Ok(name) = env::var("IRONRDP_DVC_PIPE_PROXY_TEST_NAME") else {
        return;
    };

    let pipe_path = format!(r"\\.\pipe\{name}");
    let mut client = (0..200)
        .find_map(|_| match ClientOptions::new().open(&pipe_path) {
            Ok(client) => Some(client),
            Err(_) => {
                std::thread::sleep(Duration::from_millis(10));
                None
            }
        })
        .expect("DVC pipe proxy must be visible to a separate process within two seconds");

    client
        .write_all(b"cross-process test data")
        .await
        .expect("write to DVC pipe");
}

#[cfg(windows)]
fn start_proxy(name: &str) -> (DvcNamedPipeProxy, mpsc::Receiver<Vec<ironrdp_svc::SvcMessage>>) {
    let (callback_tx, callback_rx) = mpsc::channel();
    let mut proxy = DvcNamedPipeProxy::new("test", name, move |_, messages| {
        callback_tx
            .send(messages)
            .expect("test callback receiver must remain alive");
        Ok(())
    });
    proxy.start(1).expect("start DVC pipe proxy");

    (proxy, callback_rx)
}

#[cfg(windows)]
fn assert_forwarded_data(callback_rx: mpsc::Receiver<Vec<ironrdp_svc::SvcMessage>>) {
    let messages = callback_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("DVC pipe proxy must forward pipe data to its callback");
    assert!(!messages.is_empty(), "DVC pipe data must produce an SVC message");
}
