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
        fs::write(&tmp, serde_json::to_vec_pretty(&self.config)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

fn config_path() -> Result<PathBuf> {
    let dirs = dirs::config_dir().context("无法确定系统配置目录")?;
    Ok(dirs.join("assay").join("config.json"))
}
