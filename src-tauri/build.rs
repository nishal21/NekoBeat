fn main() {
    // build.rs runs on the host; use CARGO_CFG_TARGET_OS for cross-compile targets.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_os == "android" {
        android_gstreamer_hints();
    } else if target_os == "windows" {
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

// Android: pkg-config from GStreamer universal SDK + link mono-lib at runtime.
// See docs/ANDROID_GSTREAMER.md
fn android_gstreamer_hints() {
    let root = std::env::var("GSTREAMER_ROOT_ANDROID").unwrap_or_else(|_| {
        // Prefer repo-local vendor/ (CI), then monorepo sibling ../vendor (dev).
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
        let local = std::path::Path::new(&manifest).join("../vendor");
        let mono = std::path::Path::new(&manifest).join("../../vendor");
        if local.join("arm64").exists() {
            local.to_string_lossy().into_owned()
        } else if mono.join("arm64").exists() {
            mono.to_string_lossy().into_owned()
        } else {
            "../vendor".into()
        }
    });
    let abi = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| "aarch64".into());
    let gst_arch = match abi.as_str() {
        "aarch64" => "arm64",
        "arm" => "armv7",
        "x86_64" => "x86_64",
        "x86" => "x86",
        _ => "arm64",
    };
    let arch_root = format!("{}/{}", root.replace('\\', "/"), gst_arch);
    let lib_dir = format!("{}/lib", arch_root);
    let pkgconfig = format!("{}/lib/pkgconfig", arch_root);
    let ndk_abi = match abi.as_str() {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86_64" => "x86_64",
        "x86" => "x86",
        _ => "arm64-v8a",
    };
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let gst_android_build = format!(
        "{}/android-gst/jni/gst-android-build/{}",
        manifest_dir.replace('\\', "/"),
        ndk_abi
    );
    let gst_android_libs = format!(
        "{}/android-gst/libs/{}",
        manifest_dir.replace('\\', "/"),
        ndk_abi
    );
    // Link-only copy from CI prebuild (not packaged by AGP — avoids Duplicate resources)
    let gst_android_link = format!(
        "{}/android-gst/link/{}",
        manifest_dir.replace('\\', "/"),
        ndk_abi
    );
    let jni_libs = format!(
        "{}/gen/android/app/src/main/jniLibs/{}",
        manifest_dir.replace('\\', "/"),
        ndk_abi
    );

    println!("cargo:rerun-if-env-changed=GSTREAMER_ROOT_ANDROID");
    println!("cargo:rustc-link-search=native={}", lib_dir);
    println!("cargo:rustc-link-search=native={}", gst_android_link);
    println!("cargo:rustc-link-search=native={}", jni_libs);
    println!("cargo:rustc-link-search=native={}", gst_android_libs);
    println!("cargo:rustc-link-search=native={}", gst_android_build);
    println!("cargo:rustc-link-lib=dylib=gstreamer_android");

    std::env::set_var("PKG_CONFIG_ALLOW_CROSS", "1");
    std::env::set_var("PKG_CONFIG_SYSROOT_DIR", &arch_root);
    std::env::set_var("PKG_CONFIG_PATH", &pkgconfig);
}
