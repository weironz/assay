use crate::config::{Config, secret};
use anyhow::{Result, anyhow, ensure};
use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, Mod, Scope, SearchEntry};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
pub(crate) fn attr(e: &SearchEntry, k: &str) -> String {
    e.attrs
        .get(k)
        .or_else(|| {
            e.attrs
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(k))
                .map(|(_, value)| value)
        })
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
        "revision":revision(e),"upn":attr(e,"userPrincipalName"),"uidNumber":attr(e,"uidNumber"),"gidNumber":attr(e,"gidNumber"),
        "accountControl":attr(e,"userAccountControl"),"passwordChangedAt":attr(e,"pwdLastSet"),"primaryGroupId":attr(e,"primaryGroupID"),"groupType":attr(e,"groupType"),
        "locked":attr(e,"msDS-User-Account-Control-Computed").parse::<u32>().map(|flags|flags & 0x10 != 0).unwrap_or_else(|_|attr(e,"lockoutTime").parse::<i64>().unwrap_or(0)>0),
        "badPasswords":attr(e,"badPwdCount").parse::<u32>().unwrap_or(0),
        "lastLogonAt":ft_ms(attr(e,"lastLogonTimestamp").parse::<i64>().unwrap_or(0)),
        "name": attr(e,"sAMAccountName"), "displayName": attr(e,"displayName"), "description": attr(e,"description"),
        "disabled":attr(e,"userAccountControl").parse::<u32>().unwrap_or(0) & 2 != 0,
        "members": e.attrs.get("member").cloned().unwrap_or_default(), "dn":e.dn,
        "employeeId":attr(e,"employeeID"),"email":attr(e,"mail"),"department":attr(e,"department"),
        "title":attr(e,"title"),"phone":attr(e,"telephoneNumber"),"company":attr(e,"company"),"office":attr(e,"physicalDeliveryOfficeName"),
        "manageable":attr(e,"adminCount")!="1" && name(&attr(e,"sAMAccountName")).is_ok()})
}
/// Windows FILETIME（1601 纪元、100ns 单位）转 unix 毫秒；非正值为"无"。
fn ft_ms(v: i64) -> Value {
    if v <= 0 {
        Value::Null
    } else {
        json!(v / 10_000 - 11_644_473_600_000)
    }
}
fn password_interval(days: u32, maximum: bool) -> String {
    if maximum && days == 0 {
        i64::MIN.to_string()
    } else {
        (-(days as i64) * 864_000_000_000).to_string()
    }
}
fn password_expiry(e: &SearchEntry, max_age: i64) -> Value {
    let flags = attr(e, "userAccountControl").parse::<u32>().unwrap_or(0);
    let set = attr(e, "pwdLastSet").parse::<i64>().unwrap_or(0);
    if flags & 0x10000 != 0 || set <= 1 {
        return Value::Null;
    }
    if let Ok(computed) = attr(e, "msDS-UserPasswordExpiryTimeComputed").parse::<i64>() {
        return if computed > 0 && computed < i64::MAX {
            ft_ms(computed)
        } else {
            Value::Null
        };
    }
    if max_age >= 0 || max_age == i64::MIN {
        return Value::Null;
    }
    set.checked_sub(max_age).map(ft_ms).unwrap_or(Value::Null)
}
fn revision(e: &SearchEntry) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}:{}:{}",
            e.dn,
            attr(e, "uSNChanged"),
            attr(e, "sAMAccountName")
        ))
    )
}
const ATTRS: [&str; 29] = [
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
    "employeeID",
    "mail",
    "department",
    "title",
    "telephoneNumber",
    "company",
    "physicalDeliveryOfficeName",
    "userPrincipalName",
    "uSNChanged",
    "pwdLastSet",
    "primaryGroupID",
    "memberOf",
    "groupType",
    "lockoutTime",
    "badPwdCount",
    "lastLogonTimestamp",
    "msDS-UserPasswordExpiryTimeComputed",
    "msDS-User-Account-Control-Computed",
    "msDS-ResultantPSO",
];
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmployeeProfile {
    pub employee_id: Option<String>,
    pub email: Option<String>,
    pub department: Option<String>,
    pub title: Option<String>,
    pub phone: Option<String>,
    pub company: Option<String>,
    pub office: Option<String>,
}
impl EmployeeProfile {
    fn attributes(&self) -> Result<Vec<(&'static str, &str)>> {
        let mut values = vec![];
        let email_pattern = Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap();
        for (key, value, max) in [
            ("employeeID", &self.employee_id, 16),
            ("mail", &self.email, 254),
            ("department", &self.department, 64),
            ("title", &self.title, 64),
            ("telephoneNumber", &self.phone, 64),
            ("company", &self.company, 64),
            ("physicalDeliveryOfficeName", &self.office, 128),
        ] {
            if let Some(value) = value {
                ensure!(
                    value.chars().count() <= max && !value.chars().any(char::is_control),
                    "invalid employee profile attribute"
                );
                if key == "mail" && !value.is_empty() {
                    ensure!(email_pattern.is_match(value), "invalid employee email");
                }
                values.push((key, value.as_str()));
            }
        }
        Ok(values)
    }
    fn modifications(&self) -> Result<Vec<Mod<&str>>> {
        Ok(self
            .attributes()?
            .into_iter()
            .map(|(key, value)| {
                Mod::Replace(
                    key,
                    if value.is_empty() {
                        HashSet::new()
                    } else {
                        HashSet::from([value])
                    },
                )
            })
            .collect())
    }
}
pub struct Directory {
    pub ldap: Ldap,
    c: Config,
}
#[derive(Clone, serde::Serialize, Deserialize)]
pub struct RenamePlan {
    pub id: String,
    pub group: bool,
    pub old_name: String,
    pub new_name: String,
    pub old_upn: String,
    pub new_upn: String,
    pub before: Value,
}
impl Directory {
    pub fn base(&self) -> &str {
        &self.c.base_dn
    }
    pub async fn rename_plan(
        &mut self,
        id: &str,
        group: bool,
        new_name: &str,
        expected: &str,
    ) -> Result<RenamePlan> {
        name(new_name)?;
        if group {
            ensure!(
                new_name.starts_with(&self.c.group_prefix),
                "invalid group prefix"
            );
        }
        let e = self.object(id, group).await?;
        ensure!(revision(&e) == expected, "RENAME_CONFLICT");
        let old_name = attr(&e, "sAMAccountName");
        ensure!(old_name != new_name, "RENAME_UNCHANGED");
        let old_upn = attr(&e, "userPrincipalName");
        let suffix = if let Some((_, suffix)) = old_upn.rsplit_once('@') {
            suffix.to_owned()
        } else {
            self.c
                .base_dn
                .split(',')
                .map(|v| {
                    v.trim()
                        .split_once('=')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("dc"))
                        .map(|(_, value)| value)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(".")
                .to_lowercase()
        };
        let new_upn = if group {
            String::new()
        } else {
            format!("{new_name}@{suffix}")
        };
        let filter = if group {
            format!("(sAMAccountName={})", ldap3::ldap_escape(new_name))
        } else {
            format!(
                "(|(sAMAccountName={})(userPrincipalName={}))",
                ldap3::ldap_escape(new_name),
                ldap3::ldap_escape(&new_upn)
            )
        };
        ensure!(
            self.entries(&self.c.base_dn.clone(), &filter)
                .await?
                .is_empty(),
            "RENAME_NAME_EXISTS"
        );
        Ok(RenamePlan {
            id: id.to_lowercase(),
            group,
            old_name,
            new_name: new_name.to_owned(),
            old_upn,
            new_upn,
            before: row(&e),
        })
    }
    pub async fn apply_rename(&mut self, p: &RenamePlan, forward: bool) -> Result<Value> {
        let e = self.object(&p.id, p.group).await?;
        let (old, new, old_upn, new_upn) = if forward {
            (&p.old_name, &p.new_name, &p.old_upn, &p.new_upn)
        } else {
            (&p.new_name, &p.old_name, &p.new_upn, &p.old_upn)
        };
        let current = row(&e);
        // No password, flags, numeric identity, SID, membership or display attributes are written.
        for key in [
            "id",
            "sid",
            "dn",
            "uidNumber",
            "gidNumber",
            "disabled",
            "displayName",
            "description",
            "employeeId",
            "email",
            "department",
            "title",
            "phone",
            "company",
            "office",
            "members",
            "accountControl",
            "passwordChangedAt",
            "primaryGroupId",
            "groupType",
        ] {
            ensure!(current[key] == p.before[key], "RENAME_CONFLICT");
        }
        if attr(&e, "sAMAccountName") == *new
            && (p.group || attr(&e, "userPrincipalName") == *new_upn)
        {
            return Ok(current);
        }
        ensure!(
            attr(&e, "sAMAccountName") == *old
                && (p.group || attr(&e, "userPrincipalName") == *old_upn),
            "RENAME_CONFLICT"
        );
        if forward {
            ensure!(
                current["revision"] == p.before["revision"],
                "RENAME_CONFLICT"
            );
        }
        let mut modifications = vec![
            Mod::Delete("sAMAccountName", HashSet::from([old.as_str()])),
            Mod::Add("sAMAccountName", HashSet::from([new.as_str()])),
        ];
        if !p.group {
            if !old_upn.is_empty() {
                modifications.push(Mod::Delete(
                    "userPrincipalName",
                    HashSet::from([old_upn.as_str()]),
                ));
            }
            if !new_upn.is_empty() {
                modifications.push(Mod::Add(
                    "userPrincipalName",
                    HashSet::from([new_upn.as_str()]),
                ));
            }
        }
        // GUID binding prevents a concurrent delete/recreate at the same DN from targeting another identity.
        let bytes: Vec<u8> = (0..32)
            .step_by(2)
            .map(|i| u8::from_str_radix(&p.id[i..i + 2], 16))
            .collect::<std::result::Result<_, _>>()?;
        let guid = uuid::Uuid::from_bytes_le(
            bytes
                .try_into()
                .map_err(|_| anyhow!("invalid object GUID"))?,
        );
        check(
            self.ldap
                .modify(&format!("<GUID={guid}>"), modifications)
                .await?,
        )?;
        let result = row(&self.object(&p.id, p.group).await?);
        ensure!(
            result["name"] == new.as_str()
                && result["sid"] == p.before["sid"]
                && result["dn"] == p.before["dn"],
            "RENAME_CONFLICT"
        );
        Ok(result)
    }
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
    pub async fn unlock(&mut self, id: &str) -> Result<Value> {
        let e = self.object(id, false).await?;
        // lockoutTime=0 是 AD 的标准解锁写法；对未锁定账号执行是幂等的。
        check(
            self.ldap
                .modify(
                    &e.dn,
                    vec![Mod::Replace("lockoutTime", HashSet::from(["0"]))],
                )
                .await?,
        )?;
        Ok(row(&self.object(id, false).await?))
    }
    /// 域级密码/锁定策略（domainDNS 根对象属性）。时间间隔属性是负 FILETIME。
    pub async fn domain_policy(&mut self) -> Result<Value> {
        let e = self.domain_policy_entry().await?;
        Ok(json!({
            "maxPwdAge":attr(&e,"maxPwdAge"),"minPwdAge":attr(&e,"minPwdAge"),
            "lockoutDuration":attr(&e,"lockoutDuration"),"lockoutObservationWindow":attr(&e,"lockOutObservationWindow"),
            "lockoutThreshold":attr(&e,"lockoutThreshold"),"minPwdLength":attr(&e,"minPwdLength"),
            "pwdHistoryLength":attr(&e,"pwdHistoryLength"),"pwdProperties":attr(&e,"pwdProperties")
        }))
    }
    async fn domain_policy_entry(&mut self) -> Result<SearchEntry> {
        let (rows, r) = self
            .ldap
            .search(
                &self.c.base_dn.clone(),
                Scope::Base,
                "(objectClass=*)",
                vec![
                    "maxPwdAge",
                    "minPwdAge",
                    "lockoutDuration",
                    "lockOutObservationWindow",
                    "lockoutThreshold",
                    "minPwdLength",
                    "pwdHistoryLength",
                    "pwdProperties",
                ],
            )
            .await?
            .success()?;
        check(r)?;
        rows.into_iter()
            .map(SearchEntry::construct)
            .next()
            .ok_or_else(|| anyhow!("domain policy not found"))
    }
    /// 更新域密码/锁定策略。days=0 表示永不过期（INT64_MIN 哨兵）；
    /// 分钟字段为 0 表示禁用该间隔；全部写入前做范围校验。
    pub async fn set_domain_policy(
        &mut self,
        max_pwd_age_days: Option<u32>,
        min_pwd_age_days: Option<u32>,
        lockout_threshold: Option<u32>,
        lockout_duration_minutes: Option<u32>,
    ) -> Result<Value> {
        let e = self.domain_policy_entry().await?;
        let mut modifications: Vec<Mod<String>> = vec![];
        let filetime = |days: u32| password_interval(days, true);
        let minutes_filetime = |minutes: u32| (-(minutes as i64) * 600_000_000).to_string();
        let current_days = |key: &str| {
            attr(&e, key)
                .parse::<i64>()
                .ok()
                .filter(|n| *n < 0 && *n != i64::MIN)
                .map(|n| n.unsigned_abs() / 864_000_000_000)
                .unwrap_or(0)
        };
        let max = max_pwd_age_days
            .map(u64::from)
            .unwrap_or_else(|| current_days("maxPwdAge"));
        let min = min_pwd_age_days
            .map(u64::from)
            .unwrap_or_else(|| current_days("minPwdAge"));
        ensure!(
            max == 0 || min <= max,
            "minimum password age must not exceed maximum password age"
        );
        if let Some(days) = max_pwd_age_days {
            ensure!(days <= 3650, "password age must be at most 3650 days");
            let value = filetime(days);
            modifications.push(Mod::Replace("maxPwdAge".to_owned(), HashSet::from([value])));
        }
        if let Some(days) = min_pwd_age_days {
            ensure!(
                days <= 3650,
                "minimum password age must be at most 3650 days"
            );
            let value = password_interval(days, false);
            modifications.push(Mod::Replace("minPwdAge".to_owned(), HashSet::from([value])));
        }
        if let Some(threshold) = lockout_threshold {
            ensure!(threshold <= 1000, "lockout threshold must be at most 1000");
            let value = threshold.to_string();
            modifications.push(Mod::Replace(
                "lockoutThreshold".to_owned(),
                HashSet::from([value]),
            ));
        }
        if let Some(minutes) = lockout_duration_minutes {
            ensure!(
                minutes <= 60 * 24 * 30,
                "lockout duration must be at most 30 days"
            );
            let value = minutes_filetime(minutes);
            modifications.push(Mod::Replace(
                "lockoutDuration".to_owned(),
                HashSet::from([value]),
            ));
        }
        ensure!(!modifications.is_empty(), "no policy changes requested");
        check(self.ldap.modify(&e.dn, modifications).await?)?;
        self.domain_policy().await
    }
    /// 单账号的有效密码规则：域策略与账号自身状态（永不过期标志、
    /// 必须改密）的合成视图，供员工详情页展示。
    pub async fn effective_policy(&mut self, id: &str) -> Result<Value> {
        let e = self.object(id, false).await?;
        let flags = attr(&e, "userAccountControl").parse::<u32>().unwrap_or(0);
        let mut policy = self.domain_policy().await?;
        let pso = attr(&e, "msDS-ResultantPSO");
        if !pso.is_empty() {
            ensure!(
                pso.to_lowercase().ends_with(&format!(
                    ",cn=password settings container,cn=system,{}",
                    self.c.base_dn.to_lowercase()
                )),
                "password policy outside domain"
            );
            let attributes = [
                ("msDS-MaximumPasswordAge", "maxPwdAge"),
                ("msDS-MinimumPasswordAge", "minPwdAge"),
                ("msDS-MinimumPasswordLength", "minPwdLength"),
                ("msDS-PasswordHistoryLength", "pwdHistoryLength"),
                ("msDS-LockoutThreshold", "lockoutThreshold"),
            ];
            let (rows, _) = self
                .ldap
                .search(
                    &pso,
                    Scope::Base,
                    "(objectClass=msDS-PasswordSettings)",
                    attributes.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
                )
                .await?
                .success()?;
            let rule = rows
                .into_iter()
                .map(SearchEntry::construct)
                .next()
                .ok_or_else(|| anyhow!("password policy not found"))?;
            for (source, target) in attributes {
                policy[target] = json!(attr(&rule, source));
            }
        }
        let days = |v: &Value| -> Option<u64> {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .and_then(|n| {
                    // INT64_MIN 是"未启用"哨兵；>=0（含 0）同样未启用
                    if n >= 0 || n == i64::MIN {
                        None
                    } else {
                        Some((-(n as i128)) as u64 / 864_000_000_000)
                    }
                })
        };
        let never_expires = flags & 0x10000 != 0;
        Ok(json!({
            "neverExpires": never_expires,
            "mustChange": attr(&e, "pwdLastSet") == "0",
            "maxPwdAgeDays": days(&policy["maxPwdAge"]),
            "minPwdAgeDays": days(&policy["minPwdAge"]),
            "minPwdLength": policy["minPwdLength"].as_str().and_then(|v| v.parse::<u32>().ok()),
            "pwdHistoryLength": policy["pwdHistoryLength"].as_str().and_then(|v| v.parse::<u32>().ok()),
            "lockoutThreshold": policy["lockoutThreshold"].as_str().and_then(|v| v.parse::<u32>().ok()),
        }))
    }
    pub async fn snapshot(&mut self) -> Result<Value> {
        let policy = self.domain_policy().await?;
        let max_age = policy["maxPwdAge"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let users = self
            .entries(
                &self.c.users_dn.clone(),
                "(&(objectClass=user)(!(objectClass=computer)))",
            )
            .await?;
        let users: Vec<Value> = users
            .iter()
            .map(|e| {
                let mut value = row(e);
                value["passwordExpiresAt"] = password_expiry(e, max_age);
                value
            })
            .collect();
        let group_filter = format!(
            "(&(objectClass=group)(sAMAccountName={}*))",
            ldap3::ldap_escape(&self.c.group_prefix)
        );
        let groups = self
            .entries(&self.c.groups_dn.clone(), &group_filter)
            .await?;
        let groups = groups
            .iter()
            .map(|e| {
                let mut value = row(e);
                value["manageable"] = json!(
                    value["manageable"] == true
                        && attr(e, "sAMAccountName").starts_with(&self.c.group_prefix)
                );
                value
            })
            .collect::<Vec<_>>();
        Ok(json!({"users":users,"groups":groups,"groupPrefix":self.c.group_prefix,"policy":policy}))
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
    pub async fn create_user(
        &mut self,
        username: &str,
        display: &str,
        pwd: &str,
        profile: &EmployeeProfile,
    ) -> Result<Value> {
        name(username)?;
        text(display)?;
        let encoded = password(pwd)?;
        let profile_attrs = profile.attributes()?;
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
        let mut attrs = vec![
            (
                "objectClass",
                vec!["top", "person", "organizationalPerson", "user"],
            ),
            ("cn", vec![username]),
            ("sAMAccountName", vec![username]),
            ("displayName", vec![display]),
            ("userAccountControl", vec!["514"]),
        ];
        attrs.extend(
            profile_attrs
                .into_iter()
                .filter(|(_, value)| !value.is_empty())
                .map(|(key, value)| (key, vec![value])),
        );
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
        check_password(
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
    pub async fn update_user(
        &mut self,
        id: &str,
        display: &str,
        disabled: bool,
        profile: &EmployeeProfile,
    ) -> Result<Value> {
        text(display)?;
        let mut modifications = profile.modifications()?;
        let e = self.object(id, false).await?;
        let flags = attr(&e, "userAccountControl").parse::<u32>()?;
        let flags = if disabled { flags | 2 } else { flags & !2 };
        let flags = flags.to_string();
        modifications.extend([
            Mod::Replace("displayName", HashSet::from([display])),
            Mod::Replace("userAccountControl", HashSet::from([flags.as_str()])),
        ]);
        check(self.ldap.modify(&e.dn, modifications).await?)?;
        Ok(row(&self.object(id, false).await?))
    }
    pub async fn reset_password(&mut self, id: &str, pwd: &str) -> Result<Value> {
        let e = self.object(id, false).await?;
        let pwd = password(pwd)?;
        check_password(
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
        let bound = self.ldap.simple_bind(&e.dn, old).await?;
        if bound.rc == 49 {
            return Err(AdError {
                code: "AD_CURRENT_PASSWORD_INVALID",
                ldap_code: 49,
            }
            .into());
        }
        check(bound)?;
        let old = old_encoded;
        check_password(
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
        // sAMAccountName is shared by users, groups and computers across the
        // domain, including objects outside the managed employee/group OUs.
        let existing = self
            .entries(
                &self.c.base_dn.clone(),
                &format!("(sAMAccountName={})", ldap3::ldap_escape(n)),
            )
            .await?;
        if !existing.is_empty() {
            return Err(AdError {
                code: "AD_OBJECT_EXISTS",
                ldap_code: 68,
            }
            .into());
        }
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
    pub async fn members(&mut self, id: &str, users: &[String], add: bool) -> Result<Value> {
        ensure!(
            !users.is_empty() && users.len() <= 100,
            "select 1 to 100 employees"
        );
        ensure!(
            users.iter().collect::<HashSet<_>>().len() == users.len(),
            "duplicate employees"
        );
        let group = self.object(id, true).await?;
        let current = group.attrs.get("member").cloned().unwrap_or_default();
        let mut changes = HashSet::new();
        // Resolve and validate every target before issuing a single LDAP Modify.
        // Modifying selected values preserves unselected and unmanaged members.
        for user in users {
            let employee = self.object(user, false).await?;
            let exists = current
                .iter()
                .any(|dn| dn.eq_ignore_ascii_case(&employee.dn));
            if exists != add {
                changes.insert(employee.dn);
            }
        }
        let count = changes.len();
        if count > 0 {
            check(
                self.ldap
                    .modify(
                        &group.dn,
                        vec![if add {
                            Mod::Add("member".to_owned(), changes)
                        } else {
                            Mod::Delete("member".to_owned(), changes)
                        }],
                    )
                    .await?,
            )?;
        }
        let mut result = row(&self.object(id, true).await?);
        result["changedMembers"] = json!(count);
        Ok(result)
    }
    pub async fn principal_sid(&mut self, id: &str, group: bool) -> Result<String> {
        let e = self.object(id, group).await?;
        let s = row(&e)["sid"].as_str().unwrap_or_default().to_owned();
        ensure!(!s.is_empty(), "object SID missing");
        Ok(s)
    }
}
#[derive(Debug)]
pub struct AdError {
    pub code: &'static str,
    ldap_code: u32,
}
impl std::fmt::Display for AdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "AD request rejected ({}, LDAP code {})",
            self.code, self.ldap_code
        )
    }
}
impl std::error::Error for AdError {}

fn check_password(r: ldap3::LdapResult) -> Result<()> {
    if r.rc == 0 {
        return Ok(());
    }
    if matches!(r.rc, 19 | 53) {
        // Read diagnostics only to classify a known condition. Never retain or
        // return diagnostic text, which may contain account or protocol data.
        let diagnostic = r.text.to_ascii_lowercase();
        let restriction = Regex::new(r"\b(?:0000052d|c000006c)\b")
            .unwrap()
            .is_match(&diagnostic);
        let code = if diagnostic.contains("complexity") {
            "AD_PASSWORD_COMPLEXITY"
        } else if diagnostic.contains("password history") || diagnostic.contains("recently used") {
            "AD_PASSWORD_HISTORY"
        } else if diagnostic.contains("too short") {
            "AD_PASSWORD_TOO_SHORT"
        } else if diagnostic.contains("too young") || diagnostic.contains("minimum password age") {
            "AD_PASSWORD_TOO_RECENT"
        } else if restriction {
            "AD_PASSWORD_POLICY"
        } else {
            // Code 53 alone can also mean a permissions/channel restriction.
            "AD_PASSWORD_REJECTED"
        };
        return Err(AdError {
            code,
            ldap_code: r.rc,
        }
        .into());
    }
    check(r)
}

fn check(r: ldap3::LdapResult) -> Result<()> {
    if r.rc == 0 {
        Ok(())
    } else {
        let code = match r.rc {
            8 | 13 => "AD_SECURE_CHANNEL_REQUIRED",
            49 => "AD_AUTHENTICATION_FAILED",
            50 => "AD_PERMISSION_DENIED",
            51 | 52 => "AD_UNAVAILABLE",
            68 => "AD_OBJECT_EXISTS",
            _ => "AD_OPERATION_REJECTED",
        };
        Err(AdError {
            code,
            ldap_code: r.rc,
        }
        .into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ldap_result(rc: u32, text: &str) -> ldap3::LdapResult {
        ldap3::LdapResult {
            rc,
            matched: String::new(),
            text: text.into(),
            refs: vec![],
            ctrls: vec![],
        }
    }
    #[test]
    fn password_rejections_keep_a_safe_reason_without_diagnostics() {
        for (rc, diagnostic, expected) in [
            (
                53,
                "0000052D: password does not meet complexity criteria! secret=DoNotEcho9!",
                "AD_PASSWORD_COMPLEXITY",
            ),
            (
                19,
                "0000052D: password history restriction",
                "AD_PASSWORD_HISTORY",
            ),
            (53, "0000052d: password too short", "AD_PASSWORD_TOO_SHORT"),
            (
                19,
                "0000052D: minimum password age",
                "AD_PASSWORD_TOO_RECENT",
            ),
            (53, "0000052D: password restriction", "AD_PASSWORD_POLICY"),
            (19, "C000006C", "AD_PASSWORD_POLICY"),
            (53, "another directory restriction", "AD_PASSWORD_REJECTED"),
            (50, "private directory diagnostics", "AD_PERMISSION_DENIED"),
            (13, "private TLS diagnostics", "AD_SECURE_CHANNEL_REQUIRED"),
            (52, "private server diagnostics", "AD_UNAVAILABLE"),
        ] {
            let error = check_password(ldap_result(rc, diagnostic)).unwrap_err();
            assert_eq!(error.downcast_ref::<AdError>().unwrap().code, expected);
            assert!(!error.to_string().contains(diagnostic));
            assert!(!format!("{error:?}").contains("DoNotEcho9!"));
        }
        assert!(check_password(ldap_result(0, "")).is_ok());
    }
    #[test]
    fn existing_directory_objects_are_distinct_from_permission_errors() {
        for (rc, expected) in [(68, "AD_OBJECT_EXISTS"), (50, "AD_PERMISSION_DENIED")] {
            let error = check(ldap_result(rc, "private directory diagnostics")).unwrap_err();
            assert_eq!(error.downcast_ref::<AdError>().unwrap().code, expected);
            assert!(!error.to_string().contains("private directory diagnostics"));
        }
    }
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
    #[test]
    fn employee_profile_clears_only_explicit_empty_attributes() {
        let profile: EmployeeProfile =
            serde_json::from_value(json!({"employee_id":"E001", "email":""})).unwrap();
        let modifications = profile.modifications().unwrap();
        assert_eq!(modifications.len(), 2);
        assert!(matches!(&modifications[1], Mod::Replace("mail", values) if values.is_empty()));
        assert!(
            EmployeeProfile {
                department: Some("a\nb".into()),
                ..Default::default()
            }
            .attributes()
            .is_err()
        );
        assert!(
            EmployeeProfile {
                employee_id: Some("a".repeat(17)),
                ..Default::default()
            }
            .attributes()
            .is_err()
        );
        assert!(
            EmployeeProfile {
                email: Some("invalid".into()),
                ..Default::default()
            }
            .attributes()
            .is_err()
        );
    }
}

#[cfg(test)]
mod policy_regressions {
    use super::*;
    fn employee() -> SearchEntry {
        SearchEntry {
            dn: "CN=test,DC=assay,DC=test".into(),
            attrs: std::collections::HashMap::from([
                ("pwdLastSet".into(), vec!["134366400000000000".into()]),
                ("userAccountControl".into(), vec!["512".into()]),
            ]),
            bin_attrs: std::collections::HashMap::new(),
        }
    }
    #[test]
    fn password_expiry_adds_the_absolute_interval_and_honors_ad_computed_policy() {
        let mut e = employee();
        let age = -30 * 864_000_000_000;
        let set = attr(&e, "pwdLastSet").parse::<i64>().unwrap();
        assert_eq!(password_expiry(&e, age), ft_ms(set - age));
        e.attrs.insert(
            "msDS-UserPasswordExpiryTimeComputed".into(),
            vec![(set + 10 * 864_000_000_000i64).to_string()],
        );
        assert_eq!(
            password_expiry(&e, age),
            ft_ms(set + 10 * 864_000_000_000i64)
        );
        e.attrs.insert(
            "msDS-UserPasswordExpiryTimeComputed".into(),
            vec![i64::MAX.to_string()],
        );
        assert_eq!(password_expiry(&e, age), Value::Null);
        e.attrs.remove("msDS-UserPasswordExpiryTimeComputed");
        for sentinel in [0, i64::MIN] {
            assert_eq!(password_expiry(&e, sentinel), Value::Null);
        }
        e.attrs
            .insert("userAccountControl".into(), vec!["66048".into()]);
        assert_eq!(password_expiry(&e, age), Value::Null);
    }
    #[test]
    fn zero_minimum_age_allows_immediate_password_changes() {
        assert_eq!(password_interval(0, false), "0");
        assert_eq!(password_interval(0, true), i64::MIN.to_string());
        assert_eq!(password_interval(1, false), "-864000000000");
        let mut e = employee();
        e.attrs.insert("lockoutTime".into(), vec!["1000".into()]);
        e.attrs.insert(
            "msDS-User-Account-Control-Computed".into(),
            vec!["0".into()],
        );
        assert_eq!(row(&e)["locked"], false);
    }
}
