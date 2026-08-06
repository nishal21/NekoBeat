//! Locate bundled yt-dlp (Tauri resource / crate bin) — never rely on PATH alone.
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

#[cfg(windows)]
const BIN_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const BIN_NAME: &str = "yt-dlp";

/// Resolve path to yt-dlp binary shipped with the app.
pub fn find_ytdlp(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

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
            candidates.push(dir.join("..").join("..").join("bin").join(BIN_NAME));
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

    which_on_path(BIN_NAME)
}

/// ffmpeg next to yt-dlp / on PATH (needed for -x --audio-format mp3).
pub fn find_ffmpeg(app: Option<&tauri::AppHandle>) -> Option<PathBuf> {
    #[cfg(windows)]
    const FF: &str = "ffmpeg.exe";
    #[cfg(not(windows))]
    const FF: &str = "ffmpeg";

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(yt) = find_ytdlp(app) {
        if let Some(dir) = yt.parent() {
            candidates.push(dir.join(FF));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("bin").join(FF));
    if let Some(app) = app {
        if let Ok(res) = app.path().resource_dir() {
            candidates.push(res.join("bin").join(FF));
        }
        if let Ok(exe) = app.path().executable_dir() {
            candidates.push(exe.join("bin").join(FF));
            candidates.push(exe.join(FF));
        }
    }
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    which_on_path(FF)
}

/// Print direct media URL(s) without downloading (fast path for streaming).
pub fn get_direct_url(
    app: Option<&tauri::AppHandle>,
    watch: &str,
) -> Result<String, String> {
    let output = run_timeout(
        app,
        &[
            "-f",
            "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
            "--no-playlist",
            "--no-warnings",
            "-g",
            "--",
            watch,
        ],
        45,
    )?;
    if !output.status.success() {
        return Err(format!(
            "yt-dlp -g failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(200)
                .collect::<String>()
        ));
    }
    let url = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .ok_or_else(|| "yt-dlp returned no media URL".to_string())?
        .to_string();
    Ok(url)
}

/// Remux/transcode any audio file to MP3 for reliable rodio playback on Windows.
pub fn remux_to_mp3(
    app: Option<&tauri::AppHandle>,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let ff = find_ffmpeg(app).ok_or_else(|| {
        "ffmpeg not found — put ffmpeg.exe in src-tauri/bin next to yt-dlp.exe".to_string()
    })?;
    let mut cmd = Command::new(&ff);
    hide_console(&mut cmd);
    cmd.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input.to_str().ok_or("bad input path")?,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "4",
        output.to_str().ok_or("bad output path")?,
    ]);
    let out = cmd.output().map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg remux failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(200)
                .collect::<String>()
        ));
    }
    if !output.is_file() {
        return Err("ffmpeg produced no MP3".into());
    }
    Ok(())
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
        #[cfg(windows)]
        {
            if name == BIN_NAME {
                let p2 = dir.join("yt-dlp");
                if p2.is_file() {
                    return Some(p2);
                }
            }
        }
    }
    None
}

pub fn command(app: Option<&tauri::AppHandle>) -> Result<Command, String> {
    let bin = find_ytdlp(app).ok_or_else(|| {
        "yt-dlp not found (expected in app resources / src-tauri/bin)".to_string()
    })?;
    let mut cmd = Command::new(&bin);
    hide_console(&mut cmd);
    cmd.env("YTDLP_NO_UPDATE", "1");
    Ok(cmd)
}

pub fn run_timeout(
    app: Option<&tauri::AppHandle>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    use std::process::Stdio;

    let mut cmd = command(app)?;
    // Prefer bundled/nearby ffmpeg so -x --audio-format mp3 actually works.
    if let Some(ff) = find_ffmpeg(app) {
        if let Some(dir) = ff.parent() {
            cmd.arg("--ffmpeg-location");
            cmd.arg(dir);
        }
    }
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("yt-dlp spawn: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_end(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_end(&mut stderr);
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if start.elapsed().as_secs() >= timeout_secs {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("yt-dlp timed out after {timeout_secs}s"));
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(e) => return Err(format!("yt-dlp wait: {e}")),
        }
    }
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

#[allow(dead_code)]
pub fn exists(app: Option<&tauri::AppHandle>) -> bool {
    find_ytdlp(app).map(|p| Path::new(&p).is_file()).unwrap_or(false)
}
