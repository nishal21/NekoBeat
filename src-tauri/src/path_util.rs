use std::path::{Path, PathBuf};

/// True for `C:\...` / `D:/...` style paths.
pub fn looks_like_windows_path(path: &str) -> bool {
    let t = path.trim();
    let bytes = t.as_bytes();
    bytes.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic()
}

/// Resolve a local audio path for GStreamer. Rejects missing files and Windows paths on Linux/macOS.
pub fn resolve_playable_local_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Empty file path".into());
    }

    #[cfg(not(target_os = "windows"))]
    if looks_like_windows_path(trimmed) {
        return Err(format!(
            "This track was saved on Windows and is not available on this machine: {}",
            trimmed
        ));
    }

    let path_buf = PathBuf::from(trimmed);
    if path_buf.exists() {
        return path_buf.canonicalize().map_err(|e| e.to_string());
    }

    // Allow file:/// URIs passed as paths
    if trimmed.starts_with("file:") {
        if let Ok(u) = url::Url::parse(trimmed) {
            if let Ok(decoded) = u.to_file_path() {
                if decoded.exists() {
                    return decoded.canonicalize().map_err(|e| e.to_string());
                }
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(rest) = trimmed.strip_prefix("file://") {
                let path = if rest.starts_with('/') {
                    PathBuf::from(rest)
                } else {
                    PathBuf::from(format!("/{}", rest))
                };
                if path.exists() {
                    return path.canonicalize().map_err(|e| e.to_string());
                }
            }
        }
        #[cfg(windows)]
        {
            let stripped = trimmed
                .strip_prefix("file:///")
                .or_else(|| trimmed.strip_prefix("file://"))
                .unwrap_or(trimmed);
            let decoded = PathBuf::from(stripped);
            if decoded.exists() {
                return decoded.canonicalize().map_err(|e| e.to_string());
            }
        }
    }

    Err(format!("File not found: {}", trimmed))
}

pub fn path_to_file_uri(path: &Path) -> String {
    if let Ok(url) = url::Url::from_file_path(path) {
        return url.to_string();
    }
    format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
}
