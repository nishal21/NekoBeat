// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    {
        use std::env;
        use std::path::PathBuf;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        use std::panic;

        extern "system" {
            fn SetDefaultDllDirectories(DirectoryFlags: u32) -> i32;
            fn AddDllDirectory(lpPathName: *const u16) -> *const std::ffi::c_void;
        }

        const LOAD_LIBRARY_SEARCH_DEFAULT_DIRS: u32 = 0x00001000;
        const LOAD_LIBRARY_SEARCH_USER_DIRS: u32 = 0x00000400;

        // 1. Try to find bundled GStreamer resources first (Portable Mode)
        let exe_path = env::current_exe().unwrap_or_default();
        let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        
        // Log startup to a file for debugging distribution issues
        let mut log_path = exe_dir.to_path_buf();
        log_path.push("nekobeat_startup.log");
        
        // Redirect stdout and stderr to the log file for release builds
        #[cfg(not(debug_assertions))]
        {
            if let Ok(log_file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                use std::os::windows::io::AsRawHandle;
                let handle = log_file.as_raw_handle();
                unsafe {
                    use windows::Win32::System::Console::{SetStdHandle, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
                    let _ = SetStdHandle(STD_OUTPUT_HANDLE, windows::Win32::Foundation::HANDLE(handle as _));
                    let _ = SetStdHandle(STD_ERROR_HANDLE, windows::Win32::Foundation::HANDLE(handle as _));
                }
            }
        }

        let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "\n--- NEKOBEAT STARTUP: {:?} ---", std::time::SystemTime::now())?;
            writeln!(f, "EXE Dir: {:?}", exe_dir)
        });

        let paths_to_check = vec![
            exe_dir.join("gstreamer"),
            exe_dir.join("resources").join("gstreamer"),
            exe_dir.to_path_buf(), // Fallback to root
        ];

        let mut found_gst = false;
        for gst_base in paths_to_check {
            let gst_bin = gst_base.join("bin");
            let gst_plugins = gst_base.join("plugins");
            
            let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "Checking for GStreamer bin at: {:?}", gst_bin)
            });

            if gst_bin.exists() {
                // Advanced DLL resolution for recursive dependencies
                let wide_path: Vec<u16> = gst_bin.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                unsafe {
                    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS);
                    AddDllDirectory(wide_path.as_ptr());
                }

                // Update PATH for child processes (some plugins might spawn them)
                if let Ok(current_path) = env::var("PATH") {
                    let new_path = format!("{};{}", gst_bin.to_string_lossy(), current_path);
                    env::set_var("PATH", new_path);
                }

                // Set GST_PLUGIN_PATH so GStreamer finds the bundled plugins
                env::set_var("GST_PLUGIN_PATH", gst_plugins.to_string_lossy().to_string().replace("\\", "/"));

                // Set GIO_EXTRA_MODULES for HTTPS/SSL support
                let mut gio_modules = exe_dir.to_path_buf();
                gio_modules.push("gstreamer");
                gio_modules.push("gio");
                gio_modules.push("modules");
                env::set_var("GIO_EXTRA_MODULES", gio_modules.to_string_lossy().to_string().replace("\\", "/"));
                
                // CRITICAL FOR PORTABILITY: Disable forking for plugin scanning
                env::set_var("GST_REGISTRY_FORK", "no");

                // Localized registry to avoid permission/corruption issues in AppData
                let mut gst_registry = exe_dir.to_path_buf();
                gst_registry.push("gstreamer_registry.bin");
                env::set_var("GST_REGISTRY", gst_registry.to_string_lossy().to_string().replace("\\", "/"));

                // Enable detailed GStreamer logging
                let mut gst_debug_log = exe_dir.to_path_buf();
                gst_debug_log.push("gstreamer_debug.log");
                env::set_var("GST_DEBUG_FILE", gst_debug_log.to_string_lossy().to_string().replace("\\", "/"));
                env::set_var("GST_DEBUG", "4");

                let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "SUCCESS: Injected GStreamer BIN path and set environment.")?;
                    f.sync_all()
                });

                // Re-enable registry but use local file for stability
                let mut gst_registry = exe_dir.to_path_buf();
                gst_registry.push("gstreamer_registry.bin");
                env::set_var("GST_REGISTRY", gst_registry.to_string_lossy().to_string().replace("\\", "/"));

                // Initialize GStreamer directly now that we've verified it works
                let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "Initializing GStreamer engine...")?;
                    f.sync_all()
                });

                if let Err(e) = gstreamer::init() {
                    let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                        use std::io::Write;
                        writeln!(f, "CRITICAL: gstreamer::init() failed: {}", e)?;
                        f.sync_all()
                    });
                } else {
                    let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                        use std::io::Write;
                        writeln!(f, "SUCCESS: GStreamer engine initialized.")?;
                        f.sync_all()
                    });
                }
                found_gst = true;
                break;
            }
        }

        if !found_gst {
            let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "FAILED: No bundled GStreamer found.")
            });
            // 2. Fallback to system environment (Developer Mode)
            if let Ok(gst_root) = env::var("GSTREAMER_1_0_ROOT_MSVC_X86_64") {
                let gst_bin = format!("{}bin", gst_root);
                if let Ok(current_path) = env::var("PATH") {
                    if !current_path.contains(&gst_bin) {
                        let new_path = format!("{};{}", gst_bin, current_path);
                        env::set_var("PATH", new_path);
                    }
                }
            }
        }
    }

    let exe_path = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let log_path = exe_dir.join("nekobeat_startup.log");
    
    let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
        use std::io::Write;
        writeln!(f, "Handing off to tauri::run()...")
    });

    nekobeat_lib::run();
}
