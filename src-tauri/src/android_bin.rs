//! Android: prefer executing jniLibs from nativeLibraryDir (filesDir is often noexec).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

static BIN_DIR: OnceLock<PathBuf> = OnceLock::new();
static NATIVE_DIR: OnceLock<PathBuf> = OnceLock::new();
#[cfg(target_os = "android")]
static ENSURED: AtomicBool = AtomicBool::new(false);

pub fn bin_dir() -> Option<PathBuf> {
    BIN_DIR.get().cloned().or_else(|| {
        std::env::var_os("NEKOBEAT_BIN_DIR").map(PathBuf::from)
    })
}

pub fn native_lib_dir() -> Option<PathBuf> {
    NATIVE_DIR.get().cloned().or_else(|| {
        std::env::var_os("NEKOBEAT_NATIVE_LIB_DIR").map(PathBuf::from)
    })
}

pub fn set_bin_dir(path: PathBuf) {
    let _ = BIN_DIR.set(path.clone());
    std::env::set_var("NEKOBEAT_BIN_DIR", &path);
    prepend_path(&path);
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn set_native_dir(path: PathBuf) {
    let _ = NATIVE_DIR.set(path.clone());
    std::env::set_var("NEKOBEAT_NATIVE_LIB_DIR", &path);
    let ffmpeg = path.join("libffmpeg.so");
    let ffprobe = path.join("libffprobe.so");
    if ffmpeg.is_file() {
        std::env::set_var("NEKOBEAT_FFMPEG", &ffmpeg);
    }
    if ffprobe.is_file() {
        std::env::set_var("NEKOBEAT_FFPROBE", &ffprobe);
    }
    prepend_path(&path);
}

fn prepend_path(dir: &Path) {
    let dir_s = dir.to_string_lossy();
    let mut paths = vec![dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&existing) {
            if p != dir {
                paths.push(p);
            }
        }
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
        println!("Android sidecars: PATH prepended with {}", dir_s);
    }
}

fn first_existing(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    for d in dirs {
        let p = d.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Discover nativeLibraryDir and wire PATH / NEKOBEAT_FFMPEG for SpotiFLAC HiFi.
#[cfg(target_os = "android")]
pub fn ensure_android_sidecars(app: &tauri::AppHandle) {
    use tauri::Manager;

    if ENSURED.swap(true, Ordering::SeqCst) {
        if let Some(d) = native_lib_dir().or_else(bin_dir) {
            prepend_path(&d);
        }
        return;
    }

    let data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Android sidecars: app_data_dir failed: {}", e);
            return;
        }
    };
    let dest_bin = data.join("bin");
    let _ = std::fs::create_dir_all(&dest_bin);

    let marker = dest_bin.join(".native_lib_dir");
    let mut native_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(s) = std::fs::read_to_string(&marker) {
        let t = s.trim();
        if !t.is_empty() {
            native_dirs.push(PathBuf::from(t));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            native_dirs.push(parent.to_path_buf());
        }
    }

    // Prefer a native dir that actually contains our helpers
    let native = native_dirs.into_iter().find(|d| {
        d.join("libspotiflac_cli.so").is_file()
            || d.join("libytdlp.so").is_file()
            || d.join("libffmpeg.so").is_file()
    });

    if let Some(ref native) = native {
        println!("Android sidecars: using nativeLibraryDir {:?}", native);
        set_native_dir(native.clone());
        // Keep filesDir/bin as secondary (may be noexec — do not rely on it for exec)
        set_bin_dir(dest_bin.clone());

        let spoti_dir = data.join(".spotiflac");
        let _ = std::fs::create_dir_all(&spoti_dir);
        for (so, name) in [("libffmpeg.so", "ffmpeg"), ("libffprobe.so", "ffprobe")] {
            let src = native.join(so);
            if src.is_file() {
                let dst = spoti_dir.join(name);
                let _ = std::fs::copy(&src, &dst);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
                }
            }
        }
        std::env::set_var("HOME", &data);
        return;
    }

    eprintln!("Android sidecars: nativeLibraryDir helpers not found — Spotify/yt-dlp may fail");
    set_bin_dir(dest_bin);
    std::env::set_var("HOME", &data);
}

#[cfg(not(target_os = "android"))]
pub fn ensure_android_sidecars(_app: &tauri::AppHandle) {}

pub fn find_ytdlp() -> Result<PathBuf, String> {
    let mut dirs = Vec::new();
    if let Some(d) = native_lib_dir() {
        dirs.push(d);
    }
    if let Some(d) = bin_dir() {
        dirs.push(d);
    }
    if let Some(p) = first_existing(&dirs, "libytdlp.so") {
        return Ok(p);
    }
    if let Some(p) = first_existing(&dirs, "yt-dlp") {
        return Ok(p);
    }
    crate::process_util::find_ytdlp_desktop()
}

pub fn find_spotiflac_cli() -> Result<PathBuf, String> {
    let mut dirs = Vec::new();
    if let Some(d) = native_lib_dir() {
        dirs.push(d);
    }
    if let Some(d) = bin_dir() {
        dirs.push(d);
    }
    // Android: exec from jniLibs name first (filesDir copies are often noexec)
    if let Some(p) = first_existing(&dirs, "libspotiflac_cli.so") {
        return Ok(p);
    }
    if let Some(p) = first_existing(&dirs, "spotiflac-cli") {
        return Ok(p);
    }
    find_spotiflac_cli_desktop()
}

fn find_spotiflac_cli_desktop() -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    {
        return Err("Spotify helper unavailable on iOS".into());
    }

    #[cfg(not(target_os = "ios"))]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
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
                    candidates.push(dir.join("libspotiflac_cli.so"));
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
        #[cfg(target_os = "android")]
        {
            candidates.push(manifest.join("binaries").join("spotiflac-cli-aarch64-linux-android"));
        }

        if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
            return Ok(found);
        }
        Err("Spotify helper unavailable (spotiflac-cli missing)".into())
    }
}
