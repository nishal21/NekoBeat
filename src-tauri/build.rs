fn main() {
    #[cfg(target_os = "windows")]
    {
        // 4. Force all bundled GStreamer DLLs to be Delay Loaded
        // This allows our main.rs to set the correct DLL search paths BEFORE they are loaded.
        let gst_bin = std::path::Path::new("gstreamer/bin");
        if gst_bin.exists() {
            if let Ok(entries) = std::fs::read_dir(gst_bin) {
                // gobject-2.0-0.dll exports data symbols (__imp_g_param_spec_types)
                // that MSVC's delay-load mechanism cannot handle
                let skip_delay = ["gobject-2.0-0.dll"];
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.ends_with(".dll") && !skip_delay.contains(&name) {
                            println!("cargo:rustc-link-arg=/DELAYLOAD:{}", name);
                        }
                    }
                }
            }
            println!("cargo:rustc-link-arg=delayimp.lib");
            // Ensure GStreamer bin is on PATH so gobject DLL (not delay-loaded) is found at startup
            println!("cargo:rustc-link-search=native=gstreamer/bin");

            // Copy non-delay-loadable DLLs next to the output exe so the OS loader finds them
            // gobject-2.0-0.dll can't be delay-loaded (data symbol exports) and needs its deps
            if let Ok(out_dir) = std::env::var("OUT_DIR") {
                // OUT_DIR is like target/release/build/nekobeat-xxx/out
                // We need target/release/ (3 levels up)
                let out_path = std::path::PathBuf::from(&out_dir);
                if let Some(target_dir) = out_path.ancestors().nth(3) {
                    let critical_dlls = [
                        "gobject-2.0-0.dll",
                        "glib-2.0-0.dll",
                        "ffi-7.dll",
                        "intl-8.dll",
                        "pcre2-8-0.dll",
                    ];
                    for dll in &critical_dlls {
                        let src = gst_bin.join(dll);
                        let dst = target_dir.join(dll);
                        if src.exists() {
                            let _ = std::fs::copy(&src, &dst);
                        }
                    }
                }
            }
        }

        // MANUAL FALLBACK: If pkg-config fails, tell the linker where to find the libs
        // These correspond to the default GStreamer MSVC installation paths
        println!("cargo:rustc-link-search=native=C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\lib");
        println!("cargo:rustc-link-search=native=C:\\gstreamer\\1.0\\msvc_x86_64\\lib"); // Fallback
    }
    tauri_build::build()
}
