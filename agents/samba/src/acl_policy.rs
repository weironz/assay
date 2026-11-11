//! A no-delete directory policy is a tree operation, not a single allow ACE.
//! Preserve data/owners/deny ACEs, remove conflicting non-admin grants, journal
//! every descriptor before writing, and verify the server's effective result.
use crate::{acl, config::Config, inheritance};
use anyhow::{Result, ensure};
use binrw::BinWrite;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use smb::{
    Client, FileAccessMask, FileCreateArgs, Resource, UncPath, info::AdditionalInfo, security::*,
};
use std::{
    fs,
    io::Cursor,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};

pub const WRITE_NO_DELETE: u32 = 0x1201bf;
const FULL: u32 = 0x1f01ff;
// Removing WRITE_DAC/WRITE_OWNER is essential: otherwise a member could simply
// restore DELETE, including via an overlapping Everyone/Creator Owner grant.
const RESTRICTED: u32 = 0x000d0040;
const OWNER_RIGHTS: &str = "S-1-3-4";

fn expand(mask: u32) -> Result<u32> {
    ensure!(
        mask & 0x02000000 == 0,
        "ACL scope contains maximum-allowed grants; review manually"
    );
    let mut value = mask & !0xf0000000;
    for (generic, rights) in [
        (0x10000000, FULL),
        (0x80000000, 0x120089),
        (0x40000000, 0x120116),
        (0x20000000, 0x1200a0),
    ] {
        if mask & generic != 0 {
            value |= rights;
        }
    }
    Ok(value)
}
fn administrators(c: &Config, service: &str) -> Result<Vec<SID>> {
    let domain = service
        .rsplit_once('-')
        .ok_or_else(|| anyhow::anyhow!("invalid service SID"))?
        .0;
    let mut values = vec![service.to_owned(), "S-1-5-18".into(), "S-1-5-32-544".into()];
    values.extend([500, 512, 519].map(|rid| format!("{domain}-{rid}")));
    values.extend(c.acl_admin_sids.clone());
    values
        .into_iter()
        .map(|value| SID::from_str(&value).map_err(anyhow::Error::msg))
        .collect()
}
fn flags(inherit: bool) -> AceFlags {
    AceFlags::new()
        .with_object_inherit(inherit)
        .with_container_inherit(inherit)
}
fn allow(sid: &SID, mask: u32, inherit: bool) -> ACE {
    ACE {
        ace_flags: flags(inherit),
        value: AceValue::AccessAllowed(AccessAce {
            access_mask: AccessMask::from_bytes(mask.to_le_bytes()),
            sid: sid.clone(),
        }),
    }
}
fn protect(
    before: &SecurityDescriptor,
    principal: &SID,
    directory: bool,
    normalize: bool,
    admins: &[SID],
    root: bool,
) -> Result<SecurityDescriptor> {
    ensure!(
        !admins.contains(principal),
        "protected ACL administrator cannot receive no-delete policy"
    );
    let mut after = before.clone();
    let dacl = after
        .dacl
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("null ACL requires manual review"))?;
    let owner_rights = SID::from_str(OWNER_RIGHTS).unwrap();
    for ace in &mut dacl.ace {
        match &mut ace.value {
            AceValue::AccessAllowed(entry) => {
                if admins.contains(&entry.sid) {
                    continue;
                }
                let mask = expand(u32::from_le_bytes(entry.access_mask.into_bytes()))?;
                ensure!(
                    normalize || entry.sid == *principal || mask & RESTRICTED == 0,
                    "ACL scope has overlapping delete or permission-management grants; enable normalization or review manually"
                );
                entry.access_mask = AccessMask::from_bytes((mask & !RESTRICTED).to_le_bytes());
            }
            AceValue::AccessDenied(_) => {}
            _ => anyhow::bail!(
                "ACL scope contains advanced ACEs; review manually before no-delete policy"
            ),
        }
    }
    // Replace only the principal's explicit allow grant; retain all denies and
    // every other principal's read/write permissions and inheritance flags.
    dacl.ace.retain(|ace| {
        if !root {
            return true;
        }
        !(ace
            .value
            .as_access_allowed()
            .is_some_and(|entry| entry.sid == *principal)
            && !ace.ace_flags.inherited())
    });
    if root {
        dacl.insert_ace(allow(principal, WRITE_NO_DELETE, directory));
    }
    // Presence of OWNER RIGHTS suppresses the owner's implicit WRITE_DAC. This
    // ACE adds read-control only, never grants an owner extra file data access.
    if !dacl.ace.iter().any(|ace| {
        !ace.ace_flags.inherit_only()
            && (!directory || (ace.ace_flags.object_inherit() && ace.ace_flags.container_inherit()))
            && ace
                .value
                .as_access_allowed()
                .is_some_and(|entry| entry.sid == owner_rights)
    }) {
        dacl.insert_ace(allow(&owner_rights, 0x20000, directory));
    }
    for admin in admins {
        dacl.ace.retain(|ace| {
            !(!ace.ace_flags.inherited()
                && ace
                    .value
                    .as_access_allowed()
                    .is_some_and(|entry| entry.sid == *admin))
        });
        dacl.insert_ace(allow(admin, FULL, directory));
    }
    // Pin each reviewed descriptor. An ancestor's later broad grant must not
    // silently re-enable delete on an already protected tree.
    after.control.set_dacl_protected(true);
    after.control.set_dacl_auto_inherited(true);
    after.control.set_dacl_computed(true);
    Ok(after)
}
fn verify(
    sd: &SecurityDescriptor,
    before: &SecurityDescriptor,
    principal: &SID,
    admins: &[SID],
    root: bool,
) -> Result<()> {
    ensure!(
        sd.owner_sid == before.owner_sid && sd.group_sid == before.group_sid,
        "ACL scope owner or group changed"
    );
    ensure!(
        !root || sd.control.dacl_protected(),
        "ACL scope protection was not retained by Samba"
    );
    let dacl = sd
        .dacl
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("null ACL after policy update"))?;
    for ace in &dacl.ace {
        match &ace.value {
            AceValue::AccessAllowed(entry) if !admins.contains(&entry.sid) => {
                ensure!(
                    expand(u32::from_le_bytes(entry.access_mask.into_bytes()))? & RESTRICTED == 0,
                    "ACL scope still grants delete; verify acl_xattr configuration before retrying"
                );
            }
            AceValue::AccessAllowed(_) | AceValue::AccessDenied(_) => {}
            _ => anyhow::bail!("ACL scope contains unexpected advanced ACEs"),
        }
    }
    for (sid, mask) in admins
        .iter()
        .map(|sid| (sid, FULL))
        .chain(root.then_some((principal, WRITE_NO_DELETE)))
    {
        ensure!(
            dacl.ace.iter().any(|ace| !ace.ace_flags.inherit_only()
                && ace
                    .value
                    .as_access_allowed()
                    .is_some_and(|entry| entry.sid == *sid
                        && u32::from_le_bytes(entry.access_mask.into_bytes()) & mask == mask)),
            "ACL scope required grant was not retained"
        );
    }
    ensure!(
        dacl.ace.iter().any(|ace| ace
            .value
            .as_access_allowed()
            .is_some_and(|entry| entry.sid.to_string() == OWNER_RIGHTS)),
        "ACL scope owner protection was not retained"
    );
    Ok(())
}
fn encode(sd: &SecurityDescriptor) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    sd.write(&mut cursor)?;
    Ok(cursor.into_inner())
}
#[derive(Serialize, Deserialize)]
struct JournalEntry {
    path: String,
    before: Vec<u8>,
    after: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    request_id: String,
    share_path: String,
    principal: String,
    status: String,
    applied: usize,
    entries: Vec<JournalEntry>,
}
fn persist(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
pub fn ensure_no_pending(c: &Config) -> Result<()> {
    let root = c.state_dir.join("acl-journals");
    if !root.exists() {
        return Ok(());
    }
    for file in fs::read_dir(root)? {
        let file = file?;
        if file
            .file_name()
            .to_string_lossy()
            .ends_with(".progress.json")
        {
            continue;
        }
        if file.path().extension().is_some_and(|ext| ext == "json") {
            let journal: Journal = serde_json::from_slice(&fs::read(file.path())?)?;
            ensure!(
                matches!(journal.status.as_str(), "committed" | "rolled_back"),
                "ACL propagation recovery required; inspect saved journal before further writes"
            );
        }
    }
    Ok(())
}
async fn open(client: &Client, target: &UncPath) -> Result<Resource> {
    Ok(client
        .create_file(
            target,
            &FileCreateArgs::make_open_existing(
                FileAccessMask::new()
                    .with_read_control(true)
                    .with_write_dacl(true),
            ),
        )
        .await?)
}
pub async fn apply(
    c: &Config,
    client: &Client,
    target: &UncPath,
    root: SecurityDescriptor,
    change: &acl::Change<'_>,
) -> Result<Value> {
    let principal = SID::from_str(change.sid).map_err(anyhow::Error::msg)?;
    let admins = administrators(c, change.service_sid)?;
    let mut plan = vec![(
        String::new(),
        root.clone(),
        protect(
            &root,
            &principal,
            true,
            change.normalize_delete_permissions,
            &admins,
            true,
        )?,
    )];
    // Include protected branches deliberately: otherwise existing independent
    // child ACLs could still grant DELETE even after the root looked safe.
    for node in inheritance::prepare_all(client, target, c.acl_max_entries).await? {
        let resource = open(client, &inheritance::append(target, &node.path)).await?;
        let before = inheritance::handle(&resource)
            .query_security_info(inheritance::info())
            .await?;
        inheritance::handle(&resource).close().await?;
        ensure!(
            acl::revision(&before) == node.revision,
            "ACL changed during policy preflight"
        );
        let after = protect(
            &before,
            &principal,
            node.directory,
            change.normalize_delete_permissions,
            &admins,
            false,
        )?;
        plan.push((node.path, before, after));
    }
    if change.preview {
        return Ok(
            json!({"ready":true,"revision":acl::revision(&root),"entries":plan.len(),"administratorSids":admins.iter().map(ToString::to_string).collect::<Vec<_>>(),"normalization":change.normalize_delete_permissions,"writes":false}),
        );
    }
    let directory = c.state_dir.join("acl-journals");
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let id = uuid::Uuid::parse_str(change.request_id)?;
    let path: PathBuf = directory.join(format!("{id}.json"));
    ensure!(!path.exists(), "request ID already has an ACL journal");
    let mut journal = Journal {
        request_id: id.to_string(),
        share_path: target.to_string(),
        principal: change.sid.to_owned(),
        status: "prepared".into(),
        applied: 0,
        entries: plan
            .iter()
            .map(|(path, before, after)| {
                Ok(JournalEntry {
                    path: path.clone(),
                    before: encode(before)?,
                    after: encode(after)?,
                })
            })
            .collect::<Result<_>>()?,
    };
    persist(&path, &journal)?;
    let mut observed = Vec::new();
    let result: Result<()> = async {
        for (index, (relative, before, after)) in plan.iter().enumerate() {
            let resource = open(client, &inheritance::append(target, relative)).await?;
            let handle = inheritance::handle(&resource);
            ensure!(
                acl::revision(&handle.query_security_info(inheritance::info()).await?)
                    == acl::revision(before),
                "ACL changed during policy commit"
            );
            journal.status = "applying".into();
            journal.applied = index + 1;
            // Keep the descriptor snapshot immutable during the loop. Rewriting
            // a complete large tree for every entry would cause quadratic I/O.
            persist(&directory.join(format!("{id}.progress.json")), &json!({"request_id":id.to_string(),"status":journal.status,"applied":journal.applied}))?;
            handle
                .set_security_info(
                    after.clone(),
                    AdditionalInfo::new().with_dacl_security_information(true),
                )
                .await?;
            let actual = handle.query_security_info(inheritance::info()).await?;
            observed.push(acl::revision(&actual));
            verify(&actual, before, &principal, &admins, relative.is_empty())?;
            handle.close().await?;
        }
        // A newly created child may not have existed during preflight. Check
        // the complete live tree again before claiming that policy is active.
        // New children can inherit a safe DACL; existing objects must remain.
        let existing: std::collections::HashMap<_, _> = plan
            .iter()
            .map(|(path, before, _)| (path.as_str(), before))
            .collect();
        let current = inheritance::prepare_all(client, target, c.acl_max_entries).await?;
        let current_paths: std::collections::HashSet<_> =
            current.iter().map(|node| node.path.as_str()).collect();
        ensure!(
            existing
                .keys()
                .all(|path| path.is_empty() || current_paths.contains(path)),
            "ACL scope changed during policy commit; review before retrying"
        );
        for node in current {
            let resource = open(client, &inheritance::append(target, &node.path)).await?;
            let handle = inheritance::handle(&resource);
            let actual = handle.query_security_info(inheritance::info()).await?;
            let before = existing.get(node.path.as_str()).copied().unwrap_or(&actual);
            verify(&actual, before, &principal, &admins, false)?;
            handle.close().await?;
        }
        let resource = open(client, target).await?;
        verify(
            &inheritance::handle(&resource)
                .query_security_info(inheritance::info())
                .await?,
            &root,
            &principal,
            &admins,
            true,
        )?;
        inheritance::handle(&resource).close().await?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let mut complete = observed.len() == journal.applied;
        for index in (0..observed.len()).rev() {
            let (relative, before, _) = &plan[index];
            let restored: Result<()> = async {
                let resource = open(client, &inheritance::append(target, relative)).await?;
                let handle = inheritance::handle(&resource);
                ensure!(
                    acl::revision(&handle.query_security_info(inheritance::info()).await?)
                        == observed[index],
                    "ACL changed during policy rollback"
                );
                handle
                    .set_security_info(
                        before.clone(),
                        AdditionalInfo::new().with_dacl_security_information(true),
                    )
                    .await?;
                let actual = handle.query_security_info(inheritance::info()).await?;
                ensure!(
                    actual.dacl == before.dacl
                        && actual.owner_sid == before.owner_sid
                        && actual.group_sid == before.group_sid,
                    "ACL propagation rollback did not preserve the original descriptor"
                );
                handle.close().await?;
                Ok(())
            }
            .await;
            complete &= restored.is_ok();
        }
        journal.status = if complete {
            "rolled_back"
        } else {
            "recovery_required"
        }
        .into();
        persist(&path, &journal)?;
        if !complete {
            return Err(
                anyhow::Error::new(inheritance::PartialAclUpdate).context(error.to_string())
            );
        }
        return Err(error);
    }
    journal.status = "committed".into();
    persist(&path, &journal)?;
    let resource = open(client, target).await?;
    let mut result = acl::view(
        &inheritance::handle(&resource)
            .query_security_info(inheritance::info())
            .await?,
    );
    inheritance::handle(&resource).close().await?;
    result["propagatedEntries"] = json!(plan.len() - 1);
    result["backupId"] = json!(id.to_string());
    result["deleteProtection"] = json!(true);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sid(n: u32) -> SID {
        SID::from_str(&format!("S-1-5-21-1-2-3-{n}")).unwrap()
    }
    fn descriptor(entries: Vec<ACE>) -> SecurityDescriptor {
        SecurityDescriptor {
            sbz1: 0,
            control: SecurityDescriptorControl::new()
                .with_self_relative(true)
                .with_dacl_present(true),
            owner_sid: Some(sid(1100)),
            group_sid: Some(sid(513)),
            sacl: None,
            dacl: Some(ACL {
                acl_revision: AclRevision::Nt4,
                ace: entries,
            }),
        }
    }
    #[test]
    fn overlapping_everyone_and_owner_grants_cannot_restore_delete_but_leaders_keep_full() {
        let staff = sid(1200);
        let leader = sid(1300);
        let everyone = SID::from_str("S-1-1-0").unwrap();
        let before = descriptor(vec![
            allow(&staff, FULL, true),
            allow(&everyone, 0x10000000, true),
            allow(&sid(1100), FULL, false),
        ]);
        let after = protect(
            &before,
            &staff,
            true,
            true,
            std::slice::from_ref(&leader),
            true,
        )
        .unwrap();
        verify(&after, &before, &staff, std::slice::from_ref(&leader), true).unwrap();
        assert_eq!(before.owner_sid, after.owner_sid);
        assert!(
            after.dacl.unwrap().ace.iter().any(|a| a
                .value
                .as_access_allowed()
                .is_some_and(
                    |e| e.sid == leader && u32::from_le_bytes(e.access_mask.into_bytes()) == FULL
                ))
        );
    }
    #[test]
    fn ambiguous_overlap_requires_explicit_normalization() {
        let before = descriptor(vec![allow(&SID::from_str("S-1-1-0").unwrap(), FULL, true)]);
        assert!(protect(&before, &sid(1200), true, false, &[sid(1300)], true).is_err());
    }
    #[test]
    fn protected_children_are_restricted_without_removing_other_read_write_or_deny_entries() {
        let deny = ACE {
            ace_flags: AceFlags::new(),
            value: AceValue::AccessDenied(AccessAce {
                access_mask: AccessMask::from_bytes(2u32.to_le_bytes()),
                sid: sid(1400),
            }),
        };
        let mut before = descriptor(vec![allow(&sid(1400), FULL, false), deny.clone()]);
        before.control.set_dacl_protected(true);
        let after = protect(&before, &sid(1200), false, true, &[sid(1300)], false).unwrap();
        assert!(after.dacl.as_ref().unwrap().ace.contains(&deny));
        assert!(after.dacl.unwrap().ace.iter().any(|a| {
            a.value.as_access_allowed().is_some_and(|e| {
                e.sid == sid(1400)
                    && u32::from_le_bytes(e.access_mask.into_bytes()) == WRITE_NO_DELETE
            })
        }));
    }
    #[test]
    fn administrator_cannot_be_accidentally_downgraded() {
        assert!(
            protect(
                &descriptor(vec![]),
                &sid(1300),
                true,
                true,
                &[sid(1300)],
                true
            )
            .is_err()
        );
    }
    #[test]
    fn readback_rejects_an_acl_backend_that_ignored_the_policy() {
        let before = descriptor(vec![allow(&sid(1200), FULL, false)]);
        assert!(verify(&before, &before, &sid(1200), &[sid(1300)], true).is_err());
    }
    #[test]
    fn restricting_an_existing_child_never_grants_new_data_access_to_staff() {
        let staff = sid(1200);
        let before = descriptor(vec![allow(&sid(1400), 0x1200a9, false)]);
        let after = protect(&before, &staff, false, true, &[sid(1300)], false).unwrap();
        assert!(!after.dacl.as_ref().unwrap().ace.iter().any(|ace| {
            ace.value
                .as_access_allowed()
                .is_some_and(|entry| entry.sid == staff)
        }));
        assert!(after.dacl.as_ref().unwrap().ace.iter().any(|ace| {
            ace.value.as_access_allowed().is_some_and(|entry| {
                entry.sid == sid(1400)
                    && u32::from_le_bytes(entry.access_mask.into_bytes()) == 0x1200a9
            })
        }));
    }
}
