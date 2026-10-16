//! Durable, compensating rename transactions. Never moves data or writes ACLs/passwords.
use crate::{
    ad::{Directory, RenamePlan},
    config::Config,
    files::{self, Share},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub main_config: PathBuf,
    pub samba_config_root: PathBuf,
    pub samba_managed_dir: PathBuf,
    pub include_file_name: String,
    pub testparm: PathBuf,
    #[serde(default)]
    pub client_address: String,
    #[serde(default)]
    pub storage_display_root: Option<PathBuf>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub kind: String,
    pub id: String,
    pub name: String,
    pub revision: String,
    #[serde(default)]
    pub acknowledge_connections: bool,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Extras {
    external: Vec<Share>,
    aliases: BTreeMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Change {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}
#[derive(Deserialize, Serialize)]
struct Journal {
    request_id: String,
    ad: Option<RenamePlan>,
    changes: Vec<Change>,
    result: Value,
    #[serde(default)]
    committed: bool,
}
#[derive(Debug)]
pub struct Pending;
impl std::fmt::Display for Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RENAME_RECOVERY_REQUIRED")
    }
}
impl std::error::Error for Pending {}
fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn extra_path(c: &Config) -> PathBuf {
    c.config_dir.join("rename-catalog.json")
}
fn journal_path(c: &Config) -> PathBuf {
    c.state_dir.join("rename-pending.json")
}
pub fn pending(c: &Config) -> bool {
    journal_path(c).exists()
}
fn extras(c: &Config) -> Result<Extras> {
    let p = extra_path(c);
    Ok(if p.exists() {
        serde_json::from_slice(&fs::read(p)?)?
    } else {
        Extras::default()
    })
}
fn settings(c: &Config) -> Result<&Settings> {
    let s = c
        .rename
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("RENAME_NOT_CONFIGURED"))?;
    ensure!(
        s.main_config.is_absolute()
            && s.samba_config_root.is_absolute()
            && s.samba_managed_dir.is_absolute()
            && s.testparm.is_absolute(),
        "invalid rename deployment paths"
    );
    ensure!(
        !s.include_file_name.is_empty()
            && s.include_file_name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            && ![".", ".."].contains(&s.include_file_name.as_str()),
        "invalid rename include filename"
    );
    let names = [
        c.shares_file_name.as_str(),
        c.samba_config_file_name.as_str(),
        s.include_file_name.as_str(),
        "rename-catalog.json",
        "external-renamed.conf",
    ];
    ensure!(
        names.iter().collect::<std::collections::HashSet<_>>().len() == names.len(),
        "rename configuration filenames must be distinct"
    );
    Ok(s)
}
pub fn idle(c: &Config) -> Result<()> {
    ensure!(!journal_path(c).exists(), "RENAME_RECOVERY_REQUIRED");
    Ok(())
}
fn share_id(s: &Share) -> String {
    digest(format!(
        "assay-share-v1:{}:{}:{}",
        s.external, s.name, s.path
    ))[..32]
        .to_owned()
}
pub fn catalog(c: &Config, mut rows: Vec<Share>) -> Result<Vec<Share>> {
    let extra = extras(c)?;
    let namespace = digest(
        [
            fs::read(c.config_dir.join(&c.shares_file_name)).unwrap_or_default(),
            fs::read(extra_path(c)).unwrap_or_default(),
        ]
        .concat(),
    );
    for row in &mut rows {
        if row.id.is_empty() {
            row.id = share_id(row);
        }
        if row.external
            && let Some(override_row) = extra.external.iter().find(|s| s.id == row.id)
        {
            ensure!(
                override_row.external && override_row.path == row.path,
                "external share identity/path changed"
            );
            *row = override_row.clone();
        }
        row.revision.clear();
        row.revision = digest(format!("{}:{namespace}", serde_json::to_string(row)?));
    }
    ensure!(
        rows.iter()
            .map(|s| s.name.to_lowercase())
            .collect::<std::collections::HashSet<_>>()
            .len()
            == rows.len(),
        "duplicate share name"
    );
    Ok(rows)
}
fn external_text(
    c: &Config,
    rows: &[Share],
    aliases: &BTreeMap<String, String>,
) -> Result<Option<String>> {
    let Some(source) = &c.external_samba_config_file else {
        return Ok(None);
    };
    let text = fs::read_to_string(source)?;
    let mut current = String::new();
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        let t = line.trim();
        if t.is_empty() || t.starts_with(['#', ';']) {
            out.push_str(line);
            continue;
        }
        if t.starts_with('[') {
            let end = t
                .find(']')
                .ok_or_else(|| anyhow::anyhow!("invalid external section"))?;
            ensure!(
                t[end + 1..].trim().is_empty() || t[end + 1..].trim().starts_with(['#', ';']),
                "unsupported external section"
            );
            current = t[1..end].to_owned();
            let original = Share {
                id: String::new(),
                revision: String::new(),
                name: current.clone(),
                comment: String::new(),
                groups: vec![],
                read_only: false,
                ready: true,
                active: true,
                external: true,
                path: String::new(),
                browseable: true,
            };
            // IDs derive from the original inventory, including its stable physical path.
            let inventory: Value =
                serde_json::from_slice(&fs::read(c.external_shares_file.as_ref().unwrap())?)?;
            let original_path = inventory["shares"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["name"] == current)
                .and_then(|r| r["path"].as_str())
                .ok_or_else(|| anyhow::anyhow!("unsupported external share section"))?;
            let original = Share {
                path: original_path.into(),
                ..original
            };
            let row = rows
                .iter()
                .find(|r| r.id == share_id(&original))
                .ok_or_else(|| anyhow::anyhow!("external share inventory mismatch"))?;
            out.push_str(&line.replacen(&format!("[{current}]"), &format!("[{}]", row.name), 1));
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_ascii_lowercase();
            ensure!(
                !["include", "copy"].contains(&key.as_str()),
                "conditional external share definitions cannot be renamed"
            );
            let domain = c.smb_username.split('\\').next().unwrap_or_default();
            let pattern = regex::Regex::new(&format!(
                r#"(?i){}\\([a-z][a-z0-9_-]*)([\s"']|$)"#,
                regex::escape(domain)
            ))?;
            let referenced = pattern
                .captures_iter(value)
                .any(|caps| aliases.keys().any(|old| old.eq_ignore_ascii_case(&caps[1])));
            if referenced {
                ensure!(
                    [
                        "valid users",
                        "invalid users",
                        "admin users",
                        "read list",
                        "write list",
                        "force group",
                        "force user"
                    ]
                    .contains(&key.as_str()),
                    "unrecognized external principal reference"
                );
            }
            let changed = if referenced {
                pattern
                    .replace_all(line, |caps: &regex::Captures<'_>| {
                        if let Some((_, new)) = aliases
                            .iter()
                            .find(|(old, _)| old.eq_ignore_ascii_case(&caps[1]))
                        {
                            format!("{domain}\\{new}{}", &caps[2])
                        } else {
                            caps[0].to_owned()
                        }
                    })
                    .into_owned()
            } else {
                line.to_owned()
            };
            out.push_str(&changed);
        } else {
            out.push_str(line)
        }
    }
    let _ = current;
    Ok(Some(out))
}
fn read_current(path: &Path) -> Result<Option<Vec<u8>>> {
    Ok(match fs::read(path) {
        Ok(v) => Some(v),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    })
}
fn change(path: PathBuf, after: Vec<u8>) -> Result<Change> {
    Ok(Change {
        before: read_current(&path)?,
        path,
        after,
    })
}
fn changes(c: &Config, rows: &[Share], extra: &Extras) -> Result<Vec<Change>> {
    let s = settings(c)?;
    let mut result = vec![];
    let managed = c.config_dir.join(&c.samba_config_file_name);
    if extra_path(c).exists() && c.external_samba_config_file.is_some() {
        let current = files::shares(c)?;
        let old = extras(c)?;
        ensure!(
            fs::read_to_string(c.config_dir.join("external-renamed.conf"))?
                == external_text(c, &current, &old.aliases)?.unwrap(),
            "external overlay changed outside Agent; reconcile manually"
        );
        let expected = format!(
            "include = {}\n[global]\ninclude = {}\n",
            s.samba_managed_dir.join("external-renamed.conf").display(),
            s.samba_managed_dir
                .join(&c.samba_config_file_name)
                .display()
        );
        ensure!(
            fs::read_to_string(c.config_dir.join(&s.include_file_name))? == expected,
            "Samba include changed outside Agent; reconcile manually"
        );
    }
    if managed.exists() {
        ensure!(
            fs::read_to_string(&managed)? == files::render(c, &files::shares(c)?)?,
            "managed config changed outside Agent; reconcile manually"
        );
    }
    result.push(change(managed, files::render(c, rows)?.into_bytes())?);
    let mut stored = rows
        .iter()
        .filter(|s| !s.external)
        .cloned()
        .collect::<Vec<_>>();
    for row in &mut stored {
        row.revision.clear()
    }
    result.push(change(
        c.config_dir.join(&c.shares_file_name),
        serde_json::to_vec(&stored)?,
    )?);
    result.push(change(extra_path(c), serde_json::to_vec(extra)?)?);
    if let Some(external) = external_text(c, rows, &extra.aliases)? {
        result.push(change(
            c.config_dir.join("external-renamed.conf"),
            external.into_bytes(),
        )?);
        let wrapper = format!(
            "include = {}\n[global]\ninclude = {}\n",
            s.samba_managed_dir.join("external-renamed.conf").display(),
            s.samba_managed_dir
                .join(&c.samba_config_file_name)
                .display()
        );
        result.push(change(
            c.config_dir.join(&s.include_file_name),
            wrapper.into_bytes(),
        )?);
    }
    validate(c, &result)?;
    Ok(result)
}
fn local_path(c: &Config, p: &Path) -> Result<PathBuf> {
    let s = settings(c)?;
    ensure!(
        !p.components()
            .any(|p| matches!(p, std::path::Component::ParentDir)),
        "unsafe Samba include path"
    );
    if let Ok(v) = p.strip_prefix(&s.samba_managed_dir) {
        return Ok(c.config_dir.join(v));
    }
    if let Ok(v) = p.strip_prefix(&s.samba_config_root) {
        return Ok(s.main_config.parent().unwrap().join(v));
    }
    anyhow::bail!("unsupported Samba include path")
}
fn flattened(c: &Config, p: &Path, changes: &[Change], seen: &mut Vec<PathBuf>) -> Result<String> {
    ensure!(
        seen.len() < 16 && !seen.contains(&p.to_owned()),
        "recursive Samba include"
    );
    seen.push(p.to_owned());
    let text = if let Some(v) = changes.iter().find(|v| v.path == p) {
        String::from_utf8(v.after.clone())?
    } else {
        fs::read_to_string(p)?
    };
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        if let Some((k, v)) = line.split_once('=')
            && k.trim().eq_ignore_ascii_case("include")
        {
            out.push_str(&flattened(
                c,
                &local_path(c, Path::new(v.trim()))?,
                changes,
                seen,
            )?);
            out.push('\n');
            continue;
        }
        out.push_str(line)
    }
    seen.pop();
    Ok(out)
}
fn validate(c: &Config, changes: &[Change]) -> Result<()> {
    let s = settings(c)?;
    let content = flattened(c, &s.main_config, changes, &mut vec![])?;
    let path = c
        .state_dir
        .join(format!("validate-{}.conf", uuid::Uuid::new_v4()));
    files::atomic(&path, content.as_bytes())?;
    let result = Command::new(&s.testparm)
        .args(["--suppress-prompt"])
        .arg(&path)
        .stdin(Stdio::null())
        .output();
    let _ = fs::remove_file(path);
    ensure!(
        result.is_ok_and(|r| r.status.success()),
        "RENAME_CONFIG_INVALID"
    );
    Ok(())
}
pub fn reload(c: &Config) -> Result<()> {
    let master = files::reload_pid(c)?;
    ensure!(master > 1, "invalid smbd process");
    // Refresh existing SMB workers as well as the master; never disconnect a file handle.
    for e in fs::read_dir("/proc")? {
        let e = e?;
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if pid <= 1 {
            continue;
        }
        if fs::read_to_string(e.path().join("comm"))
            .unwrap_or_default()
            .trim()
            .starts_with("smbd")
        {
            match nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGHUP,
            ) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}
fn apply(changes: &[Change], forward: bool) -> Result<()> {
    let ordered: Vec<_> = if forward {
        changes.iter().collect()
    } else {
        changes.iter().rev().collect()
    };
    for c in &ordered {
        let current = read_current(&c.path)?;
        ensure!(
            current == c.before || current.as_deref() == Some(c.after.as_slice()),
            "RENAME_CONFLICT"
        );
    }
    for c in ordered {
        let current = read_current(&c.path)?;
        let next = if forward {
            Some(c.after.clone())
        } else {
            c.before.clone()
        };
        ensure!(
            current == c.before || current.as_deref() == Some(c.after.as_slice()),
            "RENAME_CONFLICT"
        );
        if current == next {
            continue;
        }
        if let Some(bytes) = next {
            files::atomic(&c.path, &bytes)?
        } else {
            fs::remove_file(&c.path)?;
        }
    }
    Ok(())
}
pub fn save_catalog(c: &Config, rows: &[Share]) -> Result<()> {
    idle(c)?;
    let mut extra = extras(c)?;
    extra.external = rows
        .iter()
        .filter(|r| r.external)
        .cloned()
        .map(|mut r| {
            r.revision.clear();
            r
        })
        .collect();
    let changes = changes(c, rows, &extra)?;
    let journal = Journal {
        request_id: String::new(),
        ad: None,
        changes: changes.clone(),
        result: Value::Null,
        committed: false,
    };
    files::atomic(&journal_path(c), &serde_json::to_vec(&journal)?)?;
    // Ordinary metadata saves also compensate partial filesystem publication.
    if let Err(e) = apply(&changes, true).and_then(|_| reload(c)) {
        if apply(&changes, false).and_then(|_| reload(c)).is_err() {
            return Err(Pending.into());
        }
        fs::remove_file(journal_path(c))?;
        return Err(e);
    }
    fs::remove_file(journal_path(c))?;
    Ok(())
}
fn connections() -> usize {
    ["/proc/net/tcp", "/proc/net/tcp6"]
        .iter()
        .filter_map(|p| fs::read_to_string(p).ok())
        .flat_map(|t| t.lines().map(str::to_owned).collect::<Vec<_>>())
        .filter(|line| {
            let v = line.split_whitespace().collect::<Vec<_>>();
            v.len() > 3 && v[1].ends_with(":01BD") && v[3] == "01"
        })
        .count()
}
async fn plan(c: &Config, r: &Request) -> Result<(Option<RenamePlan>, Vec<Share>, Extras, Value)> {
    idle(c)?;
    settings(c)?;
    ensure!(!c.read_only, "agent is read-only");
    ensure!(crate::ad::name(&r.name).is_ok(), "RENAME_INVALID_NAME");
    let mut rows = files::shares(c)?;
    let mut extra = extras(c)?;
    let mut ad = None;
    let old_name;
    match r.kind.as_str() {
        "user" | "group" => {
            let mut d = Directory::connect(c).await?;
            let p = d
                .rename_plan(&r.id, r.kind == "group", &r.name, &r.revision)
                .await?;
            old_name = p.old_name.clone();
            for row in &mut rows {
                for group in &mut row.groups {
                    if group.eq_ignore_ascii_case(&old_name) {
                        ensure!(row.name != "scan", "RENAME_PROTECTED");
                        *group = r.name.clone()
                    }
                }
            }
            for alias in extra.aliases.values_mut() {
                if alias.eq_ignore_ascii_case(&old_name) {
                    *alias = r.name.clone()
                }
            }
            extra
                .aliases
                .entry(old_name.clone())
                .or_insert_with(|| r.name.clone());
            ad = Some(p);
        }
        "share" => {
            ensure!(
                ![
                    "global", "homes", "ipc$", "scan", "sysvol", "netlogon", "printers", "print$"
                ]
                .contains(&r.name.as_str()),
                "RENAME_PROTECTED"
            );
            ensure!(
                !rows.iter().any(|s| s.name.eq_ignore_ascii_case(&r.name)),
                "RENAME_NAME_EXISTS"
            );
            let row = rows
                .iter_mut()
                .find(|s| s.id == r.id)
                .ok_or_else(|| anyhow::anyhow!("RENAME_OBJECT_NOT_FOUND"))?;
            ensure!(row.revision == r.revision, "RENAME_CONFLICT");
            ensure!(
                ![
                    "global", "homes", "ipc$", "scan", "sysvol", "netlogon", "printers", "print$"
                ]
                .contains(&row.name.as_str()),
                "RENAME_PROTECTED"
            );
            ensure!(row.active, "inactive share cannot be renamed");
            crate::ad::name(&row.name)?;
            old_name = row.name.clone();
            if row.path.is_empty() {
                row.path = row.name.clone()
            }
            row.name = r.name.clone();
        }
        _ => anyhow::bail!("unknown rename kind"),
    }
    extra.external = rows
        .iter()
        .filter(|r| r.external)
        .cloned()
        .map(|mut r| {
            r.revision.clear();
            r
        })
        .collect();
    let changes = changes(c, &rows, &extra)?;
    let active = connections();
    let preview = json!({"kind":r.kind,"id":r.id,"oldName":old_name,"newName":r.name,"physicalPathUnchanged":true,"cnDnUnchanged":true,"passwordUnchanged":true,"activeSmbConnections":active,"requiresConnectionAcknowledgement":active>0,"affectedShares":rows.iter().filter(|s|s.groups.iter().any(|g|g==&r.name)|| (r.kind=="share"&&s.id==r.id)).map(|s|json!({"id":s.id,"name":s.name,"path":if s.path.is_empty(){&s.name}else{&s.path}})).collect::<Vec<_>>(),"revision":r.revision,"validatedConfig":true});
    let _ = changes;
    let mut preview = preview;
    preview["domain"] = json!(c.base_dn);
    let settings = settings(c)?;
    let server = if settings.client_address.is_empty() {
        &c.smb_server
    } else {
        &settings.client_address
    };
    preview["oldAddress"] = json!(format!("\\\\{server}\\{old_name}"));
    preview["newAddress"] = json!(format!("\\\\{server}\\{}", r.name));
    let display_root = settings
        .storage_display_root
        .as_ref()
        .unwrap_or(&c.samba_shares_root);
    for share in preview["affectedShares"].as_array_mut().unwrap() {
        share["path"] = json!(
            display_root
                .join(share["path"].as_str().unwrap())
                .display()
                .to_string()
        )
    }
    Ok((ad, rows, extra, preview))
}
pub async fn preview(c: &Config, r: &Request) -> Result<Value> {
    Ok(plan(c, r).await?.3)
}
pub async fn execute(c: &Config, id: &str, r: &Request) -> Result<Value> {
    let (ad, rows, extra, mut result) = plan(c, r).await?;
    ensure!(
        r.acknowledge_connections || result["activeSmbConnections"] == 0,
        "RENAME_CONNECTION_ACK_REQUIRED"
    );
    let changes = changes(c, &rows, &extra)?;
    result["account"] = ad.as_ref().map(|p| p.before.clone()).unwrap_or(Value::Null);
    if let Some(p) = &ad {
        result["sid"] = p.before["sid"].clone();
        result["newUpn"] = json!(p.new_upn)
    }
    let mut journal = Journal {
        request_id: id.into(),
        ad,
        changes,
        result: result.clone(),
        committed: false,
    };
    files::atomic(&journal_path(c), &serde_json::to_vec(&journal)?)?;
    let mut ad_applied = false;
    let outcome = async {
        if let Some(p) = &journal.ad {
            Directory::connect(c).await?.apply_rename(p, true).await?;
            ad_applied = true;
        }
        apply(&journal.changes, true)?;
        reload(c)?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(e) = outcome {
        if compensate(c, &journal).await.is_err() {
            return Err(Pending.into());
        }
        fs::remove_file(journal_path(c))?;
        if ad_applied {
            anyhow::bail!("RENAME_ROLLED_BACK")
        }
        return Err(e);
    }
    journal.committed = true;
    files::atomic(&journal_path(c), &serde_json::to_vec(&journal)?)?;
    // Keep the outcome durable before removing the recovery fence.
    let db = rusqlite::Connection::open(c.state_dir.join("operations.sqlite"))?;
    let response = json!({"request_id":id,"state":"succeeded","result":result});
    db.execute(
        "UPDATE operations SET state='succeeded',response=?2 WHERE id=?1",
        rusqlite::params![id, response.to_string()],
    )?;
    fs::remove_file(journal_path(c))?;
    Ok(result)
}
async fn compensate(c: &Config, j: &Journal) -> Result<()> {
    compensate_using(c, j, reload).await
}
async fn compensate_using(c: &Config, j: &Journal, load: fn(&Config) -> Result<()>) -> Result<()> {
    apply(&j.changes, false)?;
    if let Some(p) = &j.ad {
        Directory::connect(c).await?.apply_rename(p, false).await?;
    }
    load(c)?;
    Ok(())
}
pub async fn recover(c: &Config) -> Result<()> {
    recover_using(c, reload).await
}
async fn recover_using(c: &Config, load: fn(&Config) -> Result<()>) -> Result<()> {
    let path = journal_path(c);
    if !path.exists() {
        return Ok(());
    }
    let j: Journal = serde_json::from_slice(&fs::read(&path)?)?;
    let db = rusqlite::Connection::open(c.state_dir.join("operations.sqlite"))?;
    let state: Option<String> = db
        .query_row(
            "SELECT state FROM operations WHERE id=?1",
            [&j.request_id],
            |r| r.get(0),
        )
        .ok();
    if j.committed || state.as_deref() == Some("succeeded") {
        ensure!(
            j.changes
                .iter()
                .all(|v| fs::read(&v.path).ok().as_deref() == Some(v.after.as_slice())),
            "RENAME_RECOVERY_REQUIRED"
        );
        load(c)?;
        let response = json!({"request_id":j.request_id,"state":"succeeded","result":j.result});
        db.execute(
            "UPDATE operations SET state='succeeded',response=?2 WHERE id=?1",
            rusqlite::params![j.request_id, response.to_string()],
        )?;
    } else {
        compensate_using(c, &j, load).await?;
        let response = json!({"request_id":j.request_id,"state":"failed","error_code":"RENAME_ROLLED_BACK","error":"Rename was rolled back after interruption"});
        db.execute(
            "UPDATE operations SET state='failed',response=?2 WHERE id=?1",
            rusqlite::params![j.request_id, response.to_string()],
        )?;
    }
    fs::remove_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        c: Config,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("assay-rename-{}", uuid::Uuid::new_v4()));
            for dir in ["managed", "state", "etc", "data"] {
                fs::create_dir_all(root.join(dir)).unwrap()
            }
            let c:Config=serde_json::from_value(json!({"listen":"127.0.0.1:0","token_file":root.join("token"),"ldap_url":"ldaps://ad","ldap_ca_file":root.join("ca"),"ldap_bind_dn":"CN=svc,DC=example,DC=test","ldap_password_file":root.join("secret"),"base_dn":"DC=example,DC=test","users_dn":"OU=Employees,DC=example,DC=test","groups_dn":"OU=Groups,DC=example,DC=test","smb_server":"ad","smb_username":"EXAMPLE\\svc","shares_root":root.join("data"),"config_dir":root.join("managed"),"state_dir":root.join("state"),"primary_gid":20000,"smb_pid_file":root.join("pid"),"rename":{"main_config":root.join("etc/smb.conf"),"samba_config_root":"/etc/samba","samba_managed_dir":"/managed","include_file_name":"include.conf","testparm":"/bin/true"}})).unwrap();
            Self { root, c }
        }
        fn external(&mut self, text: &str) {
            let source = self.root.join("etc/company.conf");
            fs::write(&source, text).unwrap();
            let inventory = self.root.join("inventory.json");
            fs::write(&inventory,serde_json::to_vec(&json!({"config_sha256":digest(text),"shares":[{"name":"common","comment":"preserve","groups":["alpha"],"read_only":false,"ready":true,"active":true,"path":"common","browseable":false}]})).unwrap()).unwrap();
            self.c.external_samba_config_file = Some(source);
            self.c.external_shares_file = Some(inventory);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn principal_references_are_token_aware_and_never_cascade_or_modify_data_paths() {
        let mut f = Fixture::new();
        let text = "[common] # retained\npath = /shares/alpha\ncomment = alpha remains a description\nbrowseable = no\nvalid users = @\"EXAMPLE\\alpha\" @\"EXAMPLE\\beta\" @\"EXAMPLE\\alpha_extra\"\nadmin users = \"EXAMPLE\\svc\"\n";
        f.external(text);
        let rows = files::shares(&f.c).unwrap();
        let aliases = BTreeMap::from([
            ("alpha".into(), "beta".into()),
            ("beta".into(), "gamma".into()),
        ]);
        let changed = external_text(&f.c, &rows, &aliases).unwrap().unwrap();
        assert!(
            changed.contains("@\"EXAMPLE\\beta\" @\"EXAMPLE\\gamma\" @\"EXAMPLE\\alpha_extra\"")
        );
        assert!(changed.contains(
            "path = /shares/alpha\ncomment = alpha remains a description\nbrowseable = no"
        ));
        assert!(changed.contains("admin users = \"EXAMPLE\\svc\""));
    }
    #[test]
    fn external_rename_keeps_stable_id_physical_path_and_all_unrelated_lines() {
        let mut f = Fixture::new();
        let text = "[common]\npath = /shares/common\nvalid users = @\"EXAMPLE\\alpha\"\nread only = no\nbrowseable = no\n";
        f.external(text);
        let mut rows = files::shares(&f.c).unwrap();
        let id = rows[0].id.clone();
        rows[0].name = "projects".into();
        let extra = Extras {
            external: rows.clone(),
            aliases: BTreeMap::new(),
        };
        fs::write(extra_path(&f.c), serde_json::to_vec(&extra).unwrap()).unwrap();
        let current = files::shares(&f.c).unwrap();
        assert_eq!(current[0].id, id);
        assert_eq!(current[0].path, "common");
        assert!(!current[0].browseable);
        assert_eq!(
            external_text(&f.c, &current, &extra.aliases)
                .unwrap()
                .unwrap(),
            text.replacen("[common]", "[projects]", 1)
        );
        assert_eq!(
            fs::read_to_string(f.c.external_samba_config_file.as_ref().unwrap()).unwrap(),
            text
        );
    }
    #[test]
    fn compensation_restores_our_bytes_but_never_overwrites_a_concurrent_operator_edit() {
        let f = Fixture::new();
        let a = f.root.join("managed/a");
        let b = f.root.join("managed/b");
        fs::write(&a, b"before").unwrap();
        let changes = vec![
            change(a.clone(), b"after".to_vec()).unwrap(),
            change(b.clone(), b"new".to_vec()).unwrap(),
        ];
        apply(&changes, true).unwrap();
        apply(&changes, false).unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"before");
        assert!(!b.exists());
        apply(&changes, true).unwrap();
        fs::write(&a, b"operator edit").unwrap();
        assert!(apply(&changes, false).is_err());
        assert_eq!(fs::read(&a).unwrap(), b"operator edit");
    }
    #[test]
    fn namespace_revisions_detect_other_share_edits_and_pending_journal_fences_writes() {
        let mut f = Fixture::new();
        f.external("[common]\npath = /shares/common\nvalid users = @\"EXAMPLE\\alpha\"\n");
        let before = files::shares(&f.c).unwrap();
        fs::write(f.c.config_dir.join(&f.c.shares_file_name), b"[]\n").unwrap();
        let after = files::shares(&f.c).unwrap();
        assert_eq!(before[0].id, after[0].id);
        assert_ne!(before[0].revision, after[0].revision);
        assert!(idle(&f.c).is_ok());
        fs::write(journal_path(&f.c), b"{}").unwrap();
        assert!(idle(&f.c).is_err());
    }
    #[test]
    fn escaping_config_includes_and_unknown_principal_directives_fail_closed() {
        let mut f = Fixture::new();
        assert!(local_path(&f.c, Path::new("/etc/samba/../../etc/passwd")).is_err());
        assert!(local_path(&f.c, Path::new("/unmanaged/a")).is_err());
        f.external("[common]\npath = /shares/common\ncustom permission = EXAMPLE\\alpha\n");
        let rows = files::shares(&f.c).unwrap();
        assert!(
            external_text(
                &f.c,
                &rows,
                &BTreeMap::from([("alpha".into(), "beta".into())])
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn interrupted_filesystem_publication_rolls_back_while_committed_publication_finishes_once()
     {
        for committed in [false, true] {
            let f = Fixture::new();
            let target = f.root.join("managed/config");
            fs::write(&target, b"before").unwrap();
            let changes = vec![
                change(target.clone(), b"after".to_vec()).unwrap(),
                change(f.root.join("managed/new"), b"new".to_vec()).unwrap(),
            ];
            let db = rusqlite::Connection::open(f.c.state_dir.join("operations.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE operations(id TEXT PRIMARY KEY,state TEXT,response TEXT); INSERT INTO operations(id,state) VALUES('qa-operation','uncertain');").unwrap();
            let journal = Journal {
                request_id: "qa-operation".into(),
                ad: None,
                changes: changes.clone(),
                result: json!({"verified":"qa"}),
                committed,
            };
            files::atomic(&journal_path(&f.c), &serde_json::to_vec(&journal).unwrap()).unwrap();
            apply(if committed { &changes } else { &changes[..1] }, true).unwrap();
            recover_using(&f.c, |_| Ok(())).await.unwrap();
            assert!(!pending(&f.c));
            assert_eq!(
                fs::read(&target).unwrap(),
                if committed {
                    b"after".to_vec()
                } else {
                    b"before".to_vec()
                }
            );
            let (state, response): (String, String) = db
                .query_row(
                    "SELECT state,response FROM operations WHERE id='qa-operation'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(state, if committed { "succeeded" } else { "failed" });
            let response: Value = serde_json::from_str(&response).unwrap();
            if committed {
                assert_eq!(response["result"], journal.result)
            } else {
                assert_eq!(response["error_code"], "RENAME_ROLLED_BACK")
            }
            recover_using(&f.c, |_| Ok(())).await.unwrap();
        }
    }
    #[tokio::test]
    async fn recovery_keeps_its_fence_and_preserves_a_third_party_edit() {
        let f = Fixture::new();
        let target = f.root.join("managed/config");
        fs::write(&target, b"before").unwrap();
        let changes = vec![change(target.clone(), b"after".to_vec()).unwrap()];
        let db = rusqlite::Connection::open(f.c.state_dir.join("operations.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE operations(id TEXT PRIMARY KEY,state TEXT,response TEXT);")
            .unwrap();
        files::atomic(
            &journal_path(&f.c),
            &serde_json::to_vec(&Journal {
                request_id: "interrupted".into(),
                ad: None,
                changes,
                result: Value::Null,
                committed: false,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(&target, b"operator version").unwrap();
        assert!(recover_using(&f.c, |_| Ok(())).await.is_err());
        assert!(pending(&f.c));
        assert_eq!(fs::read(&target).unwrap(), b"operator version");
    }
}
