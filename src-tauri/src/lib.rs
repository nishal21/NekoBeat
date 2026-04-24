use tauri::Manager;
pub mod audio;
pub mod library;
pub mod aggregator;
pub mod discord_rpc;
pub mod offline;
pub mod news;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent, Emitter,
};
use std::sync::{Arc, Mutex};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn log_frontend(msg: String) {
    println!("FRONTEND LOG: {}", msg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let exe_path = std::env::current_exe().unwrap_or_default();
            let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
            let log_path = exe_dir.join("nekobeat_startup.log");
            
            let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "Tauri setup hook started...")
            });

            // Initialize Discord RPC state
            app.manage(discord_rpc::DiscordState {
                client: Arc::new(Mutex::new(None)),
            });

            let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "Discord RPC state managed.")
            });

            // Initialize Audio Thread
            let audio_state = audio::init_audio_thread(app.handle().clone());
            app.manage(audio_state);

            let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                use std::io::Write;
                writeln!(f, "Audio thread initialized.")
            });

            // Create Tray Menu
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show NekoBeat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // Build Tray Icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("NekoBeat")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app: &tauri::AppHandle, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray: &tauri::tray::TrayIcon, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // Setup Global Shortcuts
            let app_handle = app.handle().clone();
            
            // Define shortcuts
            let play_pause = Shortcut::new(Some(Modifiers::empty()), Code::MediaPlayPause);
            let next_track = Shortcut::new(Some(Modifiers::empty()), Code::MediaTrackNext);
            let prev_track = Shortcut::new(Some(Modifiers::empty()), Code::MediaTrackPrevious);

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |_app, shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            if shortcut == &play_pause {
                                let _ = app_handle.emit("shortcut-play-pause", ());
                            } else if shortcut == &next_track {
                                let _ = app_handle.emit("shortcut-next", ());
                            } else if shortcut == &prev_track {
                                let _ = app_handle.emit("shortcut-prev", ());
                            }
                        }
                    })
                    .build(),
            )?;

            // Register shortcuts explicitly via plugin extension
            let _ = app.handle().global_shortcut().register(play_pause);
            let _ = app.handle().global_shortcut().register(next_track);
            let _ = app.handle().global_shortcut().register(prev_track);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Prevent actual closing, just hide window
                window.hide().unwrap();
                api.prevent_close();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            log_frontend,
            audio::play_audio,
            audio::pause_audio,
            audio::resume_audio,
            audio::seek_audio,
            audio::get_audio_position,
            audio::get_audio_duration,
            audio::stream_external_audio,
            audio::set_volume,
            audio::set_eq_band,
            aggregator::genius::get_genius_lyrics,
            aggregator::musixmatch::get_musixmatch_lyrics,
            aggregator::spotify_lyrics::get_spotify_lyrics,
            aggregator::search::search_external,
            library::scan_directory,
            library::get_cached_tracks,
            discord_rpc::set_discord_activity,
            discord_rpc::clear_discord_activity,
            offline::toggle_like,
            offline::get_liked_tracks,
            news::get_music_news,
            offline::update_track_lyrics,
            offline::read_text_file,
            offline::convert_srt_vtt_to_lrc,
            offline::check_liked_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
