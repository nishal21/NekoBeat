//! Silent child-process helpers — no console windows, kill on timeout.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Configure a Command so it never flashes a terminal (Windows) and has piped stdio.
pub fn configure_silent(cmd: &mut Command) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Spawn + wait with timeout; kills the child on timeout (kill_on_drop).
pub async fn run_silent_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    configure_silent(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("spawn failed: {}", e))?;

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("process error: {}", e)),
        Err(_) => Err("process timed out".into()),
    }
}

/// Cross-platform yt-dlp discovery (bundled + PATH). Prefer `android_bin::find_ytdlp` on mobile.
pub fn find_ytdlp() -> Result<PathBuf, String> {
    crate::android_bin::find_ytdlp()
}

/// Desktop / PATH / bundled yt-dlp (no Android filesDir).
pub fn find_ytdlp_desktop() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            #[cfg(windows)]
            {
                candidates.push(exe_dir.join("yt-dlp.exe"));
                candidates.push(exe_dir.join("bin").join("yt-dlp.exe"));
                candidates.push(exe_dir.join("resources").join("bin").join("yt-dlp.exe"));
            }
            candidates.push(exe_dir.join("yt-dlp"));
            candidates.push(exe_dir.join("bin").join("yt-dlp"));
            candidates.push(exe_dir.join("resources").join("bin").join("yt-dlp"));
            candidates.push(exe_dir.join("libytdlp.so"));
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    #[cfg(windows)]
    {
        candidates.push(manifest.join("bin").join("yt-dlp.exe"));
        candidates.push(PathBuf::from("bin/yt-dlp.exe"));
        candidates.push(PathBuf::from("src-tauri/bin/yt-dlp.exe"));
    }
    candidates.push(manifest.join("bin").join("yt-dlp"));
    candidates.push(PathBuf::from("bin/yt-dlp"));
    candidates.push(PathBuf::from("src-tauri/bin/yt-dlp"));

    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return Ok(found);
    }

    #[cfg(windows)]
    let names = ["yt-dlp.exe", "yt-dlp"];
    #[cfg(not(windows))]
    let names = ["yt-dlp"];

    for name in names {
        if let Ok(path) = which_bin(name) {
            return Ok(path);
        }
    }

    Err("yt-dlp binary not found".into())
}

fn which_bin(name: &str) -> Result<PathBuf, ()> {
    let path_var = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}
