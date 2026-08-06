//! NekoBeat greenfield backend — brand/id only from prior app.
pub mod covers;
pub mod discord_rpc;
pub mod extensions;
pub mod hifi;
pub mod library;
pub mod lyrics;
#[cfg(target_os = "android")]
pub mod lyrics_notification;
pub mod playback;
pub mod settings;
pub mod sidecar;
pub mod stream;
pub mod ytdlp;
pub mod zarz_api;

use extensions::ExtState;
use hifi::HifiState;
use library::LibraryDb;
use parking_lot::Mutex;
use playback::shared_player;
use std::sync::Arc;
use stream::StreamState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            use tauri::Manager;
            let data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("nekobeat"));
            let _ = std::fs::create_dir_all(&data);

            let settings_val = settings::load(&data);
            let settings = Arc::new(Mutex::new(settings_val.clone()));
            let db = LibraryDb::open(&data).unwrap_or_else(|e| {
                eprintln!("library open failed: {e}");
                let fb = std::env::temp_dir().join("nekobeat-fallback");
                let _ = std::fs::create_dir_all(&fb);
                LibraryDb::open(&fb).expect("fallback library db")
            });
            let ext = Arc::new(ExtState {
                registry_url: Mutex::new(settings_val.extension_registry_url.clone()),
                download_priority: Mutex::new(settings_val.download_provider_priority.clone()),
                metadata_priority: Mutex::new(settings_val.metadata_provider_priority.clone()),
                ..Default::default()
            });

            app.manage(shared_player());
            app.manage(db);
            app.manage(StreamState::default());
            app.manage(Arc::new(HifiState::default()));
            app.manage(ext);
            app.manage(settings);
            app.manage(Arc::new(discord_rpc::DiscordState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            playback::playback_play,
            playback::playback_pause,
            playback::playback_resume,
            playback::playback_stop,
            playback::playback_seek,
            playback::playback_set_volume,
            playback::playback_status,
            playback::playback_set_eq,
            playback::playback_sleep_timer,
            library::library_scan,
            library::library_list,
            library::library_like,
            library::library_liked,
            stream::stream_search,
            stream::stream_resolve,
            stream::stream_invalidate,
            hifi::hifi_search,
            hifi::hifi_enqueue,
            hifi::hifi_jobs,
            hifi::hifi_download_dir,
            lyrics::lyrics_get,
            lyrics::lyrics_notif_show,
            lyrics::lyrics_notif_hide,
            covers::cover_resolve,
            extensions::extensions_list,
            extensions::extensions_refresh,
            extensions::extensions_install,
            extensions::extensions_set_registry,
            extensions::extensions_set_priority,
            extensions::extensions_get_settings,
            extensions::extensions_set_settings,
            extensions::extensions_start_login,
            extensions::extensions_complete_login,
            extensions::extensions_logout,
            extensions::extensions_pending_auth,
            settings::settings_get,
            settings::settings_set,
            discord_rpc::discord_update,
            discord_rpc::discord_clear,
            zarz_api::zarz_resolve,
            zarz_api::zarz_config,
            zarz_api::zarz_docs_url,
            zarz_api::zarz_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NekoBeat");
}
