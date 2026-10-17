//! 内置回收站清理：vfs_recycle 把删除的文件保留在各共享根下的 .recycle，
//! 本模块周期性删除超过保留期的文件并回收空目录，随镜像分发。
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::Result;

use crate::config::Recycle;

/// 共享路径本身可嵌套（如 common/scans），限制 .recycle 的搜索深度
const MAX_SHARE_DEPTH: usize = 6;

struct Stats {
    files: u64,
    bytes: u64,
}

/// 独立线程执行清理循环；启动后先等一分钟避开容器启动高峰。
pub fn spawn(root: PathBuf, settings: Recycle) {
    let _ = std::thread::Builder::new()
        .name("recycle-cleanup".to_owned())
        .spawn(move || {
            let interval = Duration::from_secs(3600 * settings.every_hours.max(1) as u64);
            std::thread::sleep(Duration::from_secs(60));
            loop {
                let cutoff = SystemTime::now()
                    .checked_sub(Duration::from_secs(
                        86400 * settings.retention_days as u64,
                    ))
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                match sweep(&root, cutoff) {
                    Ok(s) if s.files > 0 => println!(
                        "recycle cleanup: removed {} files ({:.1} MiB) older than {} days",
                        s.files,
                        s.bytes as f64 / 1_048_576.0,
                        settings.retention_days
                    ),
                    Ok(_) => {}
                    Err(e) => eprintln!("recycle cleanup failed: {e:#}"),
                }
                std::thread::sleep(interval);
            }
        });
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
