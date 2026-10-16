mod acl;
mod ad;
mod config;
mod files;
mod inheritance;
mod portal;
mod rename;
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use config::Config;
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
#[derive(Clone)]
struct App {
    c: Config,
    token: String,
    lock: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Command {
    request_id: String,
    action: String,
    args: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserCreate {
    name: String,
    display_name: String,
    password: String,
    #[serde(default)]
    profile: ad::EmployeeProfile,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserUpdate {
    id: String,
    display_name: String,
    disabled: bool,
    #[serde(default)]
    profile: ad::EmployeeProfile,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reset {
    id: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    id: String,
    old_password: String,
    password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupCreate {
    name: String,
    description: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupUpdate {
    id: String,
    description: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    group_id: String,
    user_id: String,
    add: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Members {
    group_id: String,
    user_ids: Vec<String>,
    add: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareSave {
    name: String,
    comment: String,
    groups: Vec<String>,
    read_only: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShareName {
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryPath {
    share: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    share: String,
    path: String,
    principal_id: String,
    group: bool,
    mode: String,
    inherit: bool,
    revision: String,
}
fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    Ok(serde_json::from_value(v)?)
}
async fn auth(State(a): State<App>, r: Request<axum::body::Body>, next: Next) -> Response {
    let token = r
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if bool::from(Sha256::digest(token.as_bytes()).ct_eq(&Sha256::digest(a.token.as_bytes()))) {
        next.run(r).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"machine authentication required"})),
        )
            .into_response()
    }
}
async fn snapshot(State(a): State<App>) -> Response {
    let result = async {
        let _lock = a.lock.lock().await;
        let mut d = ad::Directory::connect(&a.c).await?;
        let mut v = d.snapshot().await?;
        v["shares"] = files::call(&a.c, files::Local::List).await?;
        v["readOnly"] = json!(a.c.read_only);
        v["domain"] = json!(a.c.base_dn);
        v["renameEnabled"] = json!(a.c.rename.is_some());
        Ok::<_, anyhow::Error>(v)
    }
    .await;
    reply(result)
}
async fn directories(State(a): State<App>, Query(q): Query<DirectoryPath>) -> Response {
    reply(
        files::call(
            &a.c,
            files::Local::Directories {
                share: q.share,
                path: q.path,
            },
        )
        .await,
    )
}
async fn permissions(State(a): State<App>, Query(q): Query<DirectoryPath>) -> Response {
    reply(acl::access(&a.c, &q.share, &q.path, None).await)
}
async fn rename_preview(State(a): State<App>, Json(input): Json<rename::Request>) -> Response {
    let _guard = a.lock.lock().await;
    reply(rename::preview(&a.c, &input).await)
}
async fn execute(a: &App, cmd: &Command) -> Result<Value> {
    ensure!(!a.c.read_only, "agent is read-only");
    rename::idle(&a.c)?;
    if matches!(
        cmd.action.as_str(),
        "user.rename" | "group.rename" | "share.rename"
    ) {
        let x: rename::Request = parse(cmd.args.clone())?;
        ensure!(
            cmd.action == format!("{}.rename", x.kind),
            "rename kind does not match action"
        );
        return rename::execute(&a.c, &cmd.request_id, &x).await;
    }
    let mut d = ad::Directory::connect(&a.c).await?;
    match cmd.action.as_str() {
        "user.create" => {
            let x: UserCreate = parse(cmd.args.clone())?;
            d.create_user(&x.name, &x.display_name, &x.password, &x.profile)
                .await
        }
        "user.update" => {
            let x: UserUpdate = parse(cmd.args.clone())?;
            d.update_user(&x.id, &x.display_name, x.disabled, &x.profile)
                .await
        }
        "user.password" => {
            let x: Reset = parse(cmd.args.clone())?;
            d.reset_password(&x.id, &x.password).await
        }
        "user.change_password" => {
            let x: Change = parse(cmd.args.clone())?;
            d.change_password(&x.id, &x.old_password, &x.password).await
        }
        "group.create" => {
            let x: GroupCreate = parse(cmd.args.clone())?;
            d.create_group(&x.name, &x.description).await
        }
        "group.update" => {
            let x: GroupUpdate = parse(cmd.args.clone())?;
            d.group(&x.id, Some(&x.description), None, false).await
        }
        "group.delete" => {
            let x: Id = parse(cmd.args.clone())?;
            let group = d.object(&x.id, true).await?;
            let rows = files::call(&a.c, files::Local::List).await?;
            ensure!(
                !rows
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["groups"].as_array().is_some_and(|groups| groups
                        .iter()
                        .any(|g| g.as_str() == Some(&group.attrs["sAMAccountName"][0])))),
                "remove group from directory access lists before deleting group"
            );
            d.group(&x.id, None, None, true).await
        }
        "group.member" => {
            let x: Member = parse(cmd.args.clone())?;
            d.group(&x.group_id, None, Some((&x.user_id, x.add)), false)
                .await
        }
        "group.members" => {
            let x: Members = parse(cmd.args.clone())?;
            d.members(&x.group_id, &x.user_ids, x.add).await
        }
        "share.save" => {
            let x: ShareSave = parse(cmd.args.clone())?;
            let mut names = vec![];
            let mut sids = vec![];
            for id in &x.groups {
                let e = d.object(id, true).await?;
                names.push(e.attrs["sAMAccountName"][0].clone());
                sids.push(d.principal_sid(id, true).await?);
            }
            let rows = files::call(&a.c, files::Local::List).await?;
            ensure!(
                !rows
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["name"] == x.name && r["external"] == true),
                "existing share definition is managed by the Samba configuration"
            );
            let new = !rows
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["name"] == x.name && r["ready"] == true);
            if new {
                // New shares remain service-only until the restrictive root ACL is installed.
                files::call(
                    &a.c,
                    files::Local::Save(files::Share {
                        id: String::new(),
                        revision: String::new(),
                        name: x.name.clone(),
                        comment: x.comment.clone(),
                        groups: vec![],
                        read_only: false,
                        ready: false,
                        active: true,
                        external: false,
                        path: String::new(),
                        browseable: true,
                    }),
                )
                .await?;
                let service_sid = d.service_sid().await?;
                acl::initialize(&a.c, &x.name, &service_sid, &sids, x.read_only).await?;
            }
            files::call(
                &a.c,
                files::Local::Save(files::Share {
                    id: String::new(),
                    revision: String::new(),
                    name: x.name,
                    comment: x.comment,
                    groups: names,
                    read_only: x.read_only,
                    ready: true,
                    active: true,
                    external: false,
                    path: String::new(),
                    browseable: true,
                }),
            )
            .await
        }
        "share.remove" => {
            let x: ShareName = parse(cmd.args.clone())?;
            files::call(&a.c, files::Local::Remove { name: x.name }).await
        }
        "directory.create" => {
            let x: DirectoryPath = parse(cmd.args.clone())?;
            acl::directory(&a.c, &x.share, &x.path, false).await
        }
        "directory.delete" => {
            let x: DirectoryPath = parse(cmd.args.clone())?;
            acl::directory(&a.c, &x.share, &x.path, true).await
        }
        "acl.grant" => {
            let x: Grant = parse(cmd.args.clone())?;
            let sid = d.principal_sid(&x.principal_id, x.group).await?;
            acl::access(
                &a.c,
                &x.share,
                &x.path,
                Some((&sid, &x.mode, x.inherit, &x.revision)),
            )
            .await
        }
        _ => anyhow::bail!("unknown operation"),
    }
}
fn db(a: &App) -> Result<Connection> {
    Ok(Connection::open(a.c.state_dir.join("operations.sqlite"))?)
}
async fn command(State(a): State<App>, Json(cmd): Json<Command>) -> Response {
    let result = (|| {
        uuid::Uuid::parse_str(&cmd.request_id)?;
        ensure!(cmd.args.is_object(), "operation arguments required");
        let db = db(&a)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(a.token.as_bytes())?;
        mac.update(&serde_json::to_vec(&cmd)?);
        let hash = format!("{:x}", mac.finalize().into_bytes());
        let old: Option<(String, String, Option<String>)> = db
            .query_row(
                "SELECT hash,state,response FROM operations WHERE id=?1",
                [&cmd.request_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((h, state, response)) = old {
            ensure!(h == hash, "request ID reused with different operation");
            return Ok((
                false,
                response
                    .map(|s| serde_json::from_str(&s))
                    .transpose()?
                    .unwrap_or(json!({"request_id":cmd.request_id,"state":state})),
            ));
        }
        let queued: i64 = db.query_row(
            "SELECT COUNT(*) FROM operations WHERE state IN ('queued','running')",
            [],
            |r| r.get(0),
        )?;
        ensure!(queued < 20, "agent operation queue is full");
        db.execute(
            "INSERT INTO operations(id,hash,state) VALUES(?1,?2,'queued')",
            params![cmd.request_id, hash],
        )?;
        Ok::<_, anyhow::Error>((true, json!({"request_id":cmd.request_id,"state":"queued"})))
    })();
    match result {
        Err(e) => reply(Err(e)),
        Ok((start, response)) => {
            if start {
                tokio::spawn(async move {
                    // Independent of the HTTP connection; secrets stay in this worker's memory only.
                    let outcome = tokio::time::timeout(Duration::from_secs(300), async {
                        let _lock = a.lock.lock().await;
                        if let Ok(db) = db(&a) {
                            let _ = db.execute(
                                "UPDATE operations SET state='running' WHERE id=?1",
                                [&cmd.request_id],
                            );
                        }
                        execute(&a, &cmd).await
                    })
                    .await;
                    let value = match outcome {
                        Ok(Ok(v)) => {
                            json!({"request_id":cmd.request_id,"state":"succeeded","result":v})
                        }
                        Ok(Err(e)) => {
                            json!({"request_id":cmd.request_id,"state":if e.is::<inheritance::PartialAclUpdate>() || e.is::<rename::Pending>() || rename::pending(&a.c) {"uncertain"} else {"failed"},"error":safe_error(&e),"error_code":if rename::pending(&a.c){Some("RENAME_RECOVERY_REQUIRED")}else{error_code(&e)}})
                        }
                        Err(_) => {
                            json!({"request_id":cmd.request_id,"state":"uncertain","error":"operation timed out; inspect resource before retrying"})
                        }
                    };
                    if let Ok(db) = db(&a) {
                        let _ = db.execute(
                            "UPDATE operations SET state=?2,response=?3 WHERE id=?1",
                            params![cmd.request_id, value["state"].as_str(), value.to_string()],
                        );
                    }
                });
            }
            Json(response).into_response()
        }
    }
}
async fn operation(State(a): State<App>, Path(id): Path<String>) -> Response {
    let result = (|| {
        uuid::Uuid::parse_str(&id)?;
        let r: Option<(String, Option<String>)> = db(&a)?
            .query_row(
                "SELECT state,response FROM operations WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (state, data) = r.ok_or_else(|| anyhow::anyhow!("operation not found"))?;
        Ok(data
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or(json!({"request_id":id,"state":state})))
    })();
    reply(result)
}
fn safe_error(e: &anyhow::Error) -> String {
    if let Some(error) = e.downcast_ref::<ad::AdError>() {
        return error.to_string();
    }
    if let Some(error) = e.downcast_ref::<smb::Error>() {
        return match error {
            smb::Error::ReceivedErrorMessage(code, _)
            | smb::Error::UnexpectedMessageStatus(code) => {
                format!("SMB rejected operation (NTSTATUS 0x{code:08x})")
            }
            smb::Error::SspiError(error) => {
                format!("SMB authentication failed ({:?})", error.error_type)
            }
            _ => "SMB connection or protocol operation failed".to_owned(),
        };
    }

    let s = e.to_string();
    // Protocol libraries may include authentication payloads in diagnostics; only expose known application errors.
    if s.starts_with("AD rejected")
        || [
            "invalid ",
            "protected ",
            "managed ",
            "share ",
            "path ",
            "agent ",
            "ACL changed",
            "ACL propagation",
            "ACL scope",
            "existing directory",
            "remove group",
            "configured process",
            "null ACL",
            "password must",
            "request ID",
            "previous execution",
            "unknown operation",
        ]
        .iter()
        .any(|p| s.starts_with(p))
    {
        s
    } else {
        "operation failed; verify directory policy, resource state and connection".to_owned()
    }
}
fn error_code(e: &anyhow::Error) -> Option<&'static str> {
    if e.is::<rename::Pending>() {
        return Some("RENAME_RECOVERY_REQUIRED");
    }
    for code in [
        "RENAME_CONFLICT",
        "RENAME_PROTECTED",
        "RENAME_INVALID_NAME",
        "RENAME_NAME_EXISTS",
        "RENAME_UNCHANGED",
        "RENAME_NOT_CONFIGURED",
        "RENAME_OBJECT_NOT_FOUND",
        "RENAME_CONFIG_INVALID",
        "RENAME_CONNECTION_ACK_REQUIRED",
        "RENAME_RECOVERY_REQUIRED",
        "RENAME_ROLLED_BACK",
    ] {
        if e.to_string() == code {
            return Some(code);
        }
    }
    if let Some(error) = e.downcast_ref::<ad::AdError>() {
        return Some(error.code);
    }
    match e.downcast_ref::<ldap3::LdapError>() {
        Some(
            ldap3::LdapError::Io { .. }
            | ldap3::LdapError::Timeout { .. }
            | ldap3::LdapError::OpSend { .. }
            | ldap3::LdapError::ResultRecv { .. }
            | ldap3::LdapError::EndOfStream,
        ) => Some("AD_CONNECTION_FAILED"),
        _ => None,
    }
}
fn reply(r: Result<Value>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":safe_error(&e),"error_code":error_code(&e)})),
        )
            .into_response(),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("--files-only") {
        return portal::run(
            args.get(2)
                .map(String::as_str)
                .unwrap_or("/config/files.json"),
        )
        .await;
    }
    let c = Config::load(
        args.get(1)
            .map(String::as_str)
            .unwrap_or("/config/agent.json"),
    )?;
    if args.iter().any(|a| a == "--helper") {
        return files::helper(c).await;
    }
    let address = c.listen.clone();
    let router = router(c.clone())?;
    rename::recover(&c).await?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install termination handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = terminate.recv() => {},
    }
}

fn router(c: Config) -> Result<Router> {
    let token = config::secret(&c.token_file)?;
    ensure!(token.len() >= 32, "machine token too short");
    let employee = c
        .files
        .clone()
        .map(|files| portal::router(files, &token))
        .transpose()?;
    let a = App {
        c,
        token,
        lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    db(&a)?.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,response TEXT);")?;
    // A crash cannot safely replay an external write. Operators reconcile the resource.
    db(&a)?.execute(
        "UPDATE operations SET state='uncertain',response=NULL WHERE state IN ('queued','running')",
        [],
    )?;
    let private = Router::new()
        .route("/v1/snapshot", get(snapshot))
        .route("/v1/rename-preview", post(rename_preview))
        .route("/v1/directories", get(directories))
        .route("/v1/acl", get(permissions))
        .route("/v1/commands", post(command))
        .route("/v1/operations/{id}", get(operation))
        .route_layer(middleware::from_fn_with_state(a.clone(), auth));
    let mut router = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")})) }),
        )
        .merge(private)
        .layer(DefaultBodyLimit::max(32768))
        .with_state(a);
    if let Some(employee) = employee {
        router = router.nest("/files", employee);
    }
    Ok(router)
}

#[cfg(test)]
mod unified_tests {
    use super::*;
    use std::{fs, path::PathBuf};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("assay-unified-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("management-token"), "m".repeat(48)).unwrap();
            fs::write(root.join("employee-token"), "e".repeat(48)).unwrap();
            Self(root)
        }
        fn config(&self, files: bool) -> Config {
            let mut value = json!({
                "listen":"127.0.0.1:0", "token_file":self.0.join("management-token"),
                "ldap_url":"ldaps://ad:636", "ldap_ca_file":self.0.join("ca.crt"),
                "ldap_bind_dn":"CN=service,DC=assay,DC=test", "ldap_password_file":self.0.join("password"),
                "base_dn":"DC=assay,DC=test", "users_dn":"OU=Employees,DC=assay,DC=test",
                "groups_dn":"OU=Groups,DC=assay,DC=test", "smb_server":"ad", "smb_username":"ASSAY\\service",
                "shares_root":self.0.join("shares"), "config_dir":self.0.join("managed"),
                "state_dir":self.0.join("state"), "primary_gid":20000, "smb_pid_file":self.0.join("smbd.pid"),
                "read_only":true
            });
            if files {
                value["files"] = json!({
                    "token_file":self.0.join("employee-token"), "smb_server":"ad", "domain":"ASSAY",
                    "ldap_url":"ldaps://ad:636", "ldap_ca_file":self.0.join("ca.crt"),
                    "users_dn":"OU=Employees,DC=assay,DC=test"
                });
            }
            fs::write(
                self.0.join("agent.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            Config::load(self.0.join("agent.json").to_str().unwrap()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    async fn status(address: std::net::SocketAddr, path: &str, token: &str) -> u16 {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(response)
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn unified_listener_keeps_management_and_employee_authentication_separate() {
        let fixture = Fixture::new();
        let app = router(fixture.config(true)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert_eq!(status(address, "/health", "").await, 200);
        assert_eq!(status(address, "/files/health", "").await, 200);
        assert_eq!(status(address, "/v1/snapshot", &"e".repeat(48)).await, 401);
        assert_eq!(
            status(address, "/files/v1/list?share=qa&path=", &"m".repeat(48)).await,
            401
        );
        assert_eq!(status(address, "/v1/snapshot", "").await, 401);
        // A file service key alone cannot access a user's files without their capability.
        assert_eq!(
            status(address, "/files/v1/list?share=qa&path=", &"e".repeat(48)).await,
            410
        );
        server.abort();
    }

    #[tokio::test]
    async fn optional_files_and_distinct_service_keys_are_enforced() {
        let fixture = Fixture::new();
        let app = router(fixture.config(false)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert_eq!(status(address, "/files/health", "").await, 404);
        fs::write(fixture.0.join("employee-token"), "m".repeat(48)).unwrap();
        assert!(router(fixture.config(true)).is_err());
        server.abort();
    }

    #[tokio::test]
    async fn local_operations_need_no_helper_and_read_only_cannot_write() {
        let fixture = Fixture::new();
        let config = fixture.config(false);
        assert!(config.helper_socket.is_none());
        assert_eq!(
            files::call(&config, files::Local::List).await.unwrap(),
            json!([])
        );
        let result = files::call(
            &config,
            files::Local::Save(files::Share {
                id: String::new(),
                revision: String::new(),
                name: "qa_read_only".into(),
                comment: "test".into(),
                groups: vec![],
                read_only: false,
                ready: false,
                active: true,
                external: false,
                path: String::new(),
                browseable: true,
            }),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&config.shares_root).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&config.config_dir).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn existing_shares_keep_nested_paths_and_cannot_be_overwritten() {
        let fixture = Fixture::new();
        let mut config = fixture.config(false);
        config.read_only = false;
        config.external_samba_config_file = Some(fixture.0.join("company.conf"));
        config.external_shares_file = Some(fixture.0.join("inventory.json"));
        fs::write(fixture.0.join("company.conf"), "original config").unwrap();
        fs::create_dir_all(config.shares_root.join("common/scans/部门")).unwrap();
        let share = json!({"name":"scan","comment":"existing","groups":["dept_scan","Domain Admins"],
            "read_only":false,"active":true,"ready":true,"path":"common/scans","browseable":false});
        let inventory = json!({"config_sha256":format!("{:x}", Sha256::digest(b"original config")),"shares":[share.clone()]});
        fs::write(fixture.0.join("inventory.json"), inventory.to_string()).unwrap();
        let rows = files::call(&config, files::Local::List).await.unwrap();
        assert_eq!(rows[0]["external"], true);
        assert_eq!(rows[0]["browseable"], false);
        let listing = files::call(
            &config,
            files::Local::Directories {
                share: "scan".into(),
                path: "".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(listing["directories"], json!(["部门"]));
        assert!(
            files::call(
                &config,
                files::Local::Remove {
                    name: "scan".into()
                }
            )
            .await
            .is_err()
        );
        let mut edit: files::Share = serde_json::from_value(share).unwrap();
        edit.path.clear();
        assert!(
            files::call(&config, files::Local::Save(edit))
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("company.conf")).unwrap(),
            "original config"
        );
        assert!(
            !config
                .config_dir
                .join(&config.samba_config_file_name)
                .exists()
        );
        // A symlink inside the configured relative root cannot escape the mounted share tree.
        fs::remove_dir(config.shares_root.join("common/scans/部门")).unwrap();
        fs::remove_dir(config.shares_root.join("common/scans")).unwrap();
        std::os::unix::fs::symlink(&fixture.0, config.shares_root.join("common/scans")).unwrap();
        assert!(
            files::call(
                &config,
                files::Local::Directories {
                    share: "scan".into(),
                    path: "".into()
                }
            )
            .await
            .is_err()
        );
        fs::write(fixture.0.join("company.conf"), "external change").unwrap();
        assert!(files::call(&config, files::Local::List).await.is_err());
    }

    #[test]
    fn deployment_paths_are_configurable_but_filenames_cannot_escape() {
        let fixture = Fixture::new();
        fixture.config(false);
        let path = fixture.0.join("agent.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["shares_file_name"] = json!("registered.json");
        value["samba_config_file_name"] = json!("managed.conf");
        value["samba_shares_root"] = json!("/storage/company");
        fs::write(&path, value.to_string()).unwrap();
        let loaded = Config::load(path.to_str().unwrap()).unwrap();
        assert_eq!(loaded.shares_file_name, "registered.json");
        for bad in ["../company.conf", "/etc/samba.conf", "a\nb", ".."] {
            value["samba_config_file_name"] = json!(bad);
            fs::write(&path, value.to_string()).unwrap();
            assert!(Config::load(path.to_str().unwrap()).is_err());
        }
    }
}
