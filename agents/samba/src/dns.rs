//! AD 集成 DNS 的只读视图。
//! dnsRecord 二进制格式依据 MS-DNSP 2.3.2.2（Samba dnsp_DnssrvRpcRecord），
//! 参考了 Apache-2.0 项目 samba-conductor-ad 的解析器实现：
//! https://github.com/openbasalt/samba-conductor-ad
use crate::ad::Directory;
use anyhow::{Result, anyhow, ensure};
use ldap3::Scope;
use serde_json::{Value, json};

const HEADER: usize = 24;
const VERSION: u8 = 5;
const MAX_RECORDS_PER_NODE: usize = 64;

fn le16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn le32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn be16(b: &[u8], o: usize) -> u16 {
    u16::from_be_bytes([b[o], b[o + 1]])
}
fn be32(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

fn type_name(t: u16) -> String {
    match t {
        1 => "A",
        2 => "NS",
        5 => "CNAME",
        6 => "SOA",
        12 => "PTR",
        15 => "MX",
        16 => "TXT",
        28 => "AAAA",
        33 => "SRV",
        _ => return format!("TYPE{t}"),
    }
    .to_owned()
}

/// NUL 结尾字符串（SOA 的 mname/rname 用此编码而非 dnsp_name）
fn decode_cstr(d: &[u8]) -> Option<(&str, usize)> {
    let end = d.iter().position(|&b| b == 0)?;
    Some((std::str::from_utf8(&d[..end]).ok()?, end + 1))
}

/// dnsp_name：总长、标签数、逐个长度前缀标签、零终结
fn decode_name(d: &[u8]) -> Option<(String, usize)> {    if d.len() < 2 {
        return None;
    }
    let (total, count) = (d[0] as usize, d[1] as usize);
    if d.len() < 2 + total || count > 127 {
        return None;
    }
    let raw = &d[2..2 + total];
    let mut labels = Vec::with_capacity(count);
    let mut off = 0usize;
    for _ in 0..count {
        let len = *raw.get(off)? as usize;
        off += 1;
        let end = off.checked_add(len)?;
        labels.push(String::from_utf8_lossy(raw.get(off..end)?).to_string());
        off = end;
    }
    if off >= raw.len() || raw[off] != 0 {
        return None;
    }
    Some((labels.join("."), 2 + total))
}

/// 解析单个 dnsRecord 值；type 0（墓碑）由调用方跳过
fn decode_record(blob: &[u8]) -> Result<Value> {
    ensure!(blob.len() >= HEADER, "malformed dnsRecord");
    let data_len = le16(blob, 0) as usize;
    ensure!(
        blob.len() >= HEADER + data_len && blob[4] == VERSION,
        "malformed dnsRecord"
    );
    let rtype = le16(blob, 2);
    let ttl = be32(blob, 12);
    let dynamic = le32(blob, 20) != 0;
    let data = &blob[HEADER..HEADER + data_len];
    let text = match rtype {
        1 => {
            ensure!(data_len == 4, "malformed A record");
            std::net::Ipv4Addr::new(data[0], data[1], data[2], data[3]).to_string()
        }
        28 => {
            ensure!(data_len == 16, "malformed AAAA record");
            std::net::Ipv6Addr::from(<[u8; 16]>::try_from(data).unwrap()).to_string()
        }
        2 | 5 | 12 => decode_name(data).ok_or_else(|| anyhow!("malformed name record"))?.0,
        15 => {
            ensure!(data_len >= 3, "malformed MX record");
            format!(
                "{} {}",
                be16(data, 0),
                decode_name(&data[2..]).ok_or_else(|| anyhow!("malformed MX record"))?.0
            )
        }
        33 => {
            ensure!(data_len >= 8, "malformed SRV record");
            format!(
                "{} {} {} {}",
                be16(data, 0),
                be16(data, 2),
                be16(data, 4),
                decode_name(&data[6..]).ok_or_else(|| anyhow!("malformed SRV record"))?.0
            )
        }
        16 => {
            let mut parts: Vec<String> = vec![];
            let mut off = 0usize;
            while off < data.len() {
                let len = data[off] as usize;
                off += 1;
                ensure!(off + len <= data.len(), "malformed TXT record");
                parts.push(String::from_utf8_lossy(&data[off..off + len]).to_string());
                off += len;
            }
            parts.join("")
        }
        6 => {
            // MS-DNSP/Samba 的 SOA：mname/rname 是 NUL 结尾字符串，不是 dnsp_name；
            // 尾部五个整数（serial/refresh/retry/expire/minimum）按小端存储
            let (mname, used) =
                decode_cstr(data).ok_or_else(|| anyhow!("malformed SOA record"))?;
            let rest = &data[used..];
            let (rname, used2) =
                decode_cstr(rest).ok_or_else(|| anyhow!("malformed SOA record"))?;
            ensure!(rest.len() >= used2 + 20, "malformed SOA record");
            let n = &rest[used2..];
            let mut parts: Vec<String> = vec![];
            for name in [mname, rname] {
                if !name.is_empty() {
                    parts.push(name.to_owned());
                }
            }
            for i in 0..5 {
                parts.push(le32(n, i * 4).to_string());
            }
            parts.join(" ")
        }
        _ => format!(
            "\\# {} {}",
            data_len,
            data.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ),
    };
    Ok(json!({"type": type_name(rtype), "ttl": ttl, "data": text, "dynamic": dynamic}))
}

fn zone_name(zone: &str) -> Result<&str> {
    ensure!(
        !zone.is_empty()
            && zone.len() <= 255
            && zone
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ['.', '-', '_'].contains(&c))
            && !zone.starts_with('.')
            && !zone.ends_with('.')
            && !zone.contains(".."),
        "invalid zone name"
    );
    Ok(zone)
}

/// 从 dnsNode/dnsZone 的 DN 中提取区域名。
/// DN 形如 DC=<节点>,DC=<区域>,CN=MicrosoftDNS,...；节点名可含多级
/// （如 DC=_tcp,DC=site,DC=<区域>,...），区域名是紧邻 CN=MicrosoftDNS
/// 之前的那个 DC= 组件。DNS 名不含逗号，直接按组件拆分是安全的。
fn zone_of_dn(dn: &str) -> Option<String> {
    let parts: Vec<&str> = dn.split(',').collect();
    let idx = parts.iter().position(|p| p.eq_ignore_ascii_case("cn=MicrosoftDNS"))?;
    let zone_part = parts.get(idx.checked_sub(1)?)?;
    zone_part.strip_prefix("DC=").or_else(|| zone_part.strip_prefix("dc=")).map(str::to_owned)
}
fn node_of_dn(dn: &str) -> String {
    dn.split(',')
        .next()
        .and_then(|p| {
            p.strip_prefix("DC=")
                .or_else(|| p.strip_prefix("dc="))
        })
        .unwrap_or_default()
        .to_owned()
}

/// 列出 DNS 区域。三个候选位置逐个尝试：任一分区缺失（如 Forest 分区
/// 未承载 DNS 时 base 不存在，rc=32）直接跳过，不使整个查询失败。
/// 部分部署的 zone 容器对象状态异常（无法作为搜索 base），因此从
/// CN=MicrosoftDNS 容器做子树搜索并从 DN 提取区域名。
pub async fn zones(d: &mut Directory) -> Result<Value> {
    let bases = [
        format!("CN=MicrosoftDNS,DC=DomainDnsZones,{}", d.base()),
        format!("CN=MicrosoftDNS,DC=ForestDnsZones,{}", d.base()),
        format!("CN=MicrosoftDNS,CN=System,{}", d.base()),
    ];
    let mut names: Vec<String> = vec![];
    for base in bases {
        let Ok((rows, _)) = d
            .ldap
            .search(
                &base,
                Scope::Subtree,
                "(objectClass=dnsZone)",
                vec!["dc", "cn"],
            )
            .await?
            .success()
        else {
            continue;
        };
        for row in rows {
            let e = ldap3::SearchEntry::construct(row);
            let name = e
                .attrs
                .get("dc")
                .and_then(|v| v.first())
                .cloned()
                .unwrap_or_else(|| zone_of_dn(&e.dn).unwrap_or_default());
            if !name.is_empty() {
                names.push(name);
            }
        }
    }
    names.sort();
    names.dedup();
    ensure!(!names.is_empty(), "no DNS zones visible under any partition");
    Ok(json!({"zones": names}))
}

/// 读取一个区域下全部 dnsNode 的记录（type 0 墓碑跳过）。
/// 从三个候选位置的 CN=MicrosoftDNS 容器做子树搜索，按 DN 中的区域名
/// 分组——不依赖 zone 容器对象本身作为搜索 base（部分部署中该对象
/// 状态异常，base 查询会被目录以 noSuchObject 拒绝）。
pub async fn records(d: &mut Directory, zone: &str) -> Result<Value> {
    let zone = zone_name(zone)?;
    let bases = [
        format!("CN=MicrosoftDNS,DC=DomainDnsZones,{}", d.base()),
        format!("CN=MicrosoftDNS,DC=ForestDnsZones,{}", d.base()),
        format!("CN=MicrosoftDNS,CN=System,{}", d.base()),
    ];
    let mut nodes: Vec<(String, Vec<Value>)> = vec![];
    let mut diagnostics: Vec<Value> = vec![];
    for base in bases {
        match d
            .ldap
            .search(
                &base,
                Scope::Subtree,
                "(objectClass=dnsNode)",
                vec!["dc", "dnsRecord"],
            )
            .await
            .map_err(anyhow::Error::from)
            .and_then(|r| r.success().map_err(anyhow::Error::from))
        {
            Ok((rows, _)) => {
                let sample = rows.iter().take(2).map(|r| {
                    let e = ldap3::SearchEntry::construct(r.clone());
                    json!({"dn": e.dn,
                        "dnsRecord_n": e.bin_attrs.get("dnsRecord").map(|v| v.len()),
                        "blob_heads": e.bin_attrs.get("dnsRecord").map(|v| v.iter().take(2).map(|b| b.iter().take(12).map(|x| format!("{x:02x}")).collect::<String>()).collect::<Vec<_>>())})
                }).collect::<Vec<_>>();
                diagnostics.push(json!({"base": base, "rows": rows.len(), "sample": sample}));
                for row in rows {
                    let e = ldap3::SearchEntry::construct(row);
                    if zone_of_dn(&e.dn).as_deref() != Some(zone) {
                        continue;
                    }
                    let name = e
                        .attrs
                        .get("dc")
                        .and_then(|v| v.first())
                        .cloned()
                        .unwrap_or_else(|| node_of_dn(&e.dn));
            let blobs = e
                .bin_attrs
                .get("dnsRecord")
                .cloned()
                .unwrap_or_default();
            let mut decoded = vec![];
            for blob in blobs.iter().take(MAX_RECORDS_PER_NODE) {
                if le16(blob, 2) == 0 {
                    continue; // 墓碑
                }
                if let Ok(value) = decode_record(blob) {
                    decoded.push(value);
                }
            }
            if !decoded.is_empty() {
                nodes.push((name, decoded));
            }
                }
            }
            Err(e) => diagnostics.push(json!({"base": base, "error": e.to_string()})),
        }
    }
    nodes.sort_by(|a, b| a.0.cmp(&b.0));
    let records: Vec<Value> = nodes
        .into_iter()
        .flat_map(|(name, values)| {
            values
                .into_iter()
                .map(move |mut v| {
                    v["name"] = json!(if name == "@" { zone.to_owned() } else { name.clone() });
                    v
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // 诊断字段仅在没有解析出任何记录时返回，帮助定位分区/属性差异；
    // 前端忽略该字段。
    Ok(json!({"zone": zone, "records": records, "debug": diagnostics}))
}
