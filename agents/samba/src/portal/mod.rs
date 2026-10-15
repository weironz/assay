//! Employee file transport. No administrative credentials or local share mount.
mod lease;
mod paths;
mod transfer;

use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, Scope, SearchEntry};
use lease::{Lease, MAX_WEB_SECONDS};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use smb::{
    Client, ClientConfig, FileAccessMask, FileBasicInformation, FileCreateArgs, Resource, UncPath,
};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, OwnedMutexGuard};
use zeroize::Zeroizing;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    listen: String,
    token_file: String,
    smb_server: String,
    domain: String,
    ldap_url: String,
    ldap_ca_file: String,
    users_dn: String,
    #[serde(default = "max_bytes")]
    max_file_bytes: u64,
    #[serde(default = "idle")]
    idle_seconds: u64,
    #[serde(default = "lifetime")]
    lifetime_seconds: u64,
    #[serde(default = "web_lifetime")]
    web_session_max_seconds: u64,
}
fn max_bytes() -> u64 {
    200 * 1024 * 1024
}
fn idle() -> u64 {
    900
}
fn lifetime() -> u64 {
    3600
}
fn web_lifetime() -> u64 {
    MAX_WEB_SECONDS
}
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub struct App {
    config: Config,
    token_hash: Vec<u8>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    login_slots: Arc<tokio::sync::Semaphore>,
}
pub struct Session {
    owner: String,
    client: Client,
    identity: Identity,
    fingerprint: Vec<u8>,
    ldap: Mutex<Ldap>,
    shares: HashSet<String>,
    lease: RwLock<Lease>,
    touched: Mutex<Instant>,
    gate: Arc<Mutex<()>>,
    revoked: AtomicBool,
}
trait ResourceExt {
    fn handle(&self) -> &smb::resource::ResourceHandle;
}
impl ResourceExt for Resource {
    fn handle(&self) -> &smb::resource::ResourceHandle {
        match self {
            Self::File(f) => f.handle(),
            Self::Directory(d) => d.handle(),
            Self::Pipe(p) => p.handle(),
        }
    }
}
impl Session {
    pub fn live(&self) -> Result<(), Error> {
        if self.revoked.load(Ordering::Acquire)
            || self
                .lease
                .read()
                .map_err(|_| Error::expired())?
                .expired(Instant::now())
        {
            Err(Error::expired())
        } else {
            Ok(())
        }
    }
    async fn expired(&self, idle_seconds: u64) -> bool {
        let elapsed = self.touched.lock().await.elapsed();
        self.live().is_err()
            || self
                .lease
                .read()
                .map(|l| l.idle_expired(elapsed, idle_seconds))
                .unwrap_or(true)
    }
    async fn probe(&self, app: &App) -> Result<(), Error> {
        self.live()?;
        let current = fingerprint(&mut *self.ldap.lock().await, &self.identity).await;
        if current.ok().as_deref() != Some(self.fingerprint.as_slice()) {
            return Err(Error::expired());
        }
        if let Some(share) = self.shares.iter().next() {
            let target = self.target(app, share, "")?;
            let root = self
                .open(&target, FileAccessMask::new().with_generic_read(true))
                .await?;
            root.handle().close().await.map_err(Error::smb)?;
        }
        *self.touched.lock().await = Instant::now();
        Ok(())
    }
    async fn close(&self) {
        self.revoked.store(true, Ordering::Release);
        let _ = tokio::time::timeout(Duration::from_secs(20), async {
            let _ = self.client.close().await;
            let _ = self.ldap.lock().await.unbind().await;
        })
        .await;
    }
    fn target(&self, app: &App, share: &str, path: &str) -> Result<UncPath, Error> {
        if !self.shares.contains(share) {
            return Err(Error(StatusCode::FORBIDDEN, "无权访问该共享目录"));
        }
        paths::validate(path, true)?;
        let root = UncPath::from_str(&format!("\\\\{}\\{}", app.config.smb_server, share))
            .map_err(|_| Error::invalid())?;
        Ok(root.with_path(&path.replace('/', "\\")))
    }
    // Check every component, with reparse traversal disabled. SMB server still enforces ACLs.
    async fn checked(&self, app: &App, share: &str, path: &str) -> Result<UncPath, Error> {
        let target = self.target(app, share, path)?;
        let mut prefix = String::new();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let r = self
                .open(
                    &self.target(app, share, &prefix)?,
                    FileAccessMask::new().with_file_read_attributes(true),
                )
                .await?;
            let info = r
                .handle()
                .query_info::<FileBasicInformation>()
                .await
                .map_err(Error::smb);
            let _ = r.handle().close().await;
            if info?.file_attributes.reparse_point() {
                return Err(Error(StatusCode::FORBIDDEN, "不支持符号链接或重解析目录"));
            }
        }
        Ok(target)
    }
    async fn open(&self, target: &UncPath, access: FileAccessMask) -> Result<Resource, Error> {
        self.live()?;
        let mut args = FileCreateArgs::make_open_existing(access);
        args.options.set_open_reparse_point(true);
        self.client
            .create_file(target, &args)
            .await
            .map_err(Error::smb)
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    id: String,
    name: String,
    dn: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    owner: String,
    identity: Identity,
    password: String,
    shares: Vec<String>,
    ttl: u64,
    #[serde(default)]
    follow_web_session: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    share: String,
    #[serde(default)]
    path: String,
}

pub struct Error(StatusCode, &'static str);
impl Error {
    fn invalid() -> Self {
        Self(StatusCode::BAD_REQUEST, "文件路径或参数无效")
    }
    fn expired() -> Self {
        Self(StatusCode::GONE, "文件会话已失效，请重新验证 AD 密码")
    }
    fn smb(e: impl std::error::Error + 'static) -> Self {
        // Decode protocol status, not localized Display strings. Never log raw errors.
        match smb_status(&e).and_then(|code| smb::header::Status::try_from(code).ok()) {
            Some(smb::header::Status::AccessDenied) => {
                Self(StatusCode::FORBIDDEN, "Samba 拒绝访问，请核对文件权限")
            }
            Some(smb::header::Status::ObjectNameCollision) => {
                Self(StatusCode::CONFLICT, "目标已存在，请更换名称")
            }
            Some(
                smb::header::Status::ObjectNameNotFound | smb::header::Status::ObjectPathNotFound,
            ) => Self(StatusCode::NOT_FOUND, "文件或目录不存在"),
            Some(smb::header::Status::DirectoryNotEmpty) => {
                Self(StatusCode::CONFLICT, "目录非空，请先处理其中的文件")
            }
            Some(smb::header::Status::SharingViolation) => {
                Self(StatusCode::CONFLICT, "文件正在使用中，请稍后重试")
            }
            _ => Self::expired(),
        }
    }
}
fn smb_status(e: &(dyn std::error::Error + 'static)) -> Option<u32> {
    if let Some(
        smb::Error::UnexpectedMessageStatus(code) | smb::Error::ReceivedErrorMessage(code, _),
    ) = e.downcast_ref::<smb::Error>()
    {
        return Some(*code);
    }
    if let Some(e) = e.downcast_ref::<std::io::Error>().and_then(|e| e.get_ref()) {
        return smb_status(e);
    }
    e.source().and_then(smb_status)
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn header<'a>(h: &'a HeaderMap, key: &str) -> Result<&'a str, Error> {
    h.get(key)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(Error::expired)
}
fn machine(app: &App, h: &HeaderMap) -> Result<(), Error> {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if app
        .token_hash
        .ct_eq(&Sha256::digest(token.as_bytes())[..])
        .unwrap_u8()
        != 1
    {
        return Err(Error(StatusCode::UNAUTHORIZED, "服务认证失败"));
    }
    Ok(())
}
async fn session(app: &App, h: &HeaderMap) -> Result<(Arc<Session>, OwnedMutexGuard<()>), Error> {
    machine(app, h)?;
    let key = header(h, "x-file-session")?;
    let s = app
        .sessions
        .lock()
        .await
        .get(key)
        .cloned()
        .ok_or_else(Error::expired)?;
    if s.owner != header(h, "x-file-owner")? {
        return Err(Error::expired());
    }
    let guard = s.gate.clone().lock_owned().await;
    if s.expired(app.config.idle_seconds).await {
        app.sessions.lock().await.remove(key);
        s.close().await;
        return Err(Error::expired());
    }
    let current = fingerprint(&mut *s.ldap.lock().await, &s.identity).await;
    if current.ok().as_deref() != Some(s.fingerprint.as_slice()) {
        app.sessions.lock().await.remove(key);
        s.close().await;
        return Err(Error::expired());
    }
    if let Some(value) = h.get("x-file-ttl") {
        let ttl = value
            .to_str()
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|ttl| *ttl > 0 && *ttl <= MAX_WEB_SECONDS)
            .ok_or_else(Error::invalid)?
            .min(app.config.web_session_max_seconds);
        s.lease
            .write()
            .map_err(|_| Error::expired())?
            .renew(ttl, Instant::now(), unix_now())?;
    }
    *s.touched.lock().await = Instant::now();
    Ok((s, guard))
}
async fn fingerprint(ldap: &mut Ldap, id: &Identity) -> Result<Vec<u8>> {
    // ldap3 applies this limit to the next operation, not the whole connection.
    ldap.with_timeout(Duration::from_secs(10));
    let (entries, _) = ldap
        .search(
            &id.dn,
            Scope::Base,
            "(objectClass=user)",
            vec![
                "objectGUID",
                "sAMAccountName",
                "userAccountControl",
                "pwdLastSet",
                "tokenGroups",
            ],
        )
        .await?
        .success()?;
    ensure!(entries.len() == 1, "identity missing");
    let e = SearchEntry::construct(entries.into_iter().next().unwrap());
    let raw = |k: &str| {
        e.bin_attrs
            .get(k)
            .cloned()
            .or_else(|| {
                e.attrs
                    .get(k)
                    .map(|a| a.iter().map(|v| v.as_bytes().to_vec()).collect())
            })
            .unwrap_or_default()
    };
    let guid = raw("objectGUID")
        .first()
        .map(|v| v.iter().map(|b| format!("{b:02x}")).collect::<String>())
        .unwrap_or_default();
    ensure!(guid == id.id, "identity mismatch");
    ensure!(
        e.attrs.get("sAMAccountName").and_then(|v| v.first()) == Some(&id.name),
        "identity mismatch"
    );
    let control = e
        .attrs
        .get("userAccountControl")
        .and_then(|v| v.first())
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or_else(|| anyhow::anyhow!("missing control"))?;
    ensure!(control & 2 == 0, "disabled");
    let mut hash = Sha256::new();
    for key in [
        "objectGUID",
        "userAccountControl",
        "pwdLastSet",
        "tokenGroups",
    ] {
        let mut values = raw(key);
        ensure!(!values.is_empty(), "missing security state");
        values.sort();
        for v in values {
            hash.update((v.len() as u64).to_le_bytes());
            hash.update(v);
        }
    }
    Ok(hash.finalize().to_vec())
}
async fn login(
    State(app): State<Arc<App>>,
    h: HeaderMap,
    Json(mut input): Json<Login>,
) -> Result<Json<Value>, Error> {
    machine(&app, &h)?;
    let _slot = app
        .login_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error(StatusCode::TOO_MANY_REQUESTS, "验证繁忙，请稍后重试"))?;
    if app.sessions.lock().await.len() >= 100
        || input.owner.len() != 64
        || input.password.is_empty()
        || input.password.len() > 512
        || input.shares.len() > 64
        || input.ttl == 0
    {
        return Err(Error::invalid());
    }
    if !input
        .identity
        .dn
        .to_ascii_lowercase()
        .ends_with(&format!(",{}", app.config.users_dn.to_ascii_lowercase()))
    {
        return Err(Error::invalid());
    }
    for share in &input.shares {
        paths::share(share)?;
    }
    let password = Zeroizing::new(std::mem::take(&mut input.password));
    let mut roots = rustls::RootCertStore::empty();
    let pem = std::fs::read(&app.config.ldap_ca_file).map_err(|_| Error::expired())?;
    for cert in rustls_pemfile::certs(&mut std::io::Cursor::new(pem)) {
        roots
            .add(cert.map_err(|_| Error::expired())?)
            .map_err(|_| Error::expired())?;
    }
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let settings = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(8))
        .set_config(Arc::new(tls));
    let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &app.config.ldap_url)
        .await
        .map_err(|_| Error::expired())?;
    ldap3::drive!(conn);
    ldap.with_timeout(Duration::from_secs(10));
    let valid = ldap
        .simple_bind(&input.identity.dn, &password)
        .await
        .and_then(|r| r.success());
    if valid.is_err() {
        let _ = ldap.unbind().await;
        return Err(Error(StatusCode::FORBIDDEN, "AD 密码错误或账号不可用"));
    }
    let fingerprint = fingerprint(&mut ldap, &input.identity)
        .await
        .map_err(|_| Error(StatusCode::FORBIDDEN, "关联的 AD 身份不可用"))?;
    let mut config = ClientConfig {
        dfs: false,
        ..Default::default()
    };
    config.connection.timeout = Some(Duration::from_secs(15));
    config.connection.encryption_mode = smb::connection::EncryptionMode::Required;
    config.connection.compression_enabled = false;
    let client = Client::new(config);
    let username = format!("{}\\{}", app.config.domain, input.identity.name);
    let ipc = UncPath::from_str(&format!("\\\\{}\\IPC$", app.config.smb_server))
        .map_err(|_| Error::invalid())?;
    if client
        .share_connect(&ipc, &username, password.to_string())
        .await
        .is_err()
    {
        let _ = client.close().await;
        let _ = ldap.unbind().await;
        return Err(Error(
            StatusCode::FORBIDDEN,
            "无法建立本人的 SMB 会话，请核对账号状态或文件服务连接",
        ));
    }
    let mut shares = HashSet::new();
    // No password stored in Session. Non-DFS SMB trees retain negotiated keys only.
    for share in &input.shares {
        let target = UncPath::from_str(&format!("\\\\{}\\{}", app.config.smb_server, share))
            .map_err(|_| Error::invalid())?;
        if client
            .share_connect(&target, &username, password.to_string())
            .await
            .is_ok()
            && let Ok(root) = client
                .create_file(
                    &target,
                    &FileCreateArgs::make_open_existing(
                        FileAccessMask::new().with_generic_read(true),
                    ),
                )
                .await
        {
            let _ = root.handle().close().await;
            shares.insert(share.clone());
        }
    }
    // Clear our owned input buffer after the final authentication exchange.
    drop(password);
    let ttl = input.ttl.min(if input.follow_web_session {
        app.config.web_session_max_seconds
    } else {
        app.config.lifetime_seconds
    });
    let lease = Lease::new(input.follow_web_session, ttl, Instant::now(), unix_now());
    let expires_unix = lease.expires_unix;
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let s = Arc::new(Session {
        owner: input.owner,
        client,
        identity: input.identity,
        fingerprint,
        ldap: Mutex::new(ldap),
        shares,
        lease: RwLock::new(lease),
        touched: Mutex::new(Instant::now()),
        gate: Arc::new(Mutex::new(())),
        revoked: AtomicBool::new(false),
    });
    let result = json!({"token":key,"shares":s.shares,"expiresAt":expires_unix,"maxFileBytes":app.config.max_file_bytes,"followsWebSession":input.follow_web_session});
    app.sessions.lock().await.insert(key, s);
    Ok(Json(result))
}
async fn status(State(app): State<Arc<App>>, h: HeaderMap) -> Result<Json<Value>, Error> {
    let (s, _guard) = session(&app, &h).await?;
    let lease = s.lease.read().map_err(|_| Error::expired())?;
    Ok(Json(
        json!({"shares":s.shares,"expiresAt":lease.expires_unix,"maxFileBytes":app.config.max_file_bytes,"followsWebSession":lease.follows_web}),
    ))
}
async fn logout(State(app): State<Arc<App>>, h: HeaderMap) -> Result<Json<Value>, Error> {
    machine(&app, &h)?;
    let key = header(&h, "x-file-session")?;
    let mut sessions = app.sessions.lock().await;
    if sessions
        .get(key)
        .is_some_and(|s| s.owner == header(&h, "x-file-owner").unwrap_or(""))
    {
        let s = sessions.remove(key).unwrap();
        drop(sessions);
        s.close().await;
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn run(path: &str) -> Result<()> {
    let c: Config = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(!c.listen.is_empty(), "file-only listener required");
    let listener = tokio::net::TcpListener::bind(&c.listen).await?;
    axum::serve(listener, router(c, "")?)
        .with_graceful_shutdown(crate::shutdown())
        .await?;
    Ok(())
}

pub fn router(c: Config, management_token: &str) -> Result<Router> {
    ensure!(
        c.ldap_url.starts_with("ldaps://") && !c.users_dn.is_empty(),
        "LDAPS and employee scope required"
    );
    ensure!(
        c.idle_seconds > 0
            && c.idle_seconds <= 3600
            && c.lifetime_seconds > 0
            && c.lifetime_seconds <= 3600
            && c.web_session_max_seconds > 0
            && c.web_session_max_seconds <= MAX_WEB_SECONDS
            && c.max_file_bytes <= 512 * 1024 * 1024,
        "invalid limits"
    );
    let token = std::fs::read_to_string(&c.token_file)?;
    ensure!(token.trim().len() >= 32, "service token required");
    ensure!(
        token.trim() != management_token,
        "management and employee service tokens must differ"
    );
    let app = Arc::new(App {
        config: c,
        token_hash: Sha256::digest(token.trim().as_bytes()).to_vec(),
        sessions: Mutex::new(HashMap::new()),
        login_slots: Arc::new(tokio::sync::Semaphore::new(4)),
    });
    let cleanup = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let all = cleanup
                .sessions
                .lock()
                .await
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Vec<_>>();
            for (key, s) in all {
                // A request/transfer owns this gate. Do not race its validated renewal.
                let Ok(guard) = s.gate.clone().try_lock_owned() else {
                    continue;
                };
                if s.expired(cleanup.config.idle_seconds).await {
                    cleanup.sessions.lock().await.remove(&key);
                    s.revoked.store(true, Ordering::Release);
                    tokio::spawn(async move {
                        let _guard = guard;
                        s.close().await;
                    });
                } else if s.lease.read().map(|l| l.follows_web).unwrap_or(false)
                    && s.touched.lock().await.elapsed() >= Duration::from_secs(60)
                {
                    // Keep the authenticated transports alive without retaining a
                    // password. Probes never renew the owner's application lease.
                    let app = cleanup.clone();
                    tokio::spawn(async move {
                        let _guard = guard;
                        if s.probe(&app).await.is_err() {
                            app.sessions.lock().await.remove(&key);
                            s.close().await;
                        }
                    });
                }
            }
        }
    });
    let router = Router::new()
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .route(
            "/v1/session",
            post(login)
                .get(status)
                .delete(logout)
                .layer(DefaultBodyLimit::max(32768)),
        )
        .route("/v1/list", get(transfer::list))
        .route("/v1/content", get(transfer::download).put(transfer::upload))
        .route(
            "/v1/commands",
            post(transfer::command).layer(DefaultBodyLimit::max(16384)),
        )
        .layer(DefaultBodyLimit::disable())
        .with_state(app);
    Ok(router)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_errors_preserve_acl_and_collision_semantics() {
        for (code, status) in [
            (smb::header::Status::AccessDenied, StatusCode::FORBIDDEN),
            (
                smb::header::Status::ObjectNameCollision,
                StatusCode::CONFLICT,
            ),
            (
                smb::header::Status::ObjectNameNotFound,
                StatusCode::NOT_FOUND,
            ),
            (smb::header::Status::DirectoryNotEmpty, StatusCode::CONFLICT),
        ] {
            let e = smb::Error::UnexpectedMessageStatus(code as u32);
            assert_eq!(Error::smb(e).0, status);
            let e = std::io::Error::other(smb::Error::UnexpectedMessageStatus(code as u32));
            assert_eq!(Error::smb(e).0, status);
        }
        assert_eq!(
            Error::smb(smb::Error::ConnectionStopped).0,
            StatusCode::GONE
        );
    }
}
