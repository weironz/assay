use crate::config::{Config, secret};
use crate::files;
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use smb::{
    Client, ClientConfig, FileAccessMask, FileCreateArgs, UncPath, info::AdditionalInfo,
    security::*,
};
use std::str::FromStr;

pub(crate) fn revision(sd: &SecurityDescriptor) -> String {
    format!("{:x}", Sha256::digest(format!("{sd:?}").as_bytes()))
}
fn view(sd: &SecurityDescriptor) -> Value {
    let entries=sd.dacl.as_ref().map(|acl|acl.ace.iter().map(|ace| {
        let simple=match &ace.value {AceValue::AccessAllowed(a)=>Some((a,"allow")),AceValue::AccessDenied(a)=>Some((a,"deny")),_=>None};
        if let Some((a,effect))=simple {json!({"sid":a.sid.to_string(),"effect":effect,"mask":u32::from_le_bytes(a.access_mask.into_bytes()),"inherited":ace.ace_flags.inherited(),"inherit":ace.ace_flags.object_inherit()||ace.ace_flags.container_inherit()})}
        else {json!({"effect":"advanced","details":format!("{:?}",ace.value),"inherited":ace.ace_flags.inherited()})}
    }).collect::<Vec<_>>()).unwrap_or_default();
    json!({"revision":revision(sd),"owner":sd.owner_sid.as_ref().map(ToString::to_string),"group":sd.group_sid.as_ref().map(ToString::to_string),"protected":sd.control.dacl_protected(),"entries":entries})
}
pub async fn access(
    c: &Config,
    share: &str,
    path: &str,
    change: Option<(&str, &str, bool, &str)>,
) -> Result<Value> {
    crate::ad::name(share)?;
    files::components(path)?;
    // Verify the share and path against the local helper's managed namespace.
    files::call(
        c,
        files::Local::Directories {
            share: share.to_owned(),
            path: path.to_owned(),
        },
    )
    .await?;
    let mut config = ClientConfig {
        dfs: false,
        ..Default::default()
    };
    config.connection.timeout = Some(std::time::Duration::from_secs(10));
    config.connection.encryption_mode = smb::connection::EncryptionMode::Required;
    config.connection.compression_enabled = false;
    let client = Client::new(config);
    let target = UncPath::from_str(&format!("\\\\{}\\{}", c.smb_server, share))?;
    client
        .share_connect(&target, &c.smb_username, secret(&c.ldap_password_file)?)
        .await?;
    let target = target.with_path(&path.replace('/', "\\"));
    let rights = FileAccessMask::new()
        .with_read_control(true)
        .with_write_dacl(change.is_some());
    let resource = client
        .create_file(&target, &FileCreateArgs::make_open_existing(rights))
        .await?;
    let handle = match &resource {
        smb::Resource::Directory(d) => d.handle(),
        smb::Resource::File(f) => f.handle(),
        _ => anyhow::bail!("directory required"),
    };
    let info = AdditionalInfo::new()
        .with_owner_security_information(true)
        .with_group_security_information(true)
        .with_dacl_security_information(true);
    let mut sd = handle.query_security_info(info).await?;
    let mut propagated = 0;
    if let Some((sid, mode, inherit, expected)) = change {
        ensure!(
            revision(&sd) == expected,
            "ACL changed; refresh and review before retrying"
        );
        let descendants = crate::inheritance::prepare(&client, &target).await?;
        ensure!(
            revision(&handle.query_security_info(info).await?) == expected,
            "ACL changed during preflight; refresh before retrying"
        );
        let sid = SID::from_str(sid).map_err(anyhow::Error::msg)?;
        let dacl = sd
            .dacl
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("null ACL requires manual review"))?;
        // Preserve inherited, deny and advanced ACEs. Replace only this principal's explicit allow entry.
        dacl.ace.retain(|a| {
            !(a.value.as_access_allowed().is_some_and(|v| v.sid == sid) && !a.ace_flags.inherited())
        });
        let mask = match mode {
            "read" => Some(0x1200a9u32),
            "modify" => Some(0x1301bfu32),
            "full" => Some(0x1f01ffu32),
            "remove" => None,
            _ => anyhow::bail!("invalid access mode"),
        };
        if let Some(mask) = mask {
            dacl.insert_ace(ACE {
                ace_flags: AceFlags::new()
                    .with_object_inherit(inherit)
                    .with_container_inherit(inherit),
                value: AceValue::AccessAllowed(AccessAce {
                    access_mask: AccessMask::from_bytes(mask.to_le_bytes()),
                    sid: sid.clone(),
                }),
            });
        }
        // Samba canonicalizes inheritance unless DI and DR are both present (MS-DTYP).
        sd.control.set_dacl_auto_inherited(true);
        sd.control.set_dacl_computed(true);
        // Only DACL is changed; owner/group/SACL are never written by this operation.
        handle
            .set_security_info(
                sd.clone(),
                AdditionalInfo::new().with_dacl_security_information(true),
            )
            .await?;
        sd = handle.query_security_info(info).await?;
        propagated = crate::inheritance::apply(&client, &target, &sd, &sid, descendants)
            .await
            .map_err(|_| anyhow::anyhow!(crate::inheritance::PartialAclUpdate))?;
    }
    let mut out = view(&sd);
    out["propagatedEntries"] = json!(propagated);
    handle.close().await?;
    Ok(out)
}
pub async fn initialize(
    c: &Config,
    share: &str,
    service_sid: &str,
    groups: &[String],
    read_only: bool,
) -> Result<()> {
    let mut config = ClientConfig {
        dfs: false,
        ..Default::default()
    };
    config.connection.encryption_mode = smb::connection::EncryptionMode::Required;
    config.connection.compression_enabled = false;
    let client = Client::new(config);
    let target = UncPath::from_str(&format!("\\\\{}\\{}", c.smb_server, share))?;
    // Configuration reload is asynchronous. Retry only read-only connection establishment.
    let mut connected = false;
    for _ in 0..20 {
        if client
            .share_connect(&target, &c.smb_username, secret(&c.ldap_password_file)?)
            .await
            .is_ok()
        {
            connected = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    ensure!(connected, "share configuration not yet loaded");
    let resource = client
        .create_file(
            &target,
            &FileCreateArgs::make_open_existing(
                FileAccessMask::new()
                    .with_read_control(true)
                    .with_write_dacl(true),
            ),
        )
        .await?;
    let handle = match &resource {
        smb::Resource::Directory(d) => d.handle(),
        smb::Resource::File(f) => f.handle(),
        _ => anyhow::bail!("directory required"),
    };
    let mut sd = handle
        .query_security_info(
            AdditionalInfo::new()
                .with_owner_security_information(true)
                .with_group_security_information(true)
                .with_dacl_security_information(true),
        )
        .await?;
    let mut entries = vec![];
    for (sid, mask) in std::iter::once((service_sid, 0x1f01ffu32))
        .chain(std::iter::once(("S-1-5-18", 0x1f01ffu32)))
        .chain(
            groups
                .iter()
                .map(|s| (s.as_str(), if read_only { 0x1200a9 } else { 0x1301bf })),
        )
    {
        entries.push(ACE {
            ace_flags: AceFlags::new()
                .with_object_inherit(true)
                .with_container_inherit(true),
            value: AceValue::AccessAllowed(AccessAce {
                access_mask: AccessMask::from_bytes(mask.to_le_bytes()),
                sid: SID::from_str(sid).map_err(anyhow::Error::msg)?,
            }),
        });
    }
    sd.control.set_dacl_present(true);
    sd.control.set_dacl_protected(true);
    sd.control.set_dacl_auto_inherited(true);
    sd.control.set_dacl_computed(true);
    sd.dacl = Some(ACL {
        acl_revision: AclRevision::Nt4,
        ace: entries,
    });
    handle
        .set_security_info(
            sd,
            AdditionalInfo::new().with_dacl_security_information(true),
        )
        .await?;
    handle.close().await?;
    Ok(())
}
pub async fn directory(c: &Config, share: &str, path: &str, delete: bool) -> Result<Value> {
    let mut parts = files::components(path)?;
    ensure!(!parts.is_empty(), "share root cannot be removed");
    parts.pop();
    files::call(
        c,
        files::Local::Directories {
            share: share.to_owned(),
            path: parts.join("/"),
        },
    )
    .await?;
    let mut config = ClientConfig {
        dfs: false,
        ..Default::default()
    };
    config.connection.encryption_mode = smb::connection::EncryptionMode::Required;
    config.connection.compression_enabled = false;
    let client = Client::new(config);
    let target = UncPath::from_str(&format!("\\\\{}\\{}", c.smb_server, share))?;
    client
        .share_connect(&target, &c.smb_username, secret(&c.ldap_password_file)?)
        .await?;
    let args = if delete {
        FileCreateArgs {
            options: smb::create::CreateOptions::new()
                .with_directory_file(true)
                .with_delete_on_close(true),
            ..FileCreateArgs::make_open_existing(FileAccessMask::new().with_delete(true))
        }
    } else {
        FileCreateArgs::make_create_new(
            smb::FileAttributes::new().with_directory(true),
            smb::create::CreateOptions::new().with_directory_file(true),
        )
    };
    let resource = client
        .create_file(&target.with_path(&path.replace('/', "\\")), &args)
        .await?;
    let handle = match &resource {
        smb::Resource::Directory(d) => d.handle(),
        _ => anyhow::bail!("directory required"),
    };
    handle.close().await?;
    Ok(json!({"path":path,"deleted":delete}))
}
