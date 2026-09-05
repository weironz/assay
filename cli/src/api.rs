use crate::config::Config;
use anyhow::{Context, Result, bail};
use reqwest::{
    blocking::{Client, Response},
    header::{AUTHORIZATION, CONTENT_TYPE, COOKIE, SET_COOKIE},
};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    credentials: Credentials,
    http: Client,
}

pub const MAX_MCP_IMAGES: usize = 4;
pub const MAX_MCP_IMAGE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug)]
pub struct McpImage {
    pub id: String,
    pub file_name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone)]
enum Credentials {
    Bearer(String),
    SessionCookie(String),
}

impl ApiClient {
    pub fn from_config(config: &Config) -> Result<Self> {
        let credentials = std::env::var("ASSAY_TOKEN")
            .ok()
            .or_else(|| config.api_token.clone())
            .map(Credentials::Bearer)
            .or_else(|| {
                std::env::var("ASSAY_SESSION_COOKIE")
                    .ok()
                    .or_else(|| config.session_cookie.clone())
                    .map(Credentials::SessionCookie)
            })
            .context("未登录。请运行 assay auth login 或 assay auth token --token-stdin")?;
        Ok(Self {
            base_url: config.base_url.clone(),
            credentials,
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

    /// Read ticket-bound image attachments through the ordinary authenticated download route.
    /// The caller receives raw bytes only after MIME, count and size constraints are checked.
    pub fn get_ticket_images(
        &self,
        ticket: &Value,
        image_ids: Option<&[String]>,
    ) -> Result<Vec<McpImage>> {
        let ticket_id = ticket
            .get("id")
            .and_then(Value::as_str)
            .context("工单详情缺少 id")?;
        let attachments = self.get(&format!("/tickets/{ticket_id}/attachments"))?;
        let requested = image_ids.unwrap_or(&[]);
        if requested.len() > MAX_MCP_IMAGES {
            bail!("一次最多读取 {MAX_MCP_IMAGES} 张图片");
        }

        let mut selected = Vec::new();
        for attachment in attachments.as_array().context("解析附件列表失败")? {
            let id = attachment
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mime = attachment
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let is_requested = requested.is_empty() || requested.iter().any(|value| value == id);
            if is_requested && mime.starts_with("image/") {
                selected.push(attachment);
            }
        }
        if !requested.is_empty() && selected.len() != requested.len() {
            bail!("指定的附件不存在、不是图片，或无权读取");
        }
        if selected.len() > MAX_MCP_IMAGES {
            bail!(
                "该工单有 {} 张图片；请用 imageIds 一次最多指定 {MAX_MCP_IMAGES} 张",
                selected.len()
            );
        }

        selected
            .into_iter()
            .map(|attachment| self.download_mcp_image(attachment))
            .collect()
    }

    fn download_mcp_image(&self, attachment: &Value) -> Result<McpImage> {
        let id = attachment
            .get("id")
            .and_then(Value::as_str)
            .context("图片附件缺少 id")?;
        let file_name = attachment
            .get("fileName")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned();
        let declared_size = attachment
            .get("fileSize")
            .and_then(Value::as_u64)
            .context("图片附件缺少大小")?;
        if declared_size > MAX_MCP_IMAGE_BYTES as u64 {
            bail!(
                "图片 {file_name} 超过 {} MB 的 MCP 读取上限",
                MAX_MCP_IMAGE_BYTES / 1024 / 1024
            );
        }
        let path = attachment
            .get("url")
            .and_then(Value::as_str)
            .context("图片附件缺少下载地址")?;
        let response = ensure_success(self.request(self.http.get(self.url(path))).send()?)?;
        let mime_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .unwrap_or_default()
            .to_owned();
        if !mime_type.starts_with("image/") {
            bail!("附件 {file_name} 的下载内容不是图片");
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_MCP_IMAGE_BYTES as u64)
        {
            bail!(
                "图片 {file_name} 超过 {} MB 的 MCP 读取上限",
                MAX_MCP_IMAGE_BYTES / 1024 / 1024
            );
        }
        let data = response.bytes()?.to_vec();
        if data.len() > MAX_MCP_IMAGE_BYTES {
            bail!(
                "图片 {file_name} 超过 {} MB 的 MCP 读取上限",
                MAX_MCP_IMAGE_BYTES / 1024 / 1024
            );
        }
        Ok(McpImage {
            id: id.to_owned(),
            file_name,
            mime_type,
            data,
        })
    }

    fn request(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        match &self.credentials {
            Credentials::Bearer(token) => request.header(AUTHORIZATION, format!("Bearer {token}")),
            Credentials::SessionCookie(cookie) => request.header(COOKIE, cookie),
        }
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
