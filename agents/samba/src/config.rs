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
    #[serde(default)]
    pub read_only: bool,
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
        for name in [&c.shares_file_name, &c.samba_config_file_name] {
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
            c.shares_file_name != c.samba_config_file_name,
            "distinct configuration filenames required"
        );
        ensure!(
            c.samba_shares_root.is_absolute()
                && c.samba_shares_root.to_str().is_some_and(|p| p
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "/_-".contains(ch)))
                && !c
                    .samba_shares_root
                    .components()
                    .any(|p| matches!(p, std::path::Component::ParentDir)),
            "invalid Samba-visible shares root"
        );
        ensure!(
            c.external_shares_file.is_some() == c.external_samba_config_file.is_some(),
            "external inventory and source config must be configured together"
        );
        for path in [&c.external_shares_file, &c.external_samba_config_file]
            .into_iter()
            .flatten()
        {
            ensure!(
                path.is_absolute(),
                "absolute external inventory paths required"
            );
        }
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
