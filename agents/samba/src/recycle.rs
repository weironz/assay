//! Registered-share recycle bins. Retention starts when a file is first observed,
//! never at its mtime. Historical files receive a full grace period on upgrade.
use anyhow::{Result, ensure};
use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::ErrorKind,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use crate::config::{Config, Recycle};
const MAX_DEPTH: usize = 16;
const MAX_ENTRIES: usize = 100_000;

#[derive(Clone)]
pub struct Handle {
    pub settings: Arc<Mutex<Recycle>>,
    pub reload: Arc<tokio::sync::Notify>,
}

pub fn validate(settings: &Recycle) -> Result<()> {
    ensure!(
        (1..=3650).contains(&settings.retention_days),
        "retention must be between 1 and 3650 days"
    );
    ensure!(
        (1..=720).contains(&settings.every_hours),
        "cleanup interval must be between 1 and 720 hours"
    );
    Ok(())
}

pub fn load(c: &Config) -> Result<Option<Handle>> {
    let Some(defaults) = &c.recycle else {
        return Ok(None);
    };
    let path = c.state_dir.join("recycle-settings.json");
    let settings = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == ErrorKind::NotFound => defaults.clone(),
        Err(e) => return Err(e.into()),
    };
    validate(&settings)?;
    Ok(Some(Handle {
        settings: Arc::new(Mutex::new(settings)),
        reload: Arc::new(tokio::sync::Notify::new()),
    }))
}

pub fn update(c: &Config, handle: &Handle, days: u32) -> Result<Value> {
    ensure!(!c.read_only, "agent is read-only");
    let mut settings = handle.settings.lock().unwrap();
    let mut next = settings.clone();
    next.retention_days = days;
    validate(&next)?;
    crate::files::atomic(
        &c.state_dir.join("recycle-settings.json"),
        &serde_json::to_vec(&next)?,
    )?;
    *settings = next;
    handle.reload.notify_one();
    Ok(json!({"retention_days": days, "persisted": true}))
}

pub fn spawn(c: Config, handle: Handle, lock: Arc<tokio::sync::Mutex<()>>) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let settings = handle.settings.lock().unwrap().clone();
            // Serialize with restore, purge and share renames. The filesystem work
            // runs off the HTTP executor; an API timeout never cancels a sweep midway.
            let guard = lock.clone().lock_owned().await;
            let config = c.clone();
            let result = tokio::task::spawn_blocking(move || {
                let _guard = guard;
                sweep(&config, now(), settings.retention_days)
            })
            .await;
            match result {
                Ok(Ok(files)) if files > 0 => {
                    println!("recycle cleanup: removed {files} expired files")
                }
                Ok(Ok(_)) => {}
                _ => eprintln!("recycle cleanup failed; retained unprocessed files"),
            }
            tokio::select! {
                _ = handle.reload.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(3600 * settings.every_hours as u64)) => {},
            }
        }
    });
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ledger(c: &Config) -> Result<Connection> {
    let db = Connection::open(c.state_dir.join("recycle.sqlite3"))?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS entries(share TEXT NOT NULL,path TEXT NOT NULL,identity TEXT NOT NULL,first_seen INTEGER NOT NULL,PRIMARY KEY(share,path));")?;
    Ok(db)
}

// A replacement at the same path gets a new grace period, including versioned
// names reused by Samba. ctime changes conservatively extend retention.
fn identity(meta: &cap_std::fs::Metadata) -> String {
    use cap_std::fs::MetadataExt;
    format!(
        "{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.ctime(),
        meta.ctime_nsec()
    )
}
fn observed(
    db: &Connection,
    share: &str,
    path: &str,
    meta: &cap_std::fs::Metadata,
    time: u64,
) -> Result<u64> {
    db.execute("INSERT INTO entries(share,path,identity,first_seen) VALUES(?1,?2,?3,?4)
      ON CONFLICT(share,path) DO UPDATE SET identity=excluded.identity,first_seen=excluded.first_seen
      WHERE entries.identity<>excluded.identity",params![share,path,identity(meta),time])?;
    Ok(db.query_row(
        "SELECT first_seen FROM entries WHERE share=?1 AND path=?2",
        params![share, path],
        |r| r.get(0),
    )?)
}

fn share_root(c: &Config, share: &str) -> Result<(String, Dir)> {
    crate::ad::name(share)?;
    let rows = crate::files::shares(c)?;
    let row = rows
        .iter()
        .find(|r| r.name == share && r.active)
        .ok_or_else(|| anyhow::anyhow!("share is not registered"))?;
    let relative = if row.path.is_empty() {
        &row.name
    } else {
        &row.path
    };
    let root = Dir::open_ambient_dir(&c.shares_root, ambient_authority())?;
    Ok((relative.to_owned(), walk(&root, relative, false)?))
}
fn walk(root: &Dir, path: &str, create: bool) -> Result<Dir> {
    let mut dir = root.try_clone()?;
    for part in crate::files::components(path)? {
        match dir.open_dir_nofollow(part) {
            Ok(next) => dir = next,
            Err(e) if create && e.kind() == ErrorKind::NotFound => {
                match dir.create_dir(part) {
                    Ok(()) => {}
                    Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e.into()),
                }
                dir = dir.open_dir_nofollow(part)?;
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(dir)
}
fn parent(root: &Dir, path: &str, create: bool) -> Result<(Dir, String)> {
    let parts = crate::files::components(path)?;
    ensure!(
        !parts.is_empty() && !parts.contains(&".recycle"),
        "invalid recycle entry path"
    );
    let name = parts.last().unwrap().to_string();
    Ok((
        walk(root, &parts[..parts.len() - 1].join("/"), create)?,
        name,
    ))
}
fn bin(root: &Dir) -> Result<Option<Dir>> {
    match root.open_dir_nofollow(".recycle") {
        Ok(dir) => Ok(Some(dir)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    /// First observed in this bin, Unix seconds. Not the file modification date.
    pub deleted_at: u64,
    #[serde(skip)]
    identity: String,
}
fn collect(
    dir: &Dir,
    prefix: &str,
    depth: usize,
    out: &mut Vec<Entry>,
    db: &Connection,
    share: &str,
    time: u64,
) -> Result<()> {
    ensure!(
        depth <= MAX_DEPTH && out.len() < MAX_ENTRIES,
        "recycle listing limit exceeded"
    );
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid recycle filename"))?;
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let meta = dir.symlink_metadata(&name)?;
        if meta.is_dir() {
            // No symlink following, even if the entry is swapped after metadata().
            collect(
                &dir.open_dir_nofollow(&name)?,
                &path,
                depth + 1,
                out,
                db,
                share,
                time,
            )?;
        } else if meta.is_file() {
            ensure!(out.len() < MAX_ENTRIES, "recycle listing limit exceeded");
            out.push(Entry {
                deleted_at: observed(db, share, &path, &meta, time)?,
                size: meta.len(),
                identity: identity(&meta),
                path,
            });
        }
    }
    Ok(())
}
pub fn list(c: &Config, share: &str) -> Result<Vec<Entry>> {
    let (relative, root) = share_root(c, share)?;
    let mut out = vec![];
    if let Some(bin) = bin(&root)? {
        collect(&bin, "", 0, &mut out, &ledger(c)?, &relative, now())?;
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(out)
}

pub fn restore(c: &Config, share: &str, paths: &[String]) -> Result<Value> {
    operate(c, share, paths, true)
}
pub fn purge(c: &Config, share: &str, paths: &[String]) -> Result<Value> {
    operate(c, share, paths, false)
}
fn operate(c: &Config, share: &str, paths: &[String], restoring: bool) -> Result<Value> {
    ensure!(!c.read_only, "agent is read-only");
    let (_, root) = share_root(c, share)?;
    let bin = bin(&root)?.ok_or_else(|| anyhow::anyhow!("recycle bin is empty"))?;
    let mut done = vec![];
    let mut failed = vec![];
    for path in paths {
        let result = (|| -> Result<()> {
            let (source, name) = parent(&bin, path, false)?;
            ensure!(
                source.symlink_metadata(&name)?.is_file(),
                "regular recycle file required"
            );
            if restoring {
                let (target, destination) = parent(&root, path, true)?;
                // A concurrent SMB writer cannot be overwritten between an exists
                // check and rename. Unsupported kernels/filesystems fail closed.
                rustix::fs::renameat_with(
                    &source,
                    name.as_str(),
                    &target,
                    destination.as_str(),
                    rustix::fs::RenameFlags::NOREPLACE,
                )?;
            } else {
                source.remove_file(&name)?;
            }
            prune(&bin, path);
            Ok(())
        })();
        match result {
            Ok(())=>done.push(path.clone()),
            Err(_)=>failed.push(json!({"path":path,"reason":"未执行：路径不可用、已变化或原位置已有同名文件，请刷新核对"})),
        }
    }
    Ok(if restoring {
        json!({"restored":done,"failed":failed})
    } else {
        json!({"purged":done,"failed":failed})
    })
}
fn prune(root: &Dir, path: &str) {
    let mut current = Path::new(path).parent();
    while let Some(p) = current {
        let Some(p) = p.to_str().filter(|p| !p.is_empty()) else {
            break;
        };
        let Ok((dir, name)) = parent(root, p, false) else {
            break;
        };
        if dir.remove_dir(name).is_err() {
            break;
        }
        current = Path::new(p).parent();
    }
}
fn sweep(c: &Config, time: u64, days: u32) -> Result<u64> {
    ensure!(!c.read_only, "agent is read-only");
    let db = ledger(c)?;
    let cutoff = time.saturating_sub(u64::from(days) * 86400);
    let mut seen = HashSet::new();
    let mut removed = 0;
    // Never recursively discover .recycle directories in ordinary business data.
    for share in crate::files::shares(c)?.iter().filter(|s| s.active) {
        let (relative, root) = share_root(c, &share.name)?;
        if !seen.insert(relative.clone()) {
            continue;
        }
        let Some(bin) = bin(&root)? else { continue };
        let mut entries = vec![];
        collect(&bin, "", 0, &mut entries, &db, &relative, time)?;
        for entry in entries.into_iter().filter(|e| e.deleted_at < cutoff) {
            let (parent, name) = parent(&bin, &entry.path, false)?;
            let meta = parent.symlink_metadata(&name)?;
            // Replacements since the scan are retained and re-observed next time.
            if meta.is_file() && identity(&meta) == entry.identity {
                parent.remove_file(&name)?;
                db.execute(
                    "DELETE FROM entries WHERE share=?1 AND path=?2",
                    params![relative, entry.path],
                )?;
                removed += 1;
                prune(&bin, &entry.path);
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{MetadataExt, symlink};
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("assay-recycle-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn config(&self, name: &str, path: &str) -> Config {
            let c:Config=serde_json::from_value(json!({
                "listen":"127.0.0.1:0","token_file":self.0.join("token"),
                "ldap_url":"ldaps://ad:636","ldap_ca_file":self.0.join("ca"),
                "ldap_bind_dn":"CN=service,DC=assay,DC=test","ldap_password_file":self.0.join("password"),
                "base_dn":"DC=assay,DC=test","users_dn":"OU=Employees,DC=assay,DC=test",
                "groups_dn":"OU=Groups,DC=assay,DC=test","smb_server":"ad","smb_username":"ASSAY\\service",
                "shares_root":self.0.join("shares"),"config_dir":self.0.join("managed"),
                "state_dir":self.0.join("state"),"primary_gid":20000,"smb_pid_file":self.0.join("pid"),
                "recycle":{"retention_days":30,"every_hours":24}
            })).unwrap();
            c.check().unwrap();
            fs::write(
                c.config_dir.join(&c.shares_file_name),
                json!([{"name":name,"path":path,"comment":"test","groups":[],"read_only":false}])
                    .to_string(),
            )
            .unwrap();
            c
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn old_file(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"original").unwrap();
        fs::File::open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
    }
    #[test]
    fn renamed_and_nested_shares_restore_to_registered_physical_paths_without_changing_file_identity()
     {
        let f = Fixture::new();
        let c = f.config("projects", "common/scans");
        let source = c.shares_root.join("common/scans/.recycle/sub/report.txt");
        old_file(&source);
        let before = fs::metadata(&source).unwrap();
        let result = restore(&c, "projects", &["sub/report.txt".into()]).unwrap();
        assert_eq!(result["restored"], json!(["sub/report.txt"]));
        let after = fs::metadata(c.shares_root.join("common/scans/sub/report.txt")).unwrap();
        assert_eq!(before.ino(), after.ino());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        assert_eq!(before.mode(), after.mode());
        assert_eq!(before.uid(), after.uid());
        assert!(!c.shares_root.join("projects").exists());
    }
    #[test]
    fn restore_never_overwrites_a_live_file_or_symlink() {
        let f = Fixture::new();
        let c = f.config("common", "");
        let root = c.shares_root.join("common");
        old_file(&root.join(".recycle/report.txt"));
        fs::write(root.join("report.txt"), b"live").unwrap();
        assert_eq!(
            restore(&c, "common", &["report.txt".into()]).unwrap()["failed"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(fs::read(root.join("report.txt")).unwrap(), b"live");
        fs::remove_file(root.join("report.txt")).unwrap();
        symlink("missing", root.join("report.txt")).unwrap();
        assert_eq!(
            restore(&c, "common", &["report.txt".into()]).unwrap()["failed"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(root.join(".recycle/report.txt").exists());
    }
    #[test]
    fn source_destination_and_bin_symlinks_cannot_escape() {
        let f = Fixture::new();
        let c = f.config("common", "");
        let root = c.shares_root.join("common");
        let outside = f.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), b"keep").unwrap();
        fs::create_dir_all(root.join(".recycle/sub")).unwrap();
        symlink(&outside, root.join(".recycle/escape")).unwrap();
        assert_eq!(
            purge(&c, "common", &["escape/keep".into()]).unwrap()["purged"],
            json!([])
        );
        fs::write(root.join(".recycle/sub/new"), b"data").unwrap();
        symlink(&outside, root.join("sub")).unwrap();
        assert_eq!(
            restore(&c, "common", &["sub/new".into()]).unwrap()["restored"],
            json!([])
        );
        assert!(!outside.join("new").exists());
        assert!(outside.join("keep").exists());
        fs::remove_dir_all(root.join(".recycle")).unwrap();
        symlink(&outside, root.join(".recycle")).unwrap();
        assert!(list(&c, "common").is_err());
        assert!(purge(&c, "common", &["keep".into()]).is_err());
    }
    #[test]
    fn fresh_old_files_and_replacements_get_a_complete_grace_period() {
        let f = Fixture::new();
        let c = f.config("common", "");
        let file = c.shares_root.join("common/.recycle/report");
        old_file(&file);
        let time = now();
        assert_eq!(sweep(&c, time, 30).unwrap(), 0);
        assert_eq!(sweep(&c, time + 29 * 86400, 30).unwrap(), 0);
        // Replacing the path must not inherit the earlier file's expiry.
        fs::rename(&file, file.with_file_name("elsewhere")).unwrap();
        old_file(&file);
        assert_eq!(sweep(&c, time + 31 * 86400, 30).unwrap(), 0);
        assert!(file.exists());
        assert_eq!(sweep(&c, time + 62 * 86400, 30).unwrap(), 2);
        assert!(!file.exists());
    }
    #[test]
    fn sweep_ignores_unregistered_nested_recycle_folders() {
        let f = Fixture::new();
        let c = f.config("common", "");
        let ordinary = c.shares_root.join("common/project/.recycle/keep");
        old_file(&ordinary);
        assert_eq!(sweep(&c, now(), 1).unwrap(), 0);
        assert_eq!(sweep(&c, now() + 90 * 86400, 1).unwrap(), 0);
        assert!(ordinary.exists());
    }
    #[test]
    fn settings_survive_restart_without_modifying_the_read_only_deployment_config() {
        let f = Fixture::new();
        let mut c = f.config("common", "");
        let handle = load(&c).unwrap().unwrap();
        assert!(update(&c, &handle, 0).is_err());
        update(&c, &handle, 7).unwrap();
        assert_eq!(handle.settings.lock().unwrap().retention_days, 7);
        assert_eq!(
            load(&c)
                .unwrap()
                .unwrap()
                .settings
                .lock()
                .unwrap()
                .retention_days,
            7
        );
        assert_eq!(c.recycle.as_ref().unwrap().retention_days, 30);
        c.read_only = true;
        assert!(update(&c, &handle, 9).is_err());
        assert!(purge(&c, "common", &[]).is_err());
        assert!(f.0.join("shares").exists());
    }
}
