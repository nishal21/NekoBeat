//! SpotiFLAC sidecar helpers with timeouts so search/download never hang the UI.

use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::process_util;

pub const SEARCH_TIMEOUT: Duration = Duration::from_secs(45);
pub const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);

pub struct SidecarOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
}

/// Run `spotiflac-cli` with args, killing the process on timeout.
/// Tries Tauri externalBin first, then filesystem paths next to the exe / binaries/.
pub async fn run_sidecar(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<SidecarOutput, String> {
    match app.shell().sidecar("spotiflac-cli") {
        Ok(cmd) => {
            let cmd = cmd.args(args);
            match tokio::time::timeout(timeout, cmd.output()).await {
                Ok(Ok(output)) => {
                    let out = SidecarOutput {
                        stdout: output.stdout,
                        stderr: output.stderr,
                        success: output.status.success(),
                    };
                    if !out.success
                        && String::from_utf8_lossy(&out.stderr)
                            .to_lowercase()
                            .contains("not found")
                    {
                        println!("Spotify sidecar: plugin returned not-found — trying filesystem");
                        return run_sidecar_fs(args, timeout).await;
                    }
                    Ok(out)
                }
                Ok(Err(e)) => {
                    eprintln!("Spotify sidecar plugin error: {} — trying filesystem", e);
                    run_sidecar_fs(args, timeout).await
                }
                Err(_) => Err(format!("sidecar timed out after {}s", timeout.as_secs())),
            }
        }
        Err(e) => {
            eprintln!("Spotify sidecar resolve failed: {} — trying filesystem", e);
            run_sidecar_fs(args, timeout).await
        }
    }
}

async fn run_sidecar_fs(args: &[&str], timeout: Duration) -> Result<SidecarOutput, String> {
    let bin = find_spotiflac_cli()?;
    println!("Spotify sidecar: running {:?}", bin);
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(args);
    let output = process_util::run_silent_timeout(cmd, timeout).await?;
    Ok(SidecarOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        success: output.status.success(),
    })
}

fn find_spotiflac_cli() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Used on desktop target cfgs below; unused on Android/iOS.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(unused_variables))]
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(windows)]
            {
                candidates.push(dir.join("spotiflac-cli.exe"));
                candidates.push(dir.join("spotiflac-cli-x86_64-pc-windows-msvc.exe"));
                candidates.push(dir.join("spotiflac-cli-x86_64-pc-windows-gnu.exe"));
            }
            #[cfg(not(windows))]
            {
                candidates.push(dir.join("spotiflac-cli"));
            }
        }
    }

    #[cfg(windows)]
    {
        candidates.push(manifest.join("binaries").join("spotiflac-cli-x86_64-pc-windows-msvc.exe"));
        candidates.push(manifest.join("binaries").join("spotiflac-cli-x86_64-pc-windows-gnu.exe"));
        candidates.push(manifest.join("bin").join("spotiflac-cli-x86_64-pc-windows-msvc.exe"));
        candidates.push(manifest.join("target").join("debug").join("spotiflac-cli.exe"));
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(manifest.join("binaries").join("spotiflac-cli-x86_64-unknown-linux-gnu"));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(manifest.join("binaries").join("spotiflac-cli-aarch64-apple-darwin"));
        candidates.push(manifest.join("binaries").join("spotiflac-cli-x86_64-apple-darwin"));
    }

    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Ok(found);
    }
    Err("spotiflac-cli not found (rebuild with scripts/build-spotiflac-cli.ps1)".into())
}

/// Extract the last JSON object line from sidecar stdout.
pub fn last_json_line(stdout: &[u8]) -> String {
    let text = String::from_utf8_lossy(stdout);
    text.lines()
        .filter(|l| l.trim().starts_with('{'))
        .last()
        .unwrap_or(text.trim())
        .to_string()
}
