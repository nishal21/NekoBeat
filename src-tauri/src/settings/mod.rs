use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    /// Brand accent id: coral | volt | rose | teal | sky | orchid
    #[serde(default = "default_accent_preset")]
    pub accent_preset: String,
    pub discord_rich_presence: bool,
    pub notification_lyrics: bool,
    pub sleep_timer_minutes: Option<u64>,
    pub extension_registry_url: String,
    pub metadata_provider_priority: Vec<String>,
    pub download_provider_priority: Vec<String>,
    pub hifi_quality: String,
    pub preferred_download_service: String,
    pub ask_before_download: bool,
    pub auto_fallback: bool,
    pub wifi_only_downloads: bool,
    pub concurrent_downloads: u32,
    pub songlink_region: String,
    pub embed_metadata: bool,
    pub embed_lyrics: bool,
    pub embed_max_quality_cover: bool,
    pub embed_replaygain: bool,
    pub lyrics_mode: String,
    pub artist_tag_mode: String,
    pub filename_format: String,
    pub folder_organization: String,
    pub allow_quality_variants: bool,
    pub skip_duplicates: bool,
    pub tidal_high_format: String,
    /// SpotiFLAC cloud API base (default https://api.zarz.moe)
    pub zarz_api_base: String,
    pub scrobble_enabled: bool,
    pub gapless: bool,
    pub crossfade_seconds: f32,
    pub eq_bands: Vec<f32>,
    /// Absolute folder for HiFi downloads (empty = app data /hifi)
    #[serde(default)]
    pub download_dir: String,
}

fn default_accent_preset() -> String {
    "coral".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent_preset: default_accent_preset(),
            discord_rich_presence: false,
            notification_lyrics: true,
            sleep_timer_minutes: None,
            extension_registry_url: "https://github.com/zarzet/SpotiFLAC-Extension".into(),
            metadata_provider_priority: vec!["spotify-web".into()],
            download_provider_priority: vec![
                "tidal-web".into(),
                "amazon".into(),
                "qobuz-web".into(),
            ],
            hifi_quality: "LOSSLESS".into(),
            preferred_download_service: "tidal-web".into(),
            ask_before_download: true,
            auto_fallback: true,
            wifi_only_downloads: false,
            concurrent_downloads: 2,
            songlink_region: "US".into(),
            embed_metadata: true,
            embed_lyrics: true,
            embed_max_quality_cover: true,
            embed_replaygain: false,
            lyrics_mode: "both".into(),
            artist_tag_mode: "default".into(),
            filename_format: "{artist} - {title}".into(),
            folder_organization: "artist_album".into(),
            allow_quality_variants: true,
            skip_duplicates: true,
            tidal_high_format: "mp3_320".into(),
            zarz_api_base: "https://api.zarz.moe".into(),
            scrobble_enabled: false,
            gapless: true,
            crossfade_seconds: 0.0,
            eq_bands: vec![0.0; 10],
            download_dir: String::new(),
        }
    }
}

pub fn settings_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join("settings.json")
}

pub fn load(app_dir: &PathBuf) -> AppSettings {
    let path = settings_path(app_dir);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app_dir: &PathBuf, settings: &AppSettings) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    let path = settings_path(app_dir);
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_get(state: tauri::State<'_, Arc<Mutex<AppSettings>>>) -> AppSettings {
    state.lock().clone()
}

#[tauri::command]
pub fn settings_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    settings: AppSettings,
) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    save(&dir, &settings)?;
    *state.lock() = settings;
    Ok(())
}
