use crate::{VERSION, api::ApiClient, config::Config};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

pub fn serve(config: Config) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let message: Value = match serde_json::from_str(&line?) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        }; // notifications have no response
        let response = match method {
            "initialize" => ok(
                id,
                json!({
                    "protocolVersion": message.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-11-25"),
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "assay", "version": VERSION },
                    "instructions": "Assay 工单助手。先读取工单，再生成建议；写入评论前应获得用户确认。"
                }),
            ),
            "tools/list" => ok(id, json!({ "tools": tools() })),
            "tools/call" => {
                match call_tool(&config, message.get("params").cloned().unwrap_or_default()) {
                    Ok(value) => ok(id, value),
                    Err(error) => ok(id, tool_error(error.to_string())),
                }
            }
            _ => err(id, -32601, "Method not found"),
        };
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }
    Ok(())
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "assay_ticket_get",
            "读取工单详情、讨论、附件和参与人。只读。",
            json!({"type":"object","required":["id"],"properties":{"id":{"type":"string","description":"工单数据库 ID 或工单号"}}}),
        ),
        tool(
            "assay_ticket_search",
            "搜索当前身份可见的工单。只读。",
            json!({"type":"object","properties":{"keyword":{"type":"string"},"status":{"type":"string"},"priority":{"type":"string"},"page":{"type":"integer","minimum":1},"pageSize":{"type":"integer","minimum":1,"maximum":100}}}),
        ),
        tool(
            "assay_ticket_add_comment",
            "向工单发布评论或内部备注。此操作会立即写入工单；必须先取得用户明确确认。",
            json!({"type":"object","required":["id","body"],"properties":{"id":{"type":"string"},"body":{"type":"string"},"internal":{"type":"boolean","default":false},"mentionUserIds":{"type":"array","items":{"type":"string"}}}}),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn call_tool(config: &Config, params: Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .context("缺少工具名称")?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let client = ApiClient::from_config(config)?;
    let value = match name {
        "assay_ticket_get" => client.get_ticket(required_string(&args, "id")?)?,
        "assay_ticket_search" => {
            let mut query = Vec::new();
            for (api_key, input_key) in [
                ("keyword", "keyword"),
                ("status", "status"),
                ("priority", "priority"),
                ("page", "page"),
                ("pageSize", "pageSize"),
            ] {
                if let Some(value) = args.get(input_key).and_then(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .or_else(|| v.as_u64().map(|n| n.to_string()))
                }) {
                    query.push((api_key, value));
                }
            }
            client.get_with_query("/tickets", &query)?
        }
        "assay_ticket_add_comment" => client.post(
            &format!("/tickets/{}/messages", required_string(&args, "id")?),
            json!({
                "body": required_string(&args, "body")?,
                "isInternal": args.get("internal").and_then(Value::as_bool).unwrap_or(false),
                "mentionUserIds": args.get("mentionUserIds").cloned().unwrap_or_else(|| json!([])),
            }),
        )?,
        _ => anyhow::bail!("不支持的工具：{name}"),
    };
    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }] }))
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .with_context(|| format!("缺少参数：{key}"))
}
fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn err(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
fn tool_error(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}
