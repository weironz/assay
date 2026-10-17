//! 内置回收站清理：vfs_recycle 把删除的文件保留在各共享根下的 .recycle，
//! 本模块周期性删除超过保留期的文件并回收空目录，随镜像分发。
//! 保留期可通过 /v1/recycle 端点在运行中调整（写回 agent.json）。
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{Result, ensure};
use serde_json::{Value, json};

use crate::config::Recycle;

/// 共享路径本身可嵌套（如 common/scans），限制 .recycle 的搜索深度
const MAX_SHARE_DEPTH: usize = 6;
const MIN_RETENTION_DAYS: u32 = 1;
const MAX_RETENTION_DAYS: u32 = 3650;

#[derive(Clone)]
pub struct Handle {
    pub settings: Arc<Mutex<Recycle>>,
    pub root: PathBuf,
    pub reload: Arc<tokio::sync::Notify>,
}

pub fn validate(settings: &Recycle) -> Result<()> {
    ensure!(
        (MIN_RETENTION_DAYS..=MAX_RETENTION_DAYS).contains(&settings.retention_days),
        "retention must be between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS} days"
    );
    ensure!(
        settings.every_hours >= 1 && settings.every_hours <= 24 * 30,
        "cleanup interval must be between 1 and 720 hours"
    );
    Ok(())
}

/// 后台线程执行清理循环；启动后先等一分钟避开容器启动高峰。
/// 设置变化时通过 notify 立即唤醒重读。
pub fn spawn(handle: Handle) {
    let _ = std::thread::Builder::new()
        .name("recycle-cleanup".to_owned())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .expect("recycle runtime");
            let notify = handle.reload.clone();
            rt.block_on(async move {
                let mut first = true;
                loop {
                    let (interval, cutoff) = {
                        let settings = handle.settings.lock().unwrap();
                        let interval =
                            Duration::from_secs(3600 * settings.every_hours.max(1) as u64);
                        let cutoff = SystemTime::now()
                            .checked_sub(Duration::from_secs(
                                86400 * settings.retention_days as u64,
                            ))
                            .unwrap_or(SystemTime::UNIX_EPOCH);
                        (interval, cutoff)
                    };
                    if first {
                        first = false;
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    }
                    match sweep(&handle.root, cutoff) {
                        Ok(s) if s.files > 0 => println!(
                            "recycle cleanup: removed {} files ({:.1} MiB) older than {} days",
                            s.files,
                            s.bytes as f64 / 1_048_576.0,
                            (SystemTime::now()
                                .duration_since(cutoff)
                                .map(|d| d.as_secs() / 86400)
                                .unwrap_or(0))
                        ),
                        Ok(_) => {}
                        Err(e) => eprintln!("recycle cleanup failed: {e:#}"),
                    }
                    tokio::select! {
                        _ = notify.notified() => { /* 设置变化：立即按新参数重跑 */ }
                        _ = tokio::time::sleep(interval) => {}
                    }
                }
            });
        });
}

struct Stats {
    files: u64,
    bytes: u64,
}

// ===== 管理操作：浏览 / 恢复 / 删除（走命令队列，由 API 审计） =====

/// 浏览一个共享的回收站：列出全部文件条目（相对 .recycle 的原路径、
/// 大小、删除时间）。不跟随符号链接；路径返回用 '/' 分隔供前端展示。
pub fn list(c: &crate::config::Config, share: &str) -> Result<Vec<Entry>> {
    crate::ad::name(share)?;
    let bin = bin_of(c, share)?;
    let mut out = vec![];
    if bin.exists() {
        collect(&bin, &bin, 0, &mut out)?;
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    /// Unix 秒（与前端约定；0 = 未知）
    pub deleted_at: u64,
}

fn collect(bin: &Path, dir: &Path, depth: usize, out: &mut Vec<Entry>) -> Result<()> {
    if depth > MAX_SHARE_DEPTH {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect(bin, &path, depth + 1, out)?;
        } else {
            let meta = entry.metadata()?;
            let relative = path
                .strip_prefix(bin)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if relative.is_empty() {
                continue;
            }
            out.push(Entry {
                path: relative,
                size: meta.len(),
                deleted_at: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
        }
    }
    Ok(())
}

/// 恢复：把回收站条目移回原路径（.recycle 内的相对路径即原路径）。
/// 目标已存在时拒绝（不覆盖）；恢复后回收空目录。
pub fn restore(c: &crate::config::Config, share: &str, paths: &[String]) -> Result<Value> {
    crate::ad::name(share)?;
    let bin = bin_of(c, share)?;
    let mut restored = vec![];
    let mut failed = vec![];
    for rel in paths {
        // 相对路径按共享根安全校验（组件规则与 files::components 一致）
        if crate::files::components(rel).is_err() {
            failed.push(json!({"path": rel, "reason": "无效路径"}));
            continue;
        }
        let source = bin.join(rel);
        let target = c.shares_root.join(share).join(rel);
        if !source.starts_with(&bin) || source.exists() == false {
            failed.push(json!({"path": rel, "reason": "回收站中不存在"}));
            continue;
        }
        if target.exists() {
            failed.push(json!({"path": rel, "reason": "原位置已存在同名文件"}));
            continue;
        }
        match restore_one(&source, &target) {
            Ok(()) => {
                restored.push(rel.clone());
                prune_empty(&bin, &source);
            }
            Err(e) => failed.push(json!({"path": rel, "reason": e.to_string()})),
        }
    }
    Ok(json!({"restored": restored, "failed": failed}))
}

fn restore_one(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(source, target)?;
    Ok(())
}

/// 恢复/删除后自底向上清掉 .recycle 内留下的空目录（保留 bin 根）。
fn prune_empty(bin: &Path, mut path: &Path) {
    while let Some(parent) = path.parent() {
        if parent == bin || fs::remove_dir(path).is_err() {
            return;
        }
        path = parent;
    }
}

/// 删除回收站条目（立即彻底删除，不再等保留期）。
pub fn purge(c: &crate::config::Config, share: &str, paths: &[String]) -> Result<Value> {
    crate::ad::name(share)?;
    let bin = bin_of(c, share)?;
    let mut purged = vec![];
    let mut failed = vec![];
    for rel in paths {
        if crate::files::components(rel).is_err() {
            failed.push(json!({"path": rel, "reason": "无效路径"}));
            continue;
        }
        let target = bin.join(rel);
        if !target.starts_with(&bin) || !target.exists() {
            failed.push(json!({"path": rel, "reason": "回收站中不存在"}));
            continue;
        }
        match fs::remove_file(&target) {
            Ok(()) => {
                purged.push(rel.clone());
                prune_empty(&bin, &target);
            }
            Err(e) => failed.push(json!({"path": rel, "reason": e.to_string()})),
        }
    }
    Ok(json!({"purged": purged, "failed": failed}))
}

/// 共享对应的 .recycle 路径；共享必须已注册且激活。
fn bin_of(c: &crate::config::Config, share: &str) -> Result<PathBuf> {
    let rows = crate::files::shares(c)?;
    let row = rows
        .iter()
        .find(|r| r.name == share && r.active)
        .ok_or_else(|| anyhow::anyhow!("share is not registered"))?;
    let relative = if row.path.is_empty() { &row.name } else { &row.path };
    Ok(c.shares_root.join(relative).join(".recycle"))
}

fn sweep(root: &Path, cutoff: SystemTime) -> Result<Stats> {
    let mut stats = Stats { files: 0, bytes: 0 };
    for bin in find_bins(root, 0)? {
        clean_bin(&bin, cutoff, &mut stats)?;
    }
    Ok(stats)
}

/// 定位共享根下名为 .recycle 的目录；不跟随符号链接。
fn find_bins(dir: &Path, depth: usize) -> Result<Vec<PathBuf>> {
    let mut out = vec![];
    if depth > MAX_SHARE_DEPTH {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if path.file_name().is_some_and(|n| n == ".recycle") {
            if file_type.is_dir() {
                out.push(path);
            }
            continue;
        }
        if file_type.is_dir() {
            out.extend(find_bins(&path, depth + 1)?);
        }
    }
    Ok(out)
}

/// 删除回收站内超期文件，自底向上回收空目录；.recycle 本身保留。
/// 符号链接一律跳过（既不跟随也不删除）。
fn clean_bin(bin: &Path, cutoff: SystemTime, stats: &mut Stats) -> Result<()> {
    for entry in fs::read_dir(bin)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            clean_bin(&path, cutoff, stats)?;
            if fs::read_dir(&path)?.next().is_none() {
                let _ = fs::remove_dir(&path);
            }
        } else if let Ok(meta) = entry.metadata() {
            if expired(&meta, cutoff) {
                remove(&path, &meta, stats);
            }
        }
    }
    Ok(())
}

fn expired(meta: &Metadata, cutoff: SystemTime) -> bool {
    meta.modified().map(|m| m < cutoff).unwrap_or(false)
}

fn remove(path: &Path, meta: &Metadata, stats: &mut Stats) {
    let bytes = meta.len();
    if fs::remove_file(path).is_ok() {
        stats.files += 1;
        stats.bytes += bytes;
    }
}
