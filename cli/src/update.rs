use crate::VERSION;
use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, process::Command, time::Duration};

const REPO: &str = "weironz/assay";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize, Clone)]
struct Asset {
    name: String,
    browser_download_url: String,
}

pub fn run(check_only: bool) -> Result<()> {
    let release = latest_cli_release()?;
    let latest = release
        .tag_name
        .strip_prefix("assay-cli-v")
        .context("CLI Release 标签格式错误")?;
    let current = Version::parse(VERSION)?;
    let latest_version = Version::parse(latest)?;
    if latest_version <= current {
        println!("assay 已是最新版本 ({VERSION})");
        return Ok(());
    }
    println!("发现新版本：{VERSION} → {latest}");
    if check_only {
        return Ok(());
    }
    let target = target()?;
    let binary = binary_name();
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == format!("assay-{target}{binary}"))
        .context("此平台暂无可用更新包")?;
    let sums = release
        .assets
        .iter()
        .find(|a| a.name == "SHA256SUMS")
        .context("Release 缺少 SHA256SUMS")?;
    let client = http()?;
    let bytes = client
        .get(&asset.browser_download_url)
        .send()?
        .error_for_status()?
        .bytes()?;
    verify_checksum(
        &client
            .get(&sums.browser_download_url)
            .send()?
            .error_for_status()?
            .text()?,
        &asset.name,
        &bytes,
    )?;
    let current_exe = std::env::current_exe()?;
    let new_exe = current_exe.with_extension(format!("new{}", binary));
    fs::write(&new_exe, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&new_exe, fs::Permissions::from_mode(0o755))?;
        fs::rename(&new_exe, &current_exe)?;
        println!("更新完成：{latest}");
    }
    #[cfg(windows)]
    {
        let script = current_exe.with_extension("update.cmd");
        fs::write(
            &script,
            format!(
                "@echo off\r\nping 127.0.0.1 -n 3 > nul\r\nmove /Y \"{}\" \"{}\" > nul\r\ndel \"{}\"\r\n",
                new_exe.display(),
                current_exe.display(),
                script.display()
            ),
        )?;
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                script.to_str().context("更新路径无法编码")?,
            ])
            .spawn()?;
        println!("更新已准备完成；退出后会自动替换为 {latest}。");
    }
    Ok(())
}

fn latest_cli_release() -> Result<Release> {
    let releases: Vec<Release> = http()?
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases?per_page=100"
        ))
        .send()?
        .error_for_status()?
        .json()?;
    releases
        .into_iter()
        .find(|r| r.tag_name.starts_with("assay-cli-v") && !r.prerelease && !r.draft)
        .context("尚未发布 assay-cli。请从 GitHub Release 安装首个版本")
}

fn http() -> Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent(format!("assay-cli/{VERSION}"))
        .build()?)
}
fn binary_name() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}
fn target() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-musl"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        _ => bail!("当前平台暂不支持自动更新"),
    }
}
fn verify_checksum(sums: &str, filename: &str, bytes: &[u8]) -> Result<()> {
    let expected = sums
        .lines()
        .find_map(|line| {
            line.split_whitespace()
                .next()
                .filter(|_| line.ends_with(filename))
        })
        .context("SHA256SUMS 中缺少目标文件")?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        bail!("下载文件的 SHA-256 校验失败，已拒绝更新");
    }
    Ok(())
}
