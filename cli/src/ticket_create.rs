use crate::{api::ApiClient, config::Config};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

/// Shared request contract for CLI JSON input and the MCP tool.
pub fn schema() -> Value {
    let optional_id = json!({"type":"string","minLength":1,"description":"现有记录的数据库 ID；省略时由服务端采用默认值"});
    let times =
        json!({"type":"string","enum":["ANY","WEEKDAY_9_18","WEEKDAY_9_22","DAILY_9_22","NONE"]});
    json!({
        "type":"object", "required":["title","body"], "additionalProperties":false,
        "properties": {
            "title":{"type":"string","minLength":1,"description":"工单标题"},
            "body":{"type":"string","minLength":1,"description":"问题描述，HTML；图片需先通过 /api/uploads 上传"},
            "priority":{"type":"string","enum":["LOW","MEDIUM","HIGH","URGENT"],"description":"省略时为 MEDIUM"},
            "typeId":optional_id, "categoryId":optional_id, "queueId":optional_id,
            "datacenterId":optional_id,
            "categoryName":{"type":"string","maxLength":60,"description":"自定义分类；与 categoryId 同时传入时以 categoryId 为准"},
            "serialNumber":{"type":"string","maxLength":200},
            "attachmentIds":{"type":"array","items":{"type":"string","minLength":1},"description":"当前账号预先上传的草稿附件 ID；普通附件数量上限由服务端验证，内联图片另行计数"},
            "saveContactAsDefault":{"type":"boolean"},
            "contact":{
                "type":"object","required":["phone","callTime","smsTime"],"additionalProperties":false,
                "properties":{
                    "phone":{"type":"string","minLength":1,"maxLength":40},
                    "callTime":times,"smsTime":times,
                    "position":{"type":"string","enum":["TECH_LEAD","OPS_LEAD","FINANCE","CEO","OTHER"]},
                    "emails":{"type":"array","maxItems":5,"items":{"type":"string","format":"email"}}
                }
            }
        }
    })
}

// Validate against the same schema advertised to agents. Record existence, email
// validity, attachment ownership and RBAC are still enforced by the REST API.
fn validate(value: &Value, rules: &Value, field: &str) -> Result<()> {
    let valid_type = match rules["type"].as_str() {
        Some("object") => value.is_object(),
        Some("string") => value.is_string(),
        Some("array") => value.is_array(),
        Some("boolean") => value.is_boolean(),
        _ => false,
    };
    if !valid_type {
        bail!("参数 {field} 类型无效");
    }
    if let Some(choices) = rules["enum"].as_array() {
        if !choices.contains(value) {
            bail!("参数 {field} 取值无效");
        }
    }
    if let Some(text) = value.as_str() {
        if rules["minLength"]
            .as_u64()
            .is_some_and(|n| text.trim().chars().count() < n as usize)
        {
            bail!("参数 {field} 不能为空");
        }
        if rules["maxLength"]
            .as_u64()
            .is_some_and(|n| text.chars().count() > n as usize)
        {
            bail!("参数 {field} 超过长度上限");
        }
    }
    if let Some(items) = value.as_array() {
        if rules["maxItems"]
            .as_u64()
            .is_some_and(|n| items.len() > n as usize)
        {
            bail!("参数 {field} 超过数量上限");
        }
        for item in items {
            validate(item, &rules["items"], field)?;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = rules["required"].as_array() {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    bail!("缺少参数：{name}");
                }
            }
        }
        let properties = rules["properties"]
            .as_object()
            .context("建单 schema 缺少 properties")?;
        for (name, value) in object {
            let property = properties
                .get(name)
                .with_context(|| format!("不支持的参数：{name}"))?;
            validate(value, property, name)?;
        }
    }
    Ok(())
}

pub fn create(config: &Config, input: Value, dry_run: bool) -> Result<Value> {
    validate(&input, &schema(), "工单")?;
    if dry_run {
        return Ok(json!({"dryRun":true,"method":"POST","path":"/api/tickets","body":input}));
    }
    // Never automatically retry a create request: a lost response can mean the
    // ticket was already committed. Search before resubmitting.
    ApiClient::from_config(config)?.post("/tickets", input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_does_not_need_credentials_or_connect_to_api() {
        let config = Config {
            base_url: "http://127.0.0.1:1/api".into(),
            api_token: None,
            session_cookie: None,
        };
        let body = json!({"title":"B300 掉卡","body":"<p>详情</p>","priority":"HIGH","attachmentIds":["owned-draft"]});
        let preview = create(&config, body.clone(), true).unwrap();
        assert_eq!(
            preview,
            json!({"dryRun":true,"method":"POST","path":"/api/tickets","body":body})
        );
    }

    #[test]
    fn rejects_bad_inputs_before_any_request() {
        let config = Config {
            base_url: "http://127.0.0.1:1/api".into(),
            api_token: None,
            session_cookie: None,
        };
        for input in [
            json!({"title":"t"}),
            json!({"title":" ","body":"b"}),
            json!({"title":"t","body":3}),
            json!({"title":"t","body":"b","priority":"critical"}),
            json!({"title":"t","body":"b","requesterId":"other-user"}),
            json!({"title":"t","body":"b","clusterId":"retired-cluster"}),
            json!({"title":"t","body":"b","attachmentIds":[1]}),
            json!({"title":"t","body":"b","contact":{"phone":"1"}}),
            json!({"title":"t","body":"b","contact":{"phone":"1","callTime":"INVALID","smsTime":"ANY"}}),
        ] {
            assert!(create(&config, input, true).is_err());
        }
    }
}
