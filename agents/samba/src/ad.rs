use crate::config::{Config, secret};
use anyhow::{Result, anyhow, ensure};
use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, Mod, Scope, SearchEntry};
use regex::Regex;
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc, time::Duration};

pub fn name(s: &str) -> Result<()> {
    ensure!(
        Regex::new(r"^[a-z][a-z0-9_-]{1,47}$").unwrap().is_match(s),
        "invalid account/group/share name"
    );
    ensure!(
        ![
            "administrator",
            "krbtgt",
            "guest",
            "domain_admins",
            "sysvol",
            "netlogon"
        ]
        .contains(&s),
        "protected name"
    );
    Ok(())
}
pub fn text(s: &str) -> Result<()> {
    ensure!(
        !s.is_empty() && s.chars().count() <= 128 && !s.chars().any(char::is_control),
        "invalid display text"
    );
    Ok(())
}
pub fn password(s: &str) -> Result<Vec<u8>> {
    ensure!(
        s.chars().count() >= 8 && s.len() <= 512 && !s.contains('\0'),
        "password must contain 8 or more characters"
    );
    Ok(format!("\"{s}\"")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect())
}
pub fn guid_filter(id: &str) -> Result<String> {
    ensure!(
        id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid object GUID"
    );
    Ok(format!(
        "(objectGUID={})",
        (0..32)
            .step_by(2)
            .map(|i| format!("\\{}", &id[i..i + 2]))
            .collect::<String>()
    ))
}
fn hex(v: &[u8]) -> String {
    v.iter().map(|v| format!("{v:02x}")).collect()
}
fn attr(e: &SearchEntry, k: &str) -> String {
    e.attrs
        .get(k)
        .and_then(|v| v.first())
        .cloned()
        .unwrap_or_default()
}
fn sid(v: &[u8]) -> String {
    if v.len() < 8 {
        return String::new();
    }
    let authority = v[2..8].iter().fold(0u64, |a, b| a * 256 + *b as u64);
    let mut s = format!("S-{}-{authority}", v[0]);
    for x in v[8..].as_chunks::<4>().0.iter().take(v[1] as usize) {
        s += &format!("-{}", u32::from_le_bytes(*x));
    }
    s
}
fn raw(e: &SearchEntry, key: &str) -> Option<Vec<u8>> {
    e.bin_attrs
        .get(key)
        .and_then(|v| v.first())
        .cloned()
        .or_else(|| {
            e.attrs
                .get(key)
                .and_then(|v| v.first())
                .map(|v| v.as_bytes().to_vec())
        })
}
fn row(e: &SearchEntry) -> Value {
    json!({"id": raw(e,"objectGUID").map(|x|hex(&x)).unwrap_or_default(),
        "sid": raw(e,"objectSid").map(|x|sid(&x)).unwrap_or_default(),
        "name": attr(e,"sAMAccountName"), "displayName": attr(e,"displayName"), "description": attr(e,"description"),
        "disabled": attr(e,"userAccountControl").parse::<u32>().unwrap_or(0) & 2 != 0,
        "members": e.attrs.get("member").cloned().unwrap_or_default(), "dn":e.dn})
}
const ATTRS: [&str; 10] = [
    "objectGUID",
    "objectSid",
    "sAMAccountName",
    "displayName",
    "description",
    "userAccountControl",
    "member",
    "adminCount",
    "uidNumber",
    "gidNumber",
];
pub struct Directory {
    pub ldap: Ldap,
    c: Config,
}
impl Directory {
    pub async fn connect(c: &Config) -> Result<Self> {
        let mut roots = rustls::RootCertStore::empty();
        let pem = std::fs::read(&c.ldap_ca_file)?;
        for cert in rustls_pemfile::certs(&mut std::io::Cursor::new(pem)) {
            roots.add(cert?)?;
        }
        ensure!(!roots.is_empty(), "LDAP trust CA missing");
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let settings = LdapConnSettings::new()
            .set_conn_timeout(Duration::from_secs(8))
            .set_config(Arc::new(tls));
        let (conn, mut ldap) = LdapConnAsync::with_settings(settings, &c.ldap_url).await?;
        ldap3::drive!(conn);
        ldap.with_timeout(Duration::from_secs(12));
        check(
            ldap.simple_bind(&c.ldap_bind_dn, &secret(&c.ldap_password_file)?)
                .await?,
        )?;
        Ok(Self { ldap, c: c.clone() })
    }
    async fn entries(&mut self, base: &str, filter: &str) -> Result<Vec<SearchEntry>> {
        let (rows, r) = self
            .ldap
            .search(base, Scope::Subtree, filter, ATTRS.to_vec())
            .await?
            .success()?;
        check(r)?;
        Ok(rows.into_iter().map(SearchEntry::construct).collect())
    }
    pub async fn snapshot(&mut self) -> Result<Value> {
        let users = self
            .entries(
                &self.c.users_dn.clone(),
                "(&(objectClass=user)(!(objectClass=computer)))",
            )
            .await?;
        let group_filter = format!(
            "(&(objectClass=group)(sAMAccountName={}*))",
            ldap3::ldap_escape(&self.c.group_prefix)
        );
        let groups = self
            .entries(&self.c.groups_dn.clone(), &group_filter)
            .await?;
        Ok(
            json!({"users":users.iter().map(row).collect::<Vec<_>>(),"groups":groups.iter().map(row).collect::<Vec<_>>(),"groupPrefix":self.c.group_prefix}),
        )
    }
    pub async fn object(&mut self, id: &str, group: bool) -> Result<SearchEntry> {
        let base = if group {
            self.c.groups_dn.clone()
        } else {
            self.c.users_dn.clone()
        };
        let rows = self
            .entries(
                &base,
                &format!(
                    "(&{}(objectClass={}))",
                    guid_filter(id)?,
                    if group { "group" } else { "user" }
                ),
            )
            .await?;
        let e = rows
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("managed object not found"))?;
        name(&attr(&e, "sAMAccountName"))?;
        if group {
            ensure!(
                attr(&e, "sAMAccountName").starts_with(&self.c.group_prefix),
                "protected group outside managed prefix"
            );
        }
        ensure!(
            attr(&e, "adminCount") != "1",
            "protected administrative object"
        );
        Ok(e)
    }
    pub async fn create_user(&mut self, username: &str, display: &str, pwd: &str) -> Result<Value> {
        name(username)?;
        text(display)?;
        let encoded = password(pwd)?;
        let dn = format!("CN={username},{}", self.c.users_dn);
        let mut uid = 20000;
        let (rows, _) = self
            .ldap
            .search(
                &self.c.base_dn,
                Scope::Subtree,
                "(uidNumber=*)",
                vec!["uidNumber"],
            )
            .await?
            .success()?;
        for r in rows {
            let n = attr(&SearchEntry::construct(r), "uidNumber")
                .parse::<u32>()
                .unwrap_or(0);
            uid = uid.max(n.saturating_add(1));
        }
        let attrs = vec![
            (
                "objectClass",
                vec!["top", "person", "organizationalPerson", "user"],
            ),
            ("cn", vec![username]),
            ("sAMAccountName", vec![username]),
            ("displayName", vec![display]),
            ("userAccountControl", vec!["514"]),
        ];
        check(
            self.ldap
                .add(
                    &dn,
                    attrs
                        .into_iter()
                        .map(|(k, v)| (k, v.into_iter().collect::<HashSet<_>>()))
                        .collect(),
                )
                .await?,
        )?;
        // Incomplete provisioning remains disabled and can be repaired explicitly.
        check(
            self.ldap
                .modify(
                    &dn,
                    vec![Mod::Replace(
                        b"unicodePwd".as_slice(),
                        HashSet::from([encoded.as_slice()]),
                    )],
                )
                .await?,
        )?;
        let uid = uid.to_string();
        let gid = self.c.primary_gid.to_string();
        check(
            self.ldap
                .modify(
                    &dn,
                    vec![
                        Mod::Replace("uidNumber", HashSet::from([uid.as_str()])),
                        Mod::Replace("gidNumber", HashSet::from([gid.as_str()])),
                        Mod::Replace("userAccountControl", HashSet::from(["512"])),
                    ],
                )
                .await?,
        )?;
        let rows = self.entries(&dn, "(objectClass=user)").await?;
        Ok(row(&rows[0]))
    }
    pub async fn update_user(&mut self, id: &str, display: &str, disabled: bool) -> Result<Value> {
        text(display)?;
        let e = self.object(id, false).await?;
        let flags = attr(&e, "userAccountControl").parse::<u32>()?;
        let flags = if disabled { flags | 2 } else { flags & !2 };
        let flags = flags.to_string();
        check(
            self.ldap
                .modify(
                    &e.dn,
                    vec![
                        Mod::Replace("displayName", HashSet::from([display])),
                        Mod::Replace("userAccountControl", HashSet::from([flags.as_str()])),
                    ],
                )
                .await?,
        )?;
        Ok(row(&self.object(id, false).await?))
    }
    pub async fn reset_password(&mut self, id: &str, pwd: &str) -> Result<Value> {
        let e = self.object(id, false).await?;
        let pwd = password(pwd)?;
        check(
            self.ldap
                .modify(
                    &e.dn,
                    vec![Mod::Replace(
                        b"unicodePwd".as_slice(),
                        HashSet::from([pwd.as_slice()]),
                    )],
                )
                .await?,
        )?;
        Ok(json!({"id":id,"changed":true}))
    }
    pub async fn change_password(&mut self, id: &str, old: &str, new: &str) -> Result<Value> {
        let e = self.object(id, false).await?;
        let old_encoded = password(old)?;
        let new = password(new)?;
        check(self.ldap.simple_bind(&e.dn, old).await?)?;
        let old = old_encoded;
        check(
            self.ldap
                .modify(
                    &e.dn,
                    vec![
                        Mod::Delete(b"unicodePwd".as_slice(), HashSet::from([old.as_slice()])),
                        Mod::Add(b"unicodePwd".as_slice(), HashSet::from([new.as_slice()])),
                    ],
                )
                .await?,
        )?;
        Ok(json!({"id":id,"changed":true}))
    }
    pub async fn create_group(&mut self, n: &str, description: &str) -> Result<Value> {
        name(n)?;
        ensure!(n.starts_with(&self.c.group_prefix), "invalid group prefix");
        text(description)?;
        let dn = format!("CN={n},{}", self.c.groups_dn);
        check(
            self.ldap
                .add(
                    &dn,
                    vec![
                        ("objectClass", HashSet::from(["top", "group"])),
                        ("cn", HashSet::from([n])),
                        ("sAMAccountName", HashSet::from([n])),
                        ("groupType", HashSet::from(["-2147483646"])),
                        ("description", HashSet::from([description])),
                    ],
                )
                .await?,
        )?;
        Ok(row(&self.entries(&dn, "(objectClass=group)").await?[0]))
    }
    pub async fn group(
        &mut self,
        id: &str,
        description: Option<&str>,
        member: Option<(&str, bool)>,
        delete: bool,
    ) -> Result<Value> {
        let e = self.object(id, true).await?;
        if delete {
            ensure!(
                e.attrs.get("member").is_none_or(Vec::is_empty),
                "remove group members before deleting group"
            );
            check(self.ldap.delete(&e.dn).await?)?;
            return Ok(json!({"deleted":true}));
        }
        if let Some(d) = description {
            text(d)?;
            check(
                self.ldap
                    .modify(&e.dn, vec![Mod::Replace("description", HashSet::from([d]))])
                    .await?,
            )?;
        }
        if let Some((user, add)) = member {
            let u = self.object(user, false).await?;
            let exists = e.attrs.get("member").is_some_and(|m| m.contains(&u.dn));
            if exists != add {
                let vals = HashSet::from([u.dn.as_str()]);
                check(
                    self.ldap
                        .modify(
                            &e.dn,
                            vec![if add {
                                Mod::Add("member", vals)
                            } else {
                                Mod::Delete("member", vals)
                            }],
                        )
                        .await?,
                )?;
            }
        }
        Ok(row(&self.object(id, true).await?))
    }
    pub async fn service_sid(&mut self) -> Result<String> {
        let name = self
            .c
            .smb_username
            .split('\\')
            .next_back()
            .unwrap()
            .to_owned();
        let rows = self
            .entries(
                &self.c.base_dn.clone(),
                &format!("(sAMAccountName={})", ldap3::ldap_escape(&name)),
            )
            .await?;
        ensure!(rows.len() == 1, "service identity not found");
        Ok(row(&rows[0])["sid"].as_str().unwrap().to_owned())
    }
    pub async fn principal_sid(&mut self, id: &str, group: bool) -> Result<String> {
        let e = self.object(id, group).await?;
        let s = row(&e)["sid"].as_str().unwrap_or_default().to_owned();
        ensure!(!s.is_empty(), "object SID missing");
        Ok(s)
    }
}
fn check(r: ldap3::LdapResult) -> Result<()> {
    if r.rc == 0 {
        Ok(())
    } else {
        Err(anyhow!("AD rejected operation (LDAP code {})", r.rc))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_injection() {
        assert!(name("alice)(uid=*)").is_err());
        assert!(guid_filter("*").is_err());
        assert!(name("administrator").is_err());
    }
    #[test]
    fn encodes_ad_password() {
        assert_eq!(
            password("Abcd123!").unwrap(),
            "\"Abcd123!\""
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>()
        );
    }
}
