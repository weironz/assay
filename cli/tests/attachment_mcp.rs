use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    thread,
};

#[test]
fn mcp_upload_sends_file_with_authorization_and_returns_id() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        let mut data = Vec::new();
        let (start, len) = loop {
            let mut buf = [0; 4096];
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0);
            data.extend_from_slice(&buf[..n]);
            if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let h = String::from_utf8_lossy(&data[..pos]).to_lowercase();
                let len = h
                    .lines()
                    .find_map(|x| x.strip_prefix("content-length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                break (pos + 4, len);
            }
        };
        while data.len() < start + len {
            let mut b = [0; 4096];
            let n = stream.read(&mut b).unwrap();
            assert!(n > 0);
            data.extend_from_slice(&b[..n]);
        }
        let headers = String::from_utf8_lossy(&data[..start]).to_lowercase();
        assert!(headers.starts_with("post /api/uploads?kind=attachment "));
        assert!(headers.contains("authorization: bearer ast_test_token"));
        let body = String::from_utf8_lossy(&data[start..]);
        assert!(body.contains("name=\"file\""));
        assert!(body.contains("fixture contents"));
        let body = r#"{"id":"draft-123"}"#;
        write!(stream, "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let path = std::env::temp_dir().join(format!("assay-mcp-test-{}.txt", std::process::id()));
    std::fs::write(&path, "fixture contents").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_assay"))
        .args(["--base-url", &url, "mcp", "serve"])
        .env("ASSAY_TOKEN", "ast_test_token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"assay_attachment_upload","arguments":{"path":path}}});
    writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
    std::fs::remove_file(&path).unwrap();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("draft-123")
    );
}
