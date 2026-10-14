//! Reconcile only the changed principal's inherited allow ACEs.
//! Explicit entries, deny/advanced entries and protected branches remain intact.
use anyhow::{Result, ensure};
use futures_util::StreamExt;
use smb::{
    Client, Directory, FileAccessMask, FileCreateArgs, FileDirectoryInformation, Resource, UncPath,
    info::AdditionalInfo, security::*,
};
use std::{collections::HashMap, sync::Arc};

const MAX_CHILDREN: usize = 10_000;
#[derive(Debug)]
pub struct PartialAclUpdate;
impl std::fmt::Display for PartialAclUpdate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ACL propagation incomplete; inspect operation and resource before retrying")
    }
}
impl std::error::Error for PartialAclUpdate {}
pub struct Node {
    path: String,
    parent: String,
    directory: bool,
    revision: String,
}
fn info() -> AdditionalInfo {
    AdditionalInfo::new()
        .with_owner_security_information(true)
        .with_group_security_information(true)
        .with_dacl_security_information(true)
}
fn handle(r: &Resource) -> &smb::ResourceHandle {
    match r {
        Resource::Directory(d) => d.handle(),
        Resource::File(f) => f.handle(),
        _ => unreachable!("no pipe paths in managed shares"),
    }
}
fn append(base: &UncPath, relative: &str) -> UncPath {
    if relative.is_empty() {
        base.clone()
    } else {
        base.clone().with_add_path(relative)
    }
}
pub async fn prepare(client: &Client, base: &UncPath) -> Result<Vec<Node>> {
    let mut stack = vec![String::new()];
    let mut nodes = vec![];
    while let Some(parent) = stack.pop() {
        let resource = client
            .create_file(
                &append(base, &parent),
                &FileCreateArgs::make_open_existing(
                    FileAccessMask::new()
                        .with_generic_read(true)
                        .with_file_read_data(true)
                        .with_read_control(true),
                ),
            )
            .await?;
        let dir = Arc::new(resource.unwrap_dir());
        let mut stream = Directory::query::<FileDirectoryInformation>(&dir, "*").await?;
        while let Some(entry) = stream.next().await {
            let entry = entry?;
            let name = entry.file_name.to_string();
            if name == "." || name == ".." {
                continue;
            }
            ensure!(
                !name.contains(['\\', '/', '\0']),
                "ACL scope contains an unsafe name"
            );
            ensure!(
                !entry.file_attributes.reparse_point(),
                "ACL scope contains a reparse point; review the directory before applying inheritance"
            );
            let path = if parent.is_empty() {
                name
            } else {
                format!("{parent}\\{name}")
            };
            let child = client
                .create_file(
                    &append(base, &path),
                    &FileCreateArgs::make_open_existing(
                        FileAccessMask::new()
                            .with_read_control(true)
                            .with_write_dacl(true),
                    ),
                )
                .await?;
            let sd = handle(&child).query_security_info(info()).await?;
            handle(&child).close().await?;
            ensure!(sd.dacl.is_some(), "null ACL requires manual review");
            if sd.control.dacl_protected() {
                continue;
            }
            let directory = entry.file_attributes.directory();
            nodes.push(Node {
                path: path.clone(),
                parent: parent.clone(),
                directory,
                revision: crate::acl::revision(&sd),
            });
            ensure!(
                nodes.len() <= MAX_CHILDREN,
                "ACL scope exceeds 10000 entries; apply changes to a smaller directory"
            );
            if directory {
                stack.push(path);
            }
        }
        drop(stream);
        dir.handle().close().await?;
    }
    // Parent-first traversal regardless of server enumeration order.
    nodes.sort_by_key(|n| n.path.bytes().filter(|c| *c == b'\\').count());
    Ok(nodes)
}
fn inherited(parent: &SecurityDescriptor, sid: &SID, directory: bool) -> Vec<ACE> {
    let mut out = vec![];
    if let Some(acl) = &parent.dacl {
        for ace in &acl.ace {
            if !ace.value.as_access_allowed().is_some_and(|a| a.sid == *sid) {
                continue;
            }
            let mut copy = ace.clone();
            let f = ace.ace_flags;
            if directory {
                if !f.container_inherit() && !f.object_inherit() {
                    continue;
                }
                if f.no_propagate_inherit() && !f.container_inherit() {
                    continue;
                }
                copy.ace_flags.set_inherit_only(!f.container_inherit());
                if f.no_propagate_inherit() {
                    copy.ace_flags.set_object_inherit(false);
                    copy.ace_flags.set_container_inherit(false);
                    copy.ace_flags.set_no_propagate_inherit(false);
                }
            } else {
                if !f.object_inherit() {
                    continue;
                }
                copy.ace_flags = AceFlags::new();
            }
            copy.ace_flags.set_inherited(true);
            out.push(copy);
        }
    }
    out
}
fn reconcile(
    child: &mut SecurityDescriptor,
    parent: &SecurityDescriptor,
    sid: &SID,
    directory: bool,
) {
    if child.control.dacl_protected() {
        return;
    }
    if let Some(acl) = &mut child.dacl {
        acl.ace.retain(|a| {
            !(a.ace_flags.inherited() && a.value.as_access_allowed().is_some_and(|v| v.sid == *sid))
        });
        for ace in inherited(parent, sid, directory) {
            acl.insert_ace(ace);
        }
        child.control.set_dacl_auto_inherited(true);
        child.control.set_dacl_computed(true);
    }
}
pub async fn apply(
    client: &Client,
    base: &UncPath,
    root: &SecurityDescriptor,
    sid: &SID,
    nodes: Vec<Node>,
) -> Result<usize> {
    let mut parents = HashMap::from([(String::new(), root.clone())]);
    let mut changed = 0;
    for node in nodes {
        let parent = parents
            .get(&node.parent)
            .ok_or_else(|| anyhow::anyhow!(PartialAclUpdate))?;
        let child = client
            .create_file(
                &append(base, &node.path),
                &FileCreateArgs::make_open_existing(
                    FileAccessMask::new()
                        .with_read_control(true)
                        .with_write_dacl(true),
                ),
            )
            .await?;
        let mut sd = handle(&child).query_security_info(info()).await?;
        // Refuse to overwrite changes made outside this Agent during preflight.
        ensure!(
            crate::acl::revision(&sd) == node.revision,
            "ACL changed during propagation; inspect resource before retrying"
        );
        let before = sd.clone();
        reconcile(&mut sd, parent, sid, node.directory);
        if sd != before {
            handle(&child)
                .set_security_info(
                    sd.clone(),
                    AdditionalInfo::new().with_dacl_security_information(true),
                )
                .await?;
            sd = handle(&child).query_security_info(info()).await?;
            changed += 1;
        }
        handle(&child).close().await?;
        if node.directory {
            parents.insert(node.path, sd);
        }
    }
    Ok(changed)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;
    fn ace(sid: &SID, mask: u32, inherited: bool) -> ACE {
        ACE {
            ace_flags: AceFlags::new()
                .with_object_inherit(true)
                .with_container_inherit(true)
                .with_inherited(inherited),
            value: AceValue::AccessAllowed(AccessAce {
                access_mask: AccessMask::from_bytes(mask.to_le_bytes()),
                sid: sid.clone(),
            }),
        }
    }
    fn sd(entries: Vec<ACE>) -> SecurityDescriptor {
        SecurityDescriptor {
            sbz1: 0,
            control: SecurityDescriptorControl::new()
                .with_self_relative(true)
                .with_dacl_present(true),
            owner_sid: None,
            group_sid: None,
            sacl: None,
            dacl: Some(ACL {
                acl_revision: AclRevision::Nt4,
                ace: entries,
            }),
        }
    }
    #[test]
    fn propagation_keeps_the_selected_subdirectory() {
        let base = UncPath::from_str(r"\\server\share\selected").unwrap();
        assert_eq!(append(&base, "").path(), Some("selected"));
        assert_eq!(
            append(&base, r"child\file").path(),
            Some(r"selected\child\file")
        );
    }
    #[test]
    fn downgrade_existing_file_preserves_explicit_grants_and_denies() {
        let sid = SID::from_str("S-1-5-21-1-2-3-1200").unwrap();
        let other = SID::from_str("S-1-5-21-1-2-3-1300").unwrap();
        let explicit = ace(&sid, 0x1200a9, false);
        let unrelated = ace(&other, 0x1f01ff, true);
        let deny = ACE {
            ace_flags: AceFlags::new(),
            value: AceValue::AccessDenied(AccessAce {
                sid: sid.clone(),
                access_mask: AccessMask::from_bytes(2u32.to_le_bytes()),
            }),
        };
        let mut child = sd(vec![
            explicit.clone(),
            deny.clone(),
            unrelated.clone(),
            ace(&sid, 0x1301bf, true),
        ]);
        reconcile(
            &mut child,
            &sd(vec![ace(&sid, 0x1200a9, false)]),
            &sid,
            false,
        );
        assert!(child.control.dacl_auto_inherited() && child.control.dacl_computed());
        let entries = &child.dacl.unwrap().ace;
        assert!(
            entries.contains(&explicit) && entries.contains(&deny) && entries.contains(&unrelated)
        );
        assert!(!entries.iter().any(|a| a.ace_flags.inherited()
            && a.value.as_access_allowed().is_some_and(
                |a| a.sid == sid && u32::from_le_bytes(a.access_mask.into_bytes()) == 0x1301bf
            )));
    }
    #[test]
    fn protected_acl_is_not_rewritten() {
        let sid = SID::from_str("S-1-5-21-1-2-3-1200").unwrap();
        let mut child = sd(vec![ace(&sid, 0x1301bf, true)]);
        child.control.set_dacl_protected(true);
        let before = child.clone();
        reconcile(&mut child, &sd(vec![]), &sid, true);
        assert_eq!(child, before);
    }
    #[test]
    fn remove_parent_grant_revokes_inherited_access() {
        let sid = SID::from_str("S-1-5-21-1-2-3-1200").unwrap();
        let mut child = sd(vec![ace(&sid, 0x1301bf, true)]);
        reconcile(&mut child, &sd(vec![]), &sid, false);
        assert!(child.dacl.unwrap().ace.is_empty());
    }
}
