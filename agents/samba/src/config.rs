use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub listen: String,
    pub token_file: PathBuf,
    pub ldap_url: String,
    pub ldap_ca_file: PathBuf,
    pub ldap_bind_dn: String,
    pub ldap_password_file: PathBuf,
    pub base_dn: String,
    pub users_dn: String,
    pub groups_dn: String,
    #[serde(default)]
    pub group_prefix: String,
    pub smb_server: String,
    pub smb_username: String,
    pub shares_root: PathBuf,
    pub config_dir: PathBuf,
    #[serde(default = "registry_name")]
    pub shares_file_name: String,
    #[serde(default = "config_name")]
    pub samba_config_file_name: String,
    #[serde(default = "samba_root")]
    pub samba_shares_root: PathBuf,
    // Deployment-owned inventory of existing shares; never written by the HTTP API.
    #[serde(default)]
    pub external_shares_file: Option<PathBuf>,
    #[serde(default)]
    pub external_samba_config_file: Option<PathBuf>,
    pub state_dir: PathBuf,
    pub primary_gid: u32,
    // Present only for compatibility with deployments that still run a helper.
    #[serde(default)]
    pub helper_socket: Option<PathBuf>,
    #[serde(default)]
    pub files: Option<crate::portal::Config>,
    pub smb_pid_file: PathBuf,
    // For an existing AD container without a mounted PID directory. Requires its PID namespace.
    #[serde(default)]
    pub reload_via_proc: bool,
    // Explicit deployment opt-in: fixed validator and read-only Samba config view.
    #[serde(default)]
    pub rename: Option<crate::rename::Settings>,
    // 可选：会话可见性（smbstatus 只读探测）。目录必须与 smbd 指向同一套
    // 状态文件（同一卷挂载），否则读取失败而不是返回过期数据。
    #[serde(default)]
    pub smb_status: Option<SmbStatus>,
    // Optional cleanup of registered share bins. Runtime overrides live in state_dir;
    // agent.json stays read-only. Retention starts at first observation, not mtime.
    #[serde(default)]
    pub recycle: Option<Recycle>,
    #[serde(default)]
    pub read_only: bool,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SmbStatus {
    pub state_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub private_dir: PathBuf,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Recycle {
    #[serde(default = "recycle_retention_days")]
    pub retention_days: u32,
    #[serde(default = "recycle_every_hours")]
    pub every_hours: u32,
}
fn recycle_retention_days() -> u32 {
    30
}
fn recycle_every_hours() -> u32 {
    24
}
fn registry_name() -> String {
    "assay-shares.json".into()
}
fn config_name() -> String {
    "assay-shares.conf".into()
}
fn samba_root() -> PathBuf {
    "/shares".into()
}
impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let c: Self = serde_json::from_slice(&fs::read(path)?)?;
        c.check()?;
        Ok(c)
    }
    pub fn check(&self) -> Result<()> {
        for name in [&self.shares_file_name, &self.samba_config_file_name] {
            ensure!(
                !name.is_empty()
                    && name.len() <= 128
                    && name != "."
                    && name != ".."
                    && name
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch)),
                "configuration filenames must be simple filenames"
            );
        }
        ensure!(
            self.shares_file_name != self.samba_config_file_name,
            "distinct configuration filenames required"
        );
        ensure!(
            self.samba_shares_root.is_absolute()
                && self.samba_shares_root.to_str().is_some_and(|p| p
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "/_-".contains(ch)))
                && !self
                    .samba_shares_root
                    .components()
                    .any(|p| matches!(p, std::path::Component::ParentDir)),
            "invalid Samba-visible shares root"
        );
        ensure!(
            self.external_shares_file.is_some() == self.external_samba_config_file.is_some(),
            "external inventory and source config must be configured together"
        );
        for path in [&self.external_shares_file, &self.external_samba_config_file]
            .into_iter()
            .flatten()
        {
            ensure!(
                path.is_absolute(),
                "absolute external inventory paths required"
            );
        }
        ensure!(self.ldap_url.starts_with("ldaps://"), "LDAPS is required");
        ensure!(
            self.users_dn.to_lowercase().starts_with("ou=")
                && (self.groups_dn.to_lowercase().starts_with("ou=")
                    || (self.groups_dn.to_lowercase().starts_with("cn=")
                        && !self.group_prefix.is_empty())),
            "managed OUs are required"
        );
        if !self.group_prefix.is_empty() {
            crate::ad::name(&self.group_prefix)?;
        }
        for dn in [&self.users_dn, &self.groups_dn] {
            ensure!(
                dn.to_lowercase()
                    .ends_with(&format!(",{}", self.base_dn.to_lowercase())),
                "OU outside domain"
            );
        }
        for p in [&self.shares_root, &self.config_dir, &self.state_dir] {
            ensure!(p.is_absolute(), "absolute filesystem roots required");
            fs::create_dir_all(p)?;
            ensure!(
                !fs::symlink_metadata(p)?.file_type().is_symlink(),
                "symlink root rejected"
            );
        }
        if let Some(s) = &self.smb_status {
            for p in [&s.state_dir, &s.cache_dir, &s.private_dir] {
                ensure!(p.is_absolute(), "absolute smbstatus directories required");
            }
        }
        Ok(())
    }
}
pub fn secret(path: &PathBuf) -> Result<String> {
    Ok(fs::read_to_string(path)
        .context("secret file unavailable")?
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}
