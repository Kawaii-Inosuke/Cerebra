use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::time::Duration;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn start(lib: &std::path::Path, ui: &std::path::Path) -> (Server, u16) {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new(env!("CARGO_BIN_EXE_cerebra"))
        .arg(lib)
        .args(["serve", "--port", &port.to_string(), "--ui"])
        .arg(ui)
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    (Server(child), port)
}

/// Raw HTTP/1.0 request; returns (status, body).
fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let (st, _, b) = http_full(port, method, path, body);
    (st, b)
}

fn http_full(port: u16, method: &str, path: &str, body: &str) -> (u16, String, String) {
    http_with(port, method, path, body, "Content-Type: application/json\r\n")
}

fn http_with(port: u16, method: &str, path: &str, body: &str, extra: &str) -> (u16, String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{extra}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    let status = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let (head, body) = out
        .split_once("\r\n\r\n")
        .map(|x| (x.0.to_string(), x.1.to_string()))
        .unwrap_or_default();
    (status, head, body)
}

#[test]
fn preview_serves_dispatch_files_and_blocks_escapes() {
    let d = tempfile::tempdir().unwrap();
    let lib = d.path().join("lib");
    std::fs::create_dir_all(lib.join("Biology")).unwrap();
    std::fs::write(lib.join("Biology/a.md"), "hello").unwrap();
    std::fs::write(lib.join("Biology/pic.png"), "PNG").unwrap();
    std::fs::write(d.path().join("secret.txt"), "top secret").unwrap();
    let ui = d.path().join("ui");
    std::fs::create_dir_all(&ui).unwrap();
    std::fs::write(ui.join("index.html"), "<html>app</html>").unwrap();
    let (_srv, port) = start(&lib, &ui);

    let (st, body) = http(
        port,
        "POST",
        "/api/dispatch",
        r#"{"cmd":"library_info","args":{}}"#,
    );
    assert_eq!(st, 200, "{body}");
    assert!(body.contains(r#""notes":1"#), "{body}");
    let (st, body) = http(port, "POST", "/api/dispatch", r#"{"cmd":"nope","args":{}}"#);
    assert_eq!(st, 400);
    assert!(body.contains("unknown command"));
    let (st, body) = http(port, "POST", "/api/app/app_state", "{}");
    assert_eq!(st, 200);
    assert!(body.contains(r#""preview":true"#), "{body}");

    assert_eq!(http(port, "GET", "/file/Biology/pic.png", "").1, "PNG");
    for bad in [
        "/file/..%2fsecret.txt",
        "/file/%2e%2e/secret.txt",
        "/file/../secret.txt",
        "/file/.cerebra/index.db",
    ] {
        let (st, body) = http(port, "GET", bad, "");
        assert_eq!(st, 404, "{bad}");
        assert!(!body.contains("top secret"));
    }
    // Cross-site requests from other web pages are refused (no-cors text/plain, or a foreign Origin).
    let save = r#"{"cmd":"library_info","args":{}}"#;
    assert_eq!(
        http_with(
            port,
            "POST",
            "/api/dispatch",
            save,
            "Content-Type: text/plain\r\n"
        )
        .0,
        415
    );
    let evil = "Content-Type: application/json\r\nOrigin: https://evil.example\r\n";
    assert_eq!(http_with(port, "POST", "/api/dispatch", save, evil).0, 403);
    let ok = format!("Content-Type: application/json\r\nOrigin: http://127.0.0.1:{port}\r\n");
    assert_eq!(http_with(port, "POST", "/api/dispatch", save, &ok).0, 200);

    let (_, head, body) = http_full(port, "GET", "/", "");
    assert!(body.contains("app"));
    assert!(head.to_lowercase().contains("cache-control: no-cache"), "{head}");
}
