fn main() {
    // build.rs runs on the host; use CARGO_CFG_TARGET_OS for cross-compile targets.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // Android playback is Media3 — do not link or require libgstreamer_android.so.
    if target_os == "windows" {
        windows_gstreamer_delay_load();
    }

    tauri_build::build()
}

fn windows_gstreamer_delay_load() {
    // Force bundled GStreamer DLLs to be delay-loaded so main.rs can set DLL search paths first.
    let gst_bin = std::path::Path::new("gstreamer/bin");
    if gst_bin.exists() {
        if let Ok(entries) = std::fs::read_dir(gst_bin) {
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
        println!("cargo:rustc-link-search=native=gstreamer/bin");

        if let Ok(out_dir) = std::env::var("OUT_DIR") {
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

    println!("cargo:rustc-link-search=native=C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\lib");
    println!("cargo:rustc-link-search=native=C:\\gstreamer\\1.0\\msvc_x86_64\\lib");
}
