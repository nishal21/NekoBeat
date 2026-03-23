fn main() {
    #[cfg(target_os = "windows")]
    {
        // 4. Force all bundled GStreamer DLLs to be Delay Loaded
        // This allows our main.rs to set the correct DLL search paths BEFORE they are loaded.
        let gst_bin = std::path::Path::new("gstreamer/bin");
        if gst_bin.exists() {
            if let Ok(entries) = std::fs::read_dir(gst_bin) {
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.ends_with(".dll") {
                            println!("cargo:rustc-link-arg=/DELAYLOAD:{}", name);
                        }
                    }
                }
            }
            println!("cargo:rustc-link-arg=delayimp.lib");
        }

        // MANUAL FALLBACK: If pkg-config fails, tell the linker where to find the libs
        // These correspond to the default GStreamer MSVC installation paths
        println!("cargo:rustc-link-search=native=C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\lib");
        println!("cargo:rustc-link-search=native=C:\\gstreamer\\1.0\\msvc_x86_64\\lib"); // Fallback
    }
    tauri_build::build()
}
