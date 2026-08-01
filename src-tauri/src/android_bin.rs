//! Android: copy jniLibs executables into app filesDir/bin with correct basenames.
//! SpotiFLAC ValidateExecutable requires basename `ffmpeg` / `ffprobe` (not libffmpeg.so).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

static BIN_DIR: OnceLock<PathBuf> = OnceLock::new();
#[cfg(target_os = "android")]
static ENSURED: AtomicBool = AtomicBool::new(false);

/// Directory with `spotiflac-cli`, `ffmpeg`, `ffprobe`, `yt-dlp` (Android filesDir/bin).
pub fn bin_dir() -> Option<PathBuf> {
    BIN_DIR.get().cloned().or_else(|| {
        std::env::var_os("NEKOBEAT_BIN_DIR").map(PathBuf::from)
    })
}

pub fn set_bin_dir(path: PathBuf) {
    let _ = BIN_DIR.set(path.clone());
    std::env::set_var("NEKOBEAT_BIN_DIR", &path);
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

/// Copy packaged `lib*.so` helpers into `app_data_dir()/bin` with CLI names.
#[cfg(target_os = "android")]
pub fn ensure_android_sidecars(app: &tauri::AppHandle) {
    use tauri::Manager;

    if ENSURED.swap(true, Ordering::SeqCst) {
        if let Some(d) = bin_dir() {
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

    // MainActivity writes nativeLibraryDir here before Rust setup when possible.
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

    let copies = [
        ("libspotiflac_cli.so", "spotiflac-cli"),
        ("libffmpeg.so", "ffmpeg"),
        ("libffprobe.so", "ffprobe"),
        ("libytdlp.so", "yt-dlp"),
    ];

    for native in &native_dirs {
        println!("Android sidecars: probing native dir {:?}", native);
        for (so_name, bin_name) in &copies {
            let src = native.join(so_name);
            let dst = dest_bin.join(bin_name);
            if !src.is_file() {
                continue;
            }
            let need_copy = match (std::fs::metadata(&src), std::fs::metadata(&dst)) {
                (Ok(sm), Ok(dm)) => sm.len() != dm.len(),
                (Ok(_), Err(_)) => true,
                _ => true,
            };
            if need_copy {
                match std::fs::copy(&src, &dst) {
                    Ok(_) => {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
                        }
                        println!("Android sidecars: copied {:?} -> {:?}", src, dst);
                    }
                    Err(e) => eprintln!("Android sidecars: copy {:?} failed: {}", src, e),
                }
            }
        }
    }

    set_bin_dir(dest_bin.clone());

    // SpotiFLAC also looks under $HOME/.spotiflac for local ffmpeg
    let spoti_dir = data.join(".spotiflac");
    let _ = std::fs::create_dir_all(&spoti_dir);
    for name in ["ffmpeg", "ffprobe"] {
        let src = dest_bin.join(name);
        let dst = spoti_dir.join(name);
        if src.is_file() {
            let _ = std::fs::copy(&src, &dst);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    std::env::set_var("HOME", &data);
}

#[cfg(not(target_os = "android"))]
pub fn ensure_android_sidecars(_app: &tauri::AppHandle) {}

/// Prefer Android extracted yt-dlp, then desktop discovery.
pub fn find_ytdlp() -> Result<PathBuf, String> {
    if let Some(dir) = bin_dir() {
        let p = dir.join("yt-dlp");
        if p.is_file() {
            return Ok(p);
        }
        let so = dir.join("libytdlp.so");
        if so.is_file() {
            return Ok(so);
        }
    }
    if let Ok(native) = std::env::var("NEKOBEAT_NATIVE_LIB_DIR") {
        let p = PathBuf::from(native).join("libytdlp.so");
        if p.is_file() {
            return Ok(p);
        }
    }
    crate::process_util::find_ytdlp_desktop()
}

pub fn find_spotiflac_cli() -> Result<PathBuf, String> {
    if let Some(dir) = bin_dir() {
        let p = dir.join("spotiflac-cli");
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(native) = std::env::var("NEKOBEAT_NATIVE_LIB_DIR") {
        let p = PathBuf::from(native).join("libspotiflac_cli.so");
        if p.is_file() {
            return Ok(p);
        }
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
