//! Compatibility stubs for the removed Android Go/AAR backend.
//!
//! Spotify playback continues through NekoBeat's regular resolver/streaming path. Keeping these
//! small stubs avoids special cases in the aggregator while guaranteeing that no Go runtime,
//! service process, or JNI bridge is loaded on Android.

use tauri::AppHandle;

pub fn aar_available() -> bool {
    false
}

pub async fn download_track(
    _app: &AppHandle,
    _spotify_url: &str,
    _title: &str,
    _artist: &str,
    _duration_ms: Option<u64>,
) -> Result<std::path::PathBuf, String> {
    Err("Android Go HiFi backend was removed; using standard streaming fallback".into())
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
    Ok("{}".into())
}

#[tauri::command]
pub async fn spotiflac_mobile_cancel(_item_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn spotiflac_mobile_install_extension(
    _app: AppHandle,
    _extension_id: String,
) -> Result<String, String> {
    Err("Android Go HiFi backend was removed".into())
}

#[tauri::command]
pub async fn spotiflac_mobile_status(_app: AppHandle) -> Result<String, String> {
    Ok(
        r#"{"ok":true,"available":false,"packaged":false,"ready":false,"platform":"android","process":"none","removed":true}"#
            .into(),
    )
}

#[tauri::command]
pub async fn spotiflac_mobile_bootstrap(_app: AppHandle) -> Result<String, String> {
    Err("Android Go HiFi backend was removed".into())
}
