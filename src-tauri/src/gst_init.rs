//! Cross-platform GStreamer initialization.
//! Same `audio.rs` playbin pipeline on Windows, Linux, macOS, and Android.

/// Call once before any GStreamer element is created.
pub fn ensure_initialized() {
    #[cfg(target_os = "windows")]
    init_windows();

    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "android"),
        not(target_os = "ios")
    ))]
    init_unix();

    #[cfg(target_os = "android")]
    init_android();
}

#[cfg(target_os = "windows")]
fn init_windows() {
    use std::env;
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn SetDefaultDllDirectories(DirectoryFlags: u32) -> i32;
        fn AddDllDirectory(lpPathName: *const u16) -> *const std::ffi::c_void;
    }

    const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x00001000;
    const LOAD_LIBRARY_SEARCH_USER_DIRS: u32 = 0x00000400;

    let exe_path = env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));

    let paths_to_check = vec![
        exe_dir.join("gstreamer"),
        exe_dir.join("resources").join("gstreamer"),
        exe_dir.to_path_buf(),
    ];

    let mut found_gst = false;
    for gst_base in paths_to_check {
        let gst_bin = gst_base.join("bin");
        let gst_plugins = gst_base.join("plugins");
        if gst_bin.exists() {
            let wide_path: Vec<u16> = gst_bin
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                SetDefaultDllDirectories(
                    LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS,
                );
                AddDllDirectory(wide_path.as_ptr());
            }
            if let Ok(current_path) = env::var("PATH") {
                env::set_var("PATH", format!("{};{}", gst_bin.to_string_lossy(), current_path));
            }
            env::set_var(
                "GST_PLUGIN_PATH",
                gst_plugins.to_string_lossy().replace('\\', "/"),
            );
            env::set_var("GST_REGISTRY_FORK", "no");
            let mut gst_registry = exe_dir.to_path_buf();
            gst_registry.push("gstreamer_registry.bin");
            env::set_var(
                "GST_REGISTRY",
                gst_registry.to_string_lossy().replace('\\', "/"),
            );
            found_gst = true;
            break;
        }
    }

    if !found_gst {
        if let Ok(gst_root) = env::var("GSTREAMER_1_0_ROOT_MSVC_X86_64") {
            let gst_bin = format!("{}bin", gst_root);
            if let Ok(current_path) = env::var("PATH") {
                if !current_path.contains(&gst_bin) {
                    env::set_var("PATH", format!("{};{}", gst_bin, current_path));
                }
            }
        }
    }

    let _ = gstreamer::init();
}

#[cfg(all(
    not(target_os = "windows"),
    not(target_os = "android"),
    not(target_os = "ios")
))]
fn init_unix() {
    use std::env;
    // mut needed on macOS (extend homebrew paths); unused_mut on Linux is fine
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut common: Vec<&str> = vec![
        "/usr/lib/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
    ];
    #[cfg(target_os = "macos")]
    {
        common.extend([
            "/opt/homebrew/lib/gstreamer-1.0",
            "/usr/local/lib/gstreamer-1.0",
            "/Library/Frameworks/GStreamer.framework/Versions/Current/lib/gstreamer-1.0",
        ]);
    }
    let existing: Vec<&str> = common
        .iter()
        .copied()
        .filter(|p| std::path::Path::new(p).exists())
        .collect();
    if !existing.is_empty() {
        let joined = existing.join(":");
        if env::var_os("GST_PLUGIN_SYSTEM_PATH").is_none() {
            env::set_var("GST_PLUGIN_SYSTEM_PATH", &joined);
        }
        if env::var_os("GST_PLUGIN_PATH").is_none() {
            env::set_var("GST_PLUGIN_PATH", &joined);
        }
    }
    if env::var_os("GST_DEBUG").is_none() && env::var_os("NEKOBEAT_GST_DEBUG").is_none() {
        env::set_var("GST_DEBUG", "1");
    }
    match gstreamer::init() {
        Ok(_) => {
            let playbin_ok = gstreamer::ElementFactory::find("playbin").is_some();
            let soup_ok = gstreamer::ElementFactory::find("souphttpsrc").is_some();
            eprintln!(
                "GStreamer OK (playbin={}, souphttpsrc={})",
                playbin_ok, soup_ok
            );
        }
        Err(e) => eprintln!("GStreamer init failed: {}", e),
    }
}

/// Android: link `libgstreamer_android.so` via NDK (see docs/ANDROID_GSTREAMER.md).
#[cfg(target_os = "android")]
fn init_android() {
    // MainActivity initializes the Android GStreamer runtime with a Context first. Avoid
    // scanning/loading the full plugin registry during app startup; the audio worker performs
    // concrete element creation lazily after the first explicit Play request.
    if let Err(error) = gstreamer::init() {
        eprintln!("GStreamer Android init failed: {error}");
    }
}
