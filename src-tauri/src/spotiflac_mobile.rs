//! Android: SpotiFLAC-Mobile Go AAR via JNI (`gobackend.DownloadByStrategy` + extensions).
//! Desktop: stubs — keep using `spotiflac-cli`.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "android")]
use serde_json::{json, Value};

#[cfg(target_os = "android")]
const ANDROID_CLASS: &str = "com/nishal21/nekobeat/SpotiFlacMobile";

#[cfg(target_os = "android")]
fn with_jni_env<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&mut jni::JNIEnv, jni::objects::JClass) -> Result<R, String>,
{
    use std::sync::OnceLock;

    static VM: OnceLock<jni::JavaVM> = OnceLock::new();
    let vm = VM.get_or_init(|| {
        let ctx = ndk_context::android_context();
        let vm_ptr = ctx.vm() as *mut jni::sys::JavaVM;
        unsafe { jni::JavaVM::from_raw(vm_ptr).expect("JavaVM") }
    });
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("JNI attach: {e}"))?;
    let class = env
        .find_class(ANDROID_CLASS)
        .map_err(|e| format!("find_class SpotiFlacMobile: {e}"))?;
    f(&mut *env, class)
}

#[cfg(target_os = "android")]
fn jni_string(env: &mut jni::JNIEnv, obj: jni::objects::JObject) -> Result<String, String> {
    let jstr = jni::objects::JString::from(obj);
    let java = env
        .get_string(&jstr)
        .map_err(|e| format!("get_string: {e}"))?;
    Ok(java.to_string())
}

/// True when gobackend.aar is on the classpath (Android only).
pub fn aar_available() -> bool {
    #[cfg(target_os = "android")]
    {
        with_jni_env(|env, class| {
            let result = env
                .call_static_method(class, "isAvailable", "()Z", &[])
                .map_err(|e| format!("isAvailable: {e}"))?;
            result.z().map_err(|e| format!("bool: {e}"))
        })
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn app_files_dir(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.to_string_lossy().to_string())
}

pub fn ensure_ready(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("SpotiFLAC-Mobile AAR is Android-only".into())
    }
    #[cfg(target_os = "android")]
    {
        if !aar_available() {
            return Err(
                "gobackend.aar not packaged — CI must run scripts/build-gobackend-aar.sh".into(),
            );
        }
        let files = app_files_dir(app)?;
        with_jni_env(|env, class| {
            let jpath = env
                .new_string(&files)
                .map_err(|e| format!("new_string: {e}"))?;
            let result = env
                .call_static_method(
                    class,
                    "ensureInitialized",
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[(&jpath).into()],
                )
                .map_err(|e| format!("ensureInitialized: {e}"))?;
            let obj = result.l().map_err(|e| e.to_string())?;
            let s = jni_string(env, obj)?;
            let v: Value = serde_json::from_str(&s).unwrap_or(json!({"ok": false, "error": s}));
            if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                Ok(())
            } else {
                Err(v
                    .get("error")
                    .and_then(|x| x.as_str())
                    .unwrap_or("init failed")
                    .to_string())
            }
        })?;
        let _ = bootstrap_extensions(app);
        Ok(())
    }
}

pub fn bootstrap_extensions(app: &AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android-only".into())
    }
    #[cfg(target_os = "android")]
    {
        let files = app_files_dir(app)?;
        with_jni_env(|env, class| {
            let jpath = env.new_string(&files).map_err(|e| e.to_string())?;
            let result = env
                .call_static_method(
                    class,
                    "bootstrapDefaultExtensions",
                    "(Ljava/lang/String;)Ljava/lang/String;",
                    &[(&jpath).into()],
                )
                .map_err(|e| e.to_string())?;
            let obj = result.l().map_err(|e| e.to_string())?;
            jni_string(env, obj)
        })
    }
}

/// Download via Go AAR. Returns absolute file path on success.
pub async fn download_track(
    app: &AppHandle,
    spotify_url: &str,
    title: &str,
    artist: &str,
    duration_ms: Option<u64>,
) -> Result<std::path::PathBuf, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, spotify_url, title, artist, duration_ms);
        Err("Android-only".into())
    }
    #[cfg(target_os = "android")]
    {
        ensure_ready(app)?;
        let out_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("nekobeat_spotify_hifi");
        let _ = std::fs::create_dir_all(&out_dir);

        let spotify_id = spotify_url
            .rsplit('/')
            .next()
            .unwrap_or("")
            .split('?')
            .next()
            .unwrap_or("")
            .to_string();
        let item_id = format!("nb-{spotify_id}");

        let req = json!({
            "contract_version": 1,
            "spotify_id": spotify_id,
            "track_name": title,
            "artist_name": artist,
            "output_dir": out_dir.to_string_lossy(),
            "filename_format": "{artist} - {title}",
            "quality": "HI_RES",
            "embed_metadata": true,
            "item_id": item_id,
            "duration_ms": duration_ms.unwrap_or(0),
            "source": "spotify",
            "service": "auto",
            "use_extensions": true,
            "use_fallback": true,
        });

        let req_s = req.to_string();
        let resp_s: String = tokio::task::spawn_blocking(move || {
            with_jni_env(|env, class| {
                let jreq = env.new_string(&req_s).map_err(|e| e.to_string())?;
                let result = env
                    .call_static_method(
                        class,
                        "downloadByStrategy",
                        "(Ljava/lang/String;)Ljava/lang/String;",
                        &[(&jreq).into()],
                    )
                    .map_err(|e| e.to_string())?;
                let obj = result.l().map_err(|e| e.to_string())?;
                jni_string(env, obj)
            })
        })
        .await
        .map_err(|e| format!("join: {e}"))??;

        let parsed: Value = serde_json::from_str(&resp_s)
            .map_err(|e| format!("parse AAR response: {e} — {resp_s}"))?;
        if parsed.get("success").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(path) = parsed.get("file_path").and_then(|v| v.as_str()) {
                let p = std::path::PathBuf::from(path);
                if p.is_file() {
                    return Ok(p);
                }
                return Err(format!("AAR success but file missing: {path}"));
            }
        }
        let err = parsed
            .get("error")
            .or_else(|| parsed.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("download failed");
        Err(err.to_string())
    }
}

#[tauri::command]
pub async fn spotiflac_mobile_download(
    app: AppHandle,
    spotify_url: String,
    title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<u64>,
) -> Result<String, String> {
    let path = download_track(
        &app,
        &spotify_url,
        title.as_deref().unwrap_or(""),
        artist.as_deref().unwrap_or(""),
        duration_ms,
    )
    .await?;
    Ok(crate::path_util::path_to_file_uri(&path))
}

#[tauri::command]
pub async fn spotiflac_mobile_progress() -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    {
        Ok("{}".into())
    }
    #[cfg(target_os = "android")]
    {
        with_jni_env(|env, class| {
            let result = env
                .call_static_method(class, "getProgress", "()Ljava/lang/String;", &[])
                .map_err(|e| e.to_string())?;
            let obj = result.l().map_err(|e| e.to_string())?;
            jni_string(env, obj)
        })
    }
}

#[tauri::command]
pub async fn spotiflac_mobile_cancel(item_id: String) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = item_id;
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        with_jni_env(|env, class| {
            let jid = env.new_string(&item_id).map_err(|e| e.to_string())?;
            env.call_static_method(
                class,
                "cancelDownload",
                "(Ljava/lang/String;)V",
                &[(&jid).into()],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

#[tauri::command]
pub async fn spotiflac_mobile_install_extension(
    app: AppHandle,
    extension_id: String,
) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, extension_id);
        Err("Android-only".into())
    }
    #[cfg(target_os = "android")]
    {
        let files = app_files_dir(&app)?;
        with_jni_env(|env, class| {
            let jfiles = env.new_string(&files).map_err(|e| e.to_string())?;
            let jid = env.new_string(&extension_id).map_err(|e| e.to_string())?;
            let result = env
                .call_static_method(
                    class,
                    "installExtensionById",
                    "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                    &[(&jfiles).into(), (&jid).into()],
                )
                .map_err(|e| e.to_string())?;
            let obj = result.l().map_err(|e| e.to_string())?;
            jni_string(env, obj)
        })
    }
}

#[tauri::command]
pub async fn spotiflac_mobile_bootstrap(app: AppHandle) -> Result<String, String> {
    bootstrap_extensions(&app)
}
