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
pub mod stream;
pub mod zarz_api;

use extensions::ExtState;
use hifi::HifiState;
use library::LibraryDb;
use parking_lot::Mutex;
use playback::shared_player;
use std::sync::Arc;
use stream::StreamState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    #[cfg(not(mobile))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(not(mobile))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .setup(|app| {
            let data = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&data).ok();
            let settings = Arc::new(Mutex::new(settings::load(&data)));
            let db = LibraryDb::open(&data).expect("library db");
            let ext = Arc::new(ExtState {
                registry_url: Mutex::new(settings.lock().extension_registry_url.clone()),
                download_priority: Mutex::new(
                    settings.lock().download_provider_priority.clone(),
                ),
                metadata_priority: Mutex::new(
                    settings.lock().metadata_provider_priority.clone(),
                ),
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
            hifi::hifi_search,
            hifi::hifi_enqueue,
            hifi::hifi_jobs,
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
