use super::Error;

pub fn validate(path: &str, root: bool) -> Result<(), Error> {
    if path.len() > 4096 || (!root && path.is_empty()) {
        return Err(Error::invalid());
    }
    if path.is_empty() {
        return Ok(());
    }
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.encode_utf16().count() > 255
            || part.to_ascii_lowercase().starts_with(".assay-upload-")
            || part
                .chars()
                .any(|c| c.is_control() || "\\:*?\"<>|".contains(c))
        {
            return Err(Error::invalid());
        }
    }
    Ok(())
}
pub fn share(name: &str) -> Result<(), Error> {
    validate(name, false)?;
    if name.contains('/') || name.ends_with('$') {
        return Err(Error::invalid());
    }
    Ok(())
}
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
}
pub fn attachment(name: &str) -> String {
    let encoded = name
        .as_bytes()
        .iter()
        .map(|b| format!("%{b:02X}"))
        .collect::<String>();
    format!("attachment; filename=\"download\"; filename*=UTF-8''{encoded}")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_escape_and_internal_names() {
        for p in [
            "../a",
            "a/../b",
            "/a",
            "a//b",
            "a\\b",
            "a:stream",
            "a.",
            "a ",
            "a\n",
            "a/*",
            ".assay-upload-123",
            "x/.ASSAY-upload-y",
        ] {
            assert!(validate(p, true).is_err(), "{p}");
        }
        for p in ["", "部门/年度报表.pdf", "hello world.txt"] {
            assert!(validate(p, true).is_ok(), "{p}");
        }
        assert!(validate("", false).is_err());
        assert!(share("IPC$").is_err());
    }
    #[test]
    fn download_header_cannot_inject_headers() {
        let value = attachment("中文\r\nX: y.txt");
        assert!(!value.contains('\r'));
        assert!(!value.contains('\n'));
        assert!(value.contains("%E4%B8%AD"));
    }
}
