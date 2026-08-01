//! SpotiFLAC sidecar helpers with timeouts so search/download never hang the UI.

use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::android_bin;
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
/// Android: filesystem binary under filesDir/bin (jniLibs copy). Desktop: externalBin then FS.
pub async fn run_sidecar(
    app: &AppHandle,
    args: &[&str],
    timeout: Duration,
) -> Result<SidecarOutput, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return run_sidecar_fs(args, timeout).await;
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

async fn run_sidecar_fs(args: &[&str], timeout: Duration) -> Result<SidecarOutput, String> {
    let bin = android_bin::find_spotiflac_cli()?;
    println!("Spotify sidecar: running {:?}", bin);
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(args);
    if let Some(dir) = android_bin::bin_dir() {
        let mut paths = vec![dir.clone()];
        if let Some(existing) = std::env::var_os("PATH") {
            for p in std::env::split_paths(&existing) {
                paths.push(p);
            }
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
        cmd.env("NEKOBEAT_BIN_DIR", &dir);
        // Help SpotiFLAC find ffmpeg next to our bin dir / home .spotiflac
        cmd.env("HOME", dir.parent().unwrap_or(dir.as_path()));
    }
    let output = process_util::run_silent_timeout(cmd, timeout).await?;
    Ok(SidecarOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        success: output.status.success(),
    })
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
