use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn invoke(base: &str, args: &[&str], input: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_assay"))
        .args(["--base-url", base])
        .args(args)
        .env("ASSAY_TOKEN", "ast_test_token_not_a_real_secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn fake_api(status: &str, response: Value) -> (String, thread::JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let status = status.to_owned();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut socket = loop {
            if let Ok((socket, _)) = listener.accept() {
                break socket;
            }
            assert!(Instant::now() < deadline, "CLI/MCP never called API");
            thread::sleep(Duration::from_millis(10));
        };
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut data = Vec::new();
        let (header_end, length) = loop {
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            data.extend_from_slice(&buffer[..count]);
            if let Some(position) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&data[..position]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|v| v.strip_prefix("content-length: "))
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                break (position + 4, length);
            }
        };
        while data.len() < header_end + length {
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            data.extend_from_slice(&buffer[..count]);
        }
        let headers = String::from_utf8_lossy(&data[..header_end]).to_lowercase();
        let body = serde_json::from_slice(&data[header_end..header_end + length]).unwrap();
        let response = response.to_string();
        write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        (headers, body)
    });
    (base, handle)
}

#[test]
fn cli_creates_ticket_using_bearer_and_returns_json() {
    let (base, request) = fake_api("201 Created", json!({"id":"t-1","ticketNo":"WO-TEST-1"}));
    let payload = json!({"title":"B300 掉卡","body":"<p>详细问题</p>","priority":"HIGH","attachmentIds":["draft-1"]});
    let output = invoke(
        &base,
        &["ticket", "create", "--input", "-"],
        &payload.to_string(),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["ticketNo"],
        "WO-TEST-1"
    );
    let (headers, body) = request.join().unwrap();
    assert!(headers.starts_with("post /api/tickets "));
    assert!(headers.contains("authorization: bearer ast_test_token_not_a_real_secret"));
    assert_eq!(body, payload);
}

#[test]
fn cli_preview_and_validation_make_no_request() {
    let payload = json!({"title":"t","body":"<p>body</p>"});
    let output = invoke(
        "http://127.0.0.1:1",
        &["ticket", "create", "--input", "-", "--dry-run"],
        &payload.to_string(),
    );
    assert!(output.status.success());
    let preview: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(preview["body"], payload);
    assert_eq!(preview["dryRun"], true);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("ast_test_token"));
    let invalid = invoke(
        "http://127.0.0.1:1",
        &["ticket", "create", "--input", "-"],
        "{\"title\":\"t\"}",
    );
    assert!(!invalid.status.success());
    assert!(invalid.stdout.is_empty());
    assert!(
        serde_json::from_slice::<Value>(&invalid.stderr).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("body")
    );
}

#[test]
fn mcp_advertises_create_and_can_preview_or_submit_with_same_contract() {
    let (base, request) = fake_api("201 Created", json!({"id":"t-2","ticketNo":"WO-TEST-2"}));
    let payload = json!({"title":"MCP ticket","body":"<p>body</p>"});
    let input = [
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"assay_ticket_create","arguments":{"title":"MCP ticket","body":"<p>body</p>","dryRun":true}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"assay_ticket_create","arguments":payload}}),
    ].iter().map(|v| format!("{v}\n")).collect::<String>();
    let output = invoke(&base, &["mcp", "serve"], &input);
    assert!(output.status.success());
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|v| serde_json::from_str(v).unwrap())
        .collect();
    let definition = responses[0]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "assay_ticket_create")
        .unwrap();
    assert_eq!(definition["annotations"]["idempotentHint"], false);
    assert_eq!(
        definition["inputSchema"]["required"],
        json!(["title", "body"])
    );
    let preview: Value = serde_json::from_str(
        responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(preview["dryRun"], true);
    let created: Value = serde_json::from_str(
        responses[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(created["ticketNo"], "WO-TEST-2");
    let (headers, body) = request.join().unwrap();
    assert!(headers.starts_with("post /api/tickets "));
    assert_eq!(
        body, payload,
        "dryRun is a client control, not an API field"
    );
}

#[test]
fn api_denial_is_a_cli_failure_and_an_mcp_tool_error() {
    let payload = json!({"title":"t","body":"b"});
    let error = json!({"message":"缺少权限: ticket:create","statusCode":403});
    let (base, request) = fake_api("403 Forbidden", error.clone());
    let output = invoke(
        &base,
        &["ticket", "create", "--input", "-"],
        &payload.to_string(),
    );
    assert!(!output.status.success());
    assert!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("403")
    );
    request.join().unwrap();
    let (base, request) = fake_api("403 Forbidden", error);
    let input = format!(
        "{}\n",
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"assay_ticket_create","arguments":payload}})
    );
    let output = invoke(&base, &["mcp", "serve"], &input);
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["result"]["isError"], true);
    assert!(
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("ticket:create")
    );
    request.join().unwrap();
}
