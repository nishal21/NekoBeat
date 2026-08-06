//! Bridge to SpotiFLAC Mobile go_backend via spotiflac-cli sidecar.
//! Every invoke is a new process — always pass extensionsDir/dataDir (or env).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const BIN_NAME: &str = "spotiflac-cli.exe";
#[cfg(not(windows))]
const BIN_NAME: &str = "spotiflac-cli";

pub fn find_cli(app: Option<&AppHandle>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(app) = app {
        if let Ok(res) = app.path().resource_dir() {
            candidates.push(res.join("bin").join(BIN_NAME));
            candidates.push(res.join(BIN_NAME));
        }
        if let Ok(exe) = app.path().executable_dir() {
            candidates.push(exe.join("bin").join(BIN_NAME));
            candidates.push(exe.join(BIN_NAME));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bin").join(BIN_NAME));
            candidates.push(dir.join(BIN_NAME));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("bin").join(BIN_NAME));

    for c in candidates {
        if let Ok(canon) = c.canonicalize() {
            if canon.is_file() {
                return Some(canon);
            }
        } else if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ext = root.join("extensions");
    let data = root.join("extension-data");
    std::fs::create_dir_all(&ext).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    Ok((ext, data))
}

fn with_dirs(app: Option<&AppHandle>, mut args: Value) -> Result<(Option<(String, String)>, Value), String> {
    let dirs = if let Some(app) = app {
        let (ext, data) = dirs(app)?;
        Some((
            ext.to_string_lossy().into_owned(),
            data.to_string_lossy().into_owned(),
        ))
    } else {
        None
    };
    if let Some((ext, data)) = &dirs {
        if let Some(obj) = args.as_object_mut() {
            obj.entry("extensionsDir".to_string())
                .or_insert_with(|| json!(ext));
            obj.entry("dataDir".to_string())
                .or_insert_with(|| json!(data));
        }
    }
    Ok((dirs, args))
}

pub fn call(app: Option<&AppHandle>, cmd: &str, args: Value) -> Result<Value, String> {
    let bin = find_cli(app).ok_or_else(|| {
        "spotiflac-cli not found — run scripts/build-spotiflac-cli.ps1".to_string()
    })?;
    let (dirs, args) = with_dirs(app, args)?;
    let payload = json!({ "cmd": cmd, "args": args }).to_string();
    let mut c = Command::new(&bin);
    hide_console(&mut c);
    if let Some((ext, data)) = dirs {
        c.env("NEKOBEAT_EXT_DIR", ext);
        c.env("NEKOBEAT_EXT_DATA", data);
    }
    let output = c
        .arg(&payload)
        .output()
        .map_err(|e| format!("spotiflac-cli spawn: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // Filter noisy GoLog lines from stderr for error parsing
    let err_json = stderr
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or(stderr.as_str());
    if !output.status.success() {
        if let Ok(v) = serde_json::from_str::<Value>(err_json) {
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
        }
        return Err(if stderr.is_empty() {
            format!("spotiflac-cli failed ({})", output.status)
        } else {
            stderr.chars().take(400).collect()
        });
    }
    // stdout may include GoLog lines before JSON
    let json_line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or(stdout.as_str());
    let v: Value = serde_json::from_str(json_line)
        .map_err(|e| format!("spotiflac-cli json: {e} — {json_line}"))?;
    if v.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        return Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("spotiflac-cli error")
            .to_string());
    }
    Ok(v.get("data").cloned().unwrap_or(v))
}

pub fn ensure_runtime(app: &AppHandle) -> Result<Value, String> {
    let (ext, data) = dirs(app)?;
    call(
        Some(app),
        "init",
        json!({
            "extensionsDir": ext.to_string_lossy(),
            "dataDir": data.to_string_lossy(),
        }),
    )
}

pub fn load_package(app: &AppHandle, path: &Path) -> Result<Value, String> {
    call(
        Some(app),
        "load-file",
        json!({ "path": path.to_string_lossy() }),
    )
}

pub fn search(app: &AppHandle, query: &str, limit: i32) -> Result<Value, String> {
    call(
        Some(app),
        "search",
        json!({
            "query": query,
            "limit": limit,
            "includeExtensions": true,
        }),
    )
}

/// Fast SpotiFLAC Mobile–style search against one metadata provider (e.g. spotify-web).
pub fn search_provider(
    app: &AppHandle,
    provider_id: &str,
    query: &str,
    limit: i32,
) -> Result<Value, String> {
    call(
        Some(app),
        "search",
        json!({
            "query": query,
            "limit": limit,
            "includeExtensions": true,
            "providerId": provider_id,
        }),
    )
}

/// Ask installed metadata extensions (spotify-web, …) for cover art.
pub fn lookup_cover(
    app: &AppHandle,
    artist: &str,
    title: &str,
    album: Option<&str>,
) -> Result<Option<String>, String> {
    if artist.trim().is_empty() && title.trim().is_empty() {
        return Ok(None);
    }
    let data = call(
        Some(app),
        "lookup-cover",
        json!({
            "artist": artist,
            "title": title,
            "album": album.unwrap_or(""),
        }),
    )?;
    let url = data
        .get("coverUrl")
        .or_else(|| data.get("cover_url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.starts_with("http"))
        .map(|s| s.to_string());
    Ok(url)
}

pub fn download(app: &AppHandle, req: Value) -> Result<Value, String> {
    call(Some(app), "download", req)
}

pub fn set_settings(app: &AppHandle, id: &str, settings: Value) -> Result<(), String> {
    call(
        Some(app),
        "set-settings",
        json!({ "extensionId": id, "settings": settings }),
    )?;
    Ok(())
}

pub fn set_priority(app: &AppHandle, download: &[String], metadata: &[String]) -> Result<(), String> {
    call(
        Some(app),
        "set-priority",
        json!({ "download": download, "metadata": metadata }),
    )?;
    Ok(())
}

pub fn list_installed(app: &AppHandle) -> Result<Value, String> {
    call(Some(app), "list", json!({}))
}

pub fn available(app: Option<&AppHandle>) -> bool {
    find_cli(app).is_some()
}
