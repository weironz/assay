use crate::default_config;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_cookie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_token: Option<String>,
}

pub struct ConfigStore {
    pub config: Config,
    pub path: PathBuf,
}

impl ConfigStore {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let config = if path.exists() {
            serde_json::from_slice(
                &fs::read(&path).with_context(|| format!("读取 {} 失败", path.display()))?,
            )?
        } else {
            default_config()
        };
        Ok(Self { config, path })
    }

    pub fn save(&self) -> Result<()> {
        let parent = self.path.parent().context("无法确定配置目录")?;
        fs::create_dir_all(parent)?;
        let tmp = self.path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(&self.config)?;
        // 原子创建并直接带 0600：避免先写后 chmod 之间凭据以 umask 默认权限暴露
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .with_context(|| format!("创建 {} 失败", tmp.display()))?;
            file.write_all(&bytes)?;
        }
        #[cfg(not(unix))]
        {
            // Windows 无 POSIX 权限位；写入用户配置目录（%APPDATA% 受用户 ACL 保护）
            fs::write(&tmp, &bytes)?;
        }
        fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

fn config_path() -> Result<PathBuf> {
    let dirs = dirs::config_dir().context("无法确定系统配置目录")?;
    Ok(dirs.join("assay").join("config.json"))
}
