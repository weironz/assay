use anyhow::{Context, Result, ensure};
use serde::Deserialize;
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
    pub state_dir: PathBuf,
    pub primary_gid: u32,
    pub helper_socket: PathBuf,
    pub smb_pid_file: PathBuf,
    #[serde(default)]
    pub read_only: bool,
}
impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let c: Self = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(c.ldap_url.starts_with("ldaps://"), "LDAPS is required");
        ensure!(
            c.users_dn.to_lowercase().starts_with("ou=")
                && (c.groups_dn.to_lowercase().starts_with("ou=")
                    || (c.groups_dn.to_lowercase().starts_with("cn=")
                        && !c.group_prefix.is_empty())),
            "managed OUs are required"
        );
        if !c.group_prefix.is_empty() {
            crate::ad::name(&c.group_prefix)?;
        }
        for dn in [&c.users_dn, &c.groups_dn] {
            ensure!(
                dn.to_lowercase()
                    .ends_with(&format!(",{}", c.base_dn.to_lowercase())),
                "OU outside domain"
            );
        }
        for p in [&c.shares_root, &c.config_dir, &c.state_dir] {
            ensure!(p.is_absolute(), "absolute filesystem roots required");
            fs::create_dir_all(p)?;
            ensure!(
                !fs::symlink_metadata(p)?.file_type().is_symlink(),
                "symlink root rejected"
            );
        }
        Ok(c)
    }
}
pub fn secret(path: &PathBuf) -> Result<String> {
    Ok(fs::read_to_string(path)
        .context("secret file unavailable")?
        .trim_end_matches(['\r', '\n'])
        .to_owned())
}
