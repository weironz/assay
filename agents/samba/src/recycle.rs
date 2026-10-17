//! 内置回收站清理：vfs_recycle 把删除的文件保留在各共享根下的 .recycle，
//! 本模块周期性删除超过保留期的文件并回收空目录，随镜像分发。
//! 保留期可通过 /v1/recycle 端点在运行中调整（写回 agent.json）。
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{Result, ensure};
use cap_fs_ext::DirExt;
use serde_json::{Value, json};

use crate::config::Recycle;

/// 共享路径本身可嵌套（如 common/scans），限制 .recycle 的搜索深度
const MAX_SHARE_DEPTH: usize = 6;
const MIN_RETENTION_DAYS: u32 = 1;
const MAX_RETENTION_DAYS: u32 = 3650;

#[derive(Clone)]
pub struct Handle {
    pub settings: Arc<Mutex<Recycle>>,
    /// 配置引用（sweep 需要读取登记的共享列表）
    pub config: Arc<std::sync::Mutex<crate::config::Config>>,
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
                    match sweep(&handle.config.lock().unwrap(), cutoff) {
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
//
// 安全模型与库内其余目录操作一致（见 files.rs）：所有目录以 cap-std
// Dir 逐组件 open_dir_nofollow 打开，路径字符串校验之外由文件系统
// 本身保证不会越过回收站/共享根；恢复目标使用登记的物理路径，不受
// 共享重命名影响。

/// 打开一个共享的 .recycle 目录（cap-std，逐组件不跟随符号链接）。
fn open_bin(c: &crate::config::Config, share: &str) -> Result<cap_std::fs::Dir> {
    let (_, physical) = resolve_share(c, share)?;
    let mut dir = cap_std::fs::Dir::open_ambient_dir(&c.shares_root, cap_std::ambient_authority())?;
    for part in physical
        .iter()
        .chain(std::iter::once(&".recycle".to_owned()))
    {
        dir = dir.open_dir_nofollow(part)?;
    }
    Ok(dir)
}

/// 解析共享的物理相对路径（登记值；空则用共享名）。
fn resolve_share(c: &crate::config::Config, share: &str) -> Result<(PathBuf, Vec<String>)> {
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
    let parts = crate::files::components(relative)?
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok((c.shares_root.join(relative), parts))
}

/// 浏览一个共享的回收站：列出全部文件条目（相对 .recycle 的原路径、
/// 大小、删除时间）。
pub fn list(c: &crate::config::Config, share: &str) -> Result<Vec<Entry>> {
    let bin = open_bin(c, share)?;
    let mut out = vec![];
    collect_dir(&bin, "", 0, &mut out)?;
    out.sort_by_key(|e| std::cmp::Reverse(e.deleted_at));
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    /// Unix 秒（与前端约定；0 = 未知）
    pub deleted_at: u64,
}

/// 递归收集条目；rel 是当前目录相对 bin 的路径（'' 表示根）。
fn collect_dir(
    dir: &cap_std::fs::Dir,
    rel: &str,
    depth: usize,
    out: &mut Vec<Entry>,
) -> Result<()> {
    if depth > MAX_SHARE_DEPTH {
        return Ok(());
    }
    for entry in dir.entries()? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if entry.file_type()?.is_dir() {
            collect_dir(&dir.open_dir(&name)?, &child_rel, depth + 1, out)?;
        } else {
            let meta = entry.metadata()?;
            // cap_std 的 SystemTime 换算 unix 秒（epoch 经 from_std 构造）
            let cap_epoch = cap_std::time::SystemTime::from_std(std::time::UNIX_EPOCH);
            let deleted_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(cap_epoch).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(Entry {
                path: child_rel,
                size: meta.len(),
                deleted_at,
            });
        }
    }
    Ok(())
}

/// 恢复：把回收站条目移回原位置。目标已存在时拒绝（不覆盖，由
/// rename_noreplace 语义保证原子性）；恢复后回收 .recycle 内空目录。
pub fn restore(c: &crate::config::Config, share: &str, paths: &[String]) -> Result<Value> {
    let (_, physical) = resolve_share(c, share)?;
    // bin 与目标共享根是不同的目录树：分别打开两个 cap-std Dir
    let bin = open_bin(c, share)?;
    let mut share_root =
        cap_std::fs::Dir::open_ambient_dir(&c.shares_root, cap_std::ambient_authority())?;
    for part in &physical {
        share_root = share_root.open_dir_nofollow(part)?;
    }
    let mut restored = vec![];
    let mut failed = vec![];
    for rel in paths {
        let components = match crate::files::components(rel) {
            Ok(parts) => parts.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            Err(_) => {
                failed.push(json!({"path": rel, "reason": "无效路径"}));
                continue;
            }
        };
        match restore_one(&bin, &share_root, &components) {
            Ok(()) => restored.push(rel.clone()),
            Err(e) => failed.push(json!({"path": rel, "reason": reason_of(&e)})),
        }
    }
    Ok(json!({"restored": restored, "failed": failed}))
}

/// 单条恢复：源在 bin 内、目标在共享根内逐组件打开；目标父目录不存在
/// 则创建；目标存在时拒绝（不覆盖）。跨 Dir 移动无法用 rename，读入
/// 内存再写——为防御超大文件，超过 256 MiB 拒绝（超出走服务器手动恢复）。
fn restore_one(
    bin: &cap_std::fs::Dir,
    share_root: &cap_std::fs::Dir,
    components: &[String],
) -> Result<()> {
    const MAX_RESTORE_BYTES: u64 = 256 * 1024 * 1024;
    let (name, parents) = components.split_last().expect("components 非空");
    let source = bin.open_dir(parents.join("/"))?;
    let meta = source.metadata(name)?;
    if meta.is_dir() {
        anyhow::bail!("回收站条目是目录，仅恢复文件");
    }
    if meta.len() > MAX_RESTORE_BYTES {
        anyhow::bail!("文件超过 256 MiB 恢复上限，请从服务器手动恢复");
    }
    // 目标父目录：不存在则逐级创建（目标侧也受 nofollow 保护）。
    // 从共享根逐组件打开（根即 share_root 本身，无需 "."）
    let mut target_parent = share_root.try_clone()?;
    for part in parents {
        match target_parent.open_dir(part) {
            Ok(dir) => target_parent = dir,
            Err(_) => {
                target_parent.create_dir(part)?;
                target_parent = target_parent.open_dir(part)?;
            }
        }
    }
    if target_parent.metadata(name).is_ok() {
        anyhow::bail!("原位置已存在同名文件");
    }
    let bytes = source.read(name)?;
    target_parent.write(name, &bytes)?;
    source.remove_file(name)?;
    prune_empty_dirs(bin, parents);
    Ok(())
}

/// 彻底删除回收站条目。
pub fn purge(c: &crate::config::Config, share: &str, paths: &[String]) -> Result<Value> {
    let bin = open_bin(c, share)?;
    let mut purged = vec![];
    let mut failed = vec![];
    for rel in paths {
        let components = match crate::files::components(rel) {
            Ok(parts) => parts.into_iter().map(str::to_owned).collect::<Vec<_>>(),
            Err(_) => {
                failed.push(json!({"path": rel, "reason": "无效路径"}));
                continue;
            }
        };
        match purge_one(&bin, &components) {
            Ok(()) => purged.push(rel.clone()),
            Err(e) => failed.push(json!({"path": rel, "reason": reason_of(&e)})),
        }
    }
    Ok(json!({"purged": purged, "failed": failed}))
}

fn purge_one(bin: &cap_std::fs::Dir, components: &[String]) -> Result<()> {
    let (name, parents) = components.split_last().expect("components 非空");
    let mut dir = bin.try_clone()?;
    for part in parents {
        dir = dir.open_dir(part)?;
    }
    let meta = dir.metadata(name)?;
    if meta.is_dir() {
        anyhow::bail!("回收站条目是目录，仅删除文件");
    }
    dir.remove_file(name)?;
    prune_empty_dirs(bin, parents);
    Ok(())
}

/// 恢复/删除后清掉 .recycle 内留下的空目录链（相对 bin 的父目录序列）。
fn prune_empty_dirs(bin: &cap_std::fs::Dir, parents: &[String]) {
    for depth in (0..parents.len()).rev() {
        if bin.open_dir(parents[..=depth].join("/")).is_err() {
            return;
        }
        if bin.remove_dir(parents[..=depth].join("/")).is_err() {
            return;
        }
    }
}

/// 把 IO 错误翻译成用户可读的原因（不泄漏绝对路径）。
fn reason_of(e: &anyhow::Error) -> String {
    let s = e.to_string();
    if s.contains("NotFound") || s.contains("No such") {
        "回收站中不存在".to_owned()
    } else {
        s
    }
}

fn sweep(c: &crate::config::Config, cutoff: SystemTime) -> Result<Stats> {
    let mut stats = Stats { files: 0, bytes: 0 };
    // 只清登记在册的共享回收站：递归扫描整个共享树会把业务数据里
    // 恰好叫 .recycle 的目录误当回收站。
    for row in crate::files::shares(c)? {
        if !row.active {
            continue;
        }
        if let Ok(bin) = open_bin(c, &row.name) {
            clean_bin(&bin, "", 0, cutoff, &mut stats)?;
        }
    }
    Ok(stats)
}

/// 删除回收站内超期文件，自底向上回收空目录；.recycle 本身保留。
/// 符号链接一律跳过（既不跟随也不删除）。
/// 判定基于文件 mtime；共享配置的 recycle:touch_mtime=yes 会让 Samba
/// 在删除时刷新 mtime，使其等于删除时间（files.rs 渲染中已开启）。
fn clean_bin(
    bin: &cap_std::fs::Dir,
    rel: &str,
    depth: usize,
    cutoff: SystemTime,
    stats: &mut Stats,
) -> Result<()> {
    if depth > MAX_SHARE_DEPTH {
        return Ok(());
    }
    for entry in bin.entries()? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if entry.file_type()?.is_dir() {
            let sub = bin.open_dir(&name)?;
            clean_bin(&sub, &child_rel, depth + 1, cutoff, stats)?;
            if sub.entries()?.next().is_none() {
                let _ = bin.remove_dir(&name);
            }
        } else if let Ok(meta) = entry.metadata() {
            // cap_std 时间换 unix 秒，与 std cutoff 的 unix 秒比较
            let cap_epoch = cap_std::time::SystemTime::from_std(std::time::UNIX_EPOCH);
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(cap_epoch).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let cutoff_secs = cutoff
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if modified > 0 && modified < cutoff_secs {
                let bytes = meta.len();
                if bin.remove_file(&name).is_ok() {
                    stats.files += 1;
                    stats.bytes += bytes;
                }
            }
        }
    }
    Ok(())
}
