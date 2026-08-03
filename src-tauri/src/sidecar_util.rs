//! SpotiFLAC sidecar helpers with timeouts so search/download never hang the UI.

use std::time::Duration;
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
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
                            println!(
                                "Spotify sidecar: plugin returned not-found — trying filesystem"
                            );
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
    // Prefer nativeLibraryDir on PATH (exec-safe on Android)
    let path_dirs: Vec<std::path::PathBuf> =
        [android_bin::native_lib_dir(), android_bin::bin_dir()]
            .into_iter()
            .flatten()
            .collect();
    if !path_dirs.is_empty() {
        let mut paths = path_dirs.clone();
        if let Some(existing) = std::env::var_os("PATH") {
            for p in std::env::split_paths(&existing) {
                paths.push(p);
            }
        }
        if let Ok(joined) = std::env::join_paths(&paths) {
            cmd.env("PATH", joined);
        }
        if let Some(native) = android_bin::native_lib_dir() {
            cmd.env("NEKOBEAT_NATIVE_LIB_DIR", &native);
            let ffmpeg = native.join("libffmpeg.so");
            let ffprobe = native.join("libffprobe.so");
            if ffmpeg.is_file() {
                cmd.env("NEKOBEAT_FFMPEG", ffmpeg);
            }
            if ffprobe.is_file() {
                cmd.env("NEKOBEAT_FFPROBE", ffprobe);
            }
        }
        if let Some(dir) = android_bin::bin_dir() {
            cmd.env("NEKOBEAT_BIN_DIR", &dir);
            if let Some(home) = dir.parent() {
                cmd.env("HOME", home);
            }
        }
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
