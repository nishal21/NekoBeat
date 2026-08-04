//! Unified playback: prefer libmpv IPC when `mpv` is on PATH / bundled; else rodio.
//! No GStreamer. Android uses the same API; MediaSession is a separate bridge.

mod mpv;
mod rodio_backend;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover_url: Option<String>,
    pub isrc: Option<String>,
    pub spotify_id: Option<String>,
    pub source: Option<String>,
    pub path: Option<String>,
    pub stream_url: Option<String>,
    pub quality_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub playing: bool,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub uri: Option<String>,
}

pub trait AudioBackend: Send {
    fn play(&mut self, uri: &str) -> Result<(), String>;
    fn pause(&mut self) -> Result<(), String>;
    fn resume(&mut self) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
    fn seek(&mut self, position_ms: u64) -> Result<(), String>;
    fn set_volume(&mut self, volume: f32) -> Result<(), String>;
    fn status(&mut self) -> PlaybackStatus;
    fn set_eq(&mut self, _bands: &[f32]) -> Result<(), String> {
        Ok(())
    }
}

pub struct Player {
    backend: Box<dyn AudioBackend>,
    meta: Option<TrackMeta>,
    sleep_deadline: Option<std::time::Instant>,
}

impl Player {
    pub fn new() -> Self {
        let backend: Box<dyn AudioBackend> = if mpv::MpvBackend::available() {
            Box::new(mpv::MpvBackend::new())
        } else {
            Box::new(rodio_backend::RodioBackend::new())
        };
        Self {
            backend,
            meta: None,
            sleep_deadline: None,
        }
    }

    pub fn play(&mut self, uri: &str, meta: Option<TrackMeta>) -> Result<(), String> {
        self.meta = meta;
        self.backend.play(uri)
    }
}

pub type SharedPlayer = Arc<Mutex<Player>>;

pub fn shared_player() -> SharedPlayer {
    Arc::new(Mutex::new(Player::new()))
}

#[tauri::command]
pub fn playback_play(
    player: tauri::State<'_, SharedPlayer>,
    uri: String,
    meta: Option<TrackMeta>,
) -> Result<(), String> {
    player.lock().play(&uri, meta)
}

#[tauri::command]
pub fn playback_pause(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    player.lock().backend.pause()
}

#[tauri::command]
pub fn playback_resume(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    player.lock().backend.resume()
}

#[tauri::command]
pub fn playback_stop(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    player.lock().backend.stop()
}

#[tauri::command]
pub fn playback_seek(
    player: tauri::State<'_, SharedPlayer>,
    position_ms: u64,
) -> Result<(), String> {
    player.lock().backend.seek(position_ms)
}

#[tauri::command]
pub fn playback_set_volume(
    player: tauri::State<'_, SharedPlayer>,
    volume: f32,
) -> Result<(), String> {
    player.lock().backend.set_volume(volume.clamp(0.0, 1.0))
}

#[tauri::command]
pub fn playback_status(player: tauri::State<'_, SharedPlayer>) -> PlaybackStatus {
    let mut p = player.lock();
    if let Some(deadline) = p.sleep_deadline {
        if std::time::Instant::now() >= deadline {
            let _ = p.backend.pause();
            p.sleep_deadline = None;
        }
    }
    p.backend.status()
}

#[tauri::command]
pub fn playback_set_eq(
    player: tauri::State<'_, SharedPlayer>,
    bands: Vec<f32>,
) -> Result<(), String> {
    player.lock().backend.set_eq(&bands)
}

#[tauri::command]
pub fn playback_sleep_timer(
    player: tauri::State<'_, SharedPlayer>,
    minutes: Option<u64>,
) -> Result<(), String> {
    let mut p = player.lock();
    p.sleep_deadline = minutes.map(|m| {
        std::time::Instant::now() + std::time::Duration::from_secs(m.saturating_mul(60))
    });
    Ok(())
}
