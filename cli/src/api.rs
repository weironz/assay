use crate::config::Config;
use anyhow::{Context, Result, bail};
use reqwest::{
    blocking::{Client, Response},
    header::{CONTENT_TYPE, COOKIE, SET_COOKIE},
};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    session_cookie: String,
    http: Client,
}

impl ApiClient {
    pub fn from_config(config: &Config) -> Result<Self> {
        let session_cookie = std::env::var("ASSAY_SESSION_COOKIE")
            .ok()
            .or_else(|| config.session_cookie.clone())
            .context("未登录。请先运行 assay auth login，或由系统注入 ASSAY_SESSION_COOKIE")?;
        Ok(Self {
            base_url: config.base_url.clone(),
            session_cookie,
            http: Client::builder().timeout(Duration::from_secs(45)).build()?,
        })
    }

    pub fn login(base_url: &str, email: &str, password: &str) -> Result<String> {
        let response = Client::builder()
            .timeout(Duration::from_secs(45))
            .build()?
            .post(format!("{base_url}/auth/sign-in/email"))
            .header(CONTENT_TYPE, "application/json")
            .json(&json!({ "email": email, "password": password }))
            .send()?;
        let response = ensure_success(response)?;
        let cookies = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .filter(|v| v.contains('='))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if cookies.is_empty() {
            bail!("登录成功但服务器没有返回会话 Cookie");
        }
        Ok(cookies.join("; "))
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        self.request(self.http.get(self.url(path)))
            .send()?
            .pipe(ensure_success)?
            .json()
            .context("解析 API 响应失败")
    }

    /// The REST detail endpoint is keyed by database ID. Resolve human-facing WO-… numbers
    /// through the list endpoint first so both identifiers work consistently in CLI and MCP.
    pub fn get_ticket(&self, reference: &str) -> Result<Value> {
        if !reference.starts_with("WO-") {
            return self.get(&format!("/tickets/{reference}"));
        }
        let listing = self.get_with_query("/tickets", &[("keyword", reference.to_owned())])?;
        let ticket_id = listing
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    (item.get("ticketNo").and_then(Value::as_str) == Some(reference))
                        .then(|| item.get("id").and_then(Value::as_str))
                        .flatten()
                })
            })
            .context("未找到指定工单号")?;
        self.get(&format!("/tickets/{ticket_id}"))
    }

    pub fn get_with_query(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        self.request(self.http.get(self.url(path)))
            .query(query)
            .send()?
            .pipe(ensure_success)?
            .json()
            .context("解析 API 响应失败")
    }

    pub fn post(&self, path: &str, payload: Value) -> Result<Value> {
        self.request(self.http.post(self.url(path)))
            .json(&payload)
            .send()?
            .pipe(ensure_success)?
            .json()
            .context("解析 API 响应失败")
    }

    fn request(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        request.header(COOKIE, &self.session_cookie)
    }
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, func: impl FnOnce(Self) -> T) -> T {
        func(self)
    }
}
impl<T> Pipe for T {}

fn ensure_success(response: Response) -> Result<Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("message").cloned())
        .unwrap_or(Value::String(body));
    bail!("API 请求失败 ({status}): {message}")
}
