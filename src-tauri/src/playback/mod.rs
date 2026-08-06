//! Unified playback: prefer libmpv IPC when `mpv` is on PATH / bundled; else rodio.
//! No GStreamer. Android uses the same API; MediaSession is a separate bridge.
//!
//! Critical: never probe devices or spawn mpv during `Player::new` — that runs on
//! Tauri setup and freezes the window (grey "Not Responding").
//!
//! Also critical: never hold the player mutex while ffmpeg/yt-dlp/network waits —
//! `playback_status` shares that lock; blocking it freezes the React UI.

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
    /// Rodio live-stream attach (no-op for mpv).
    fn play_live_http(
        &mut self,
        _uri: &str,
        _prepared: rodio_backend::PreparedLive,
    ) -> Result<(), String> {
        Err("live http attach not supported".into())
    }
    fn play_local_prepared(
        &mut self,
        _path: String,
        _source: rodio_backend::RodioSource,
        _duration_ms: u64,
    ) -> Result<(), String> {
        Err("local prepared attach not supported".into())
    }
    fn is_rodio(&self) -> bool {
        false
    }
}

pub struct Player {
    backend: Option<Box<dyn AudioBackend>>,
    meta: Option<TrackMeta>,
    sleep_deadline: Option<std::time::Instant>,
    volume: f32,
}

impl Player {
    /// Instant construction — no device / mpv probes.
    pub fn new() -> Self {
        Self {
            backend: None,
            meta: None,
            sleep_deadline: None,
            volume: 0.85,
        }
    }

    fn ensure_backend(&mut self) -> Result<&mut dyn AudioBackend, String> {
        if self.backend.is_none() {
            let backend: Box<dyn AudioBackend> = if mpv_available_quick() {
                Box::new(mpv::MpvBackend::new())
            } else {
                Box::new(rodio_backend::RodioBackend::new())
            };
            self.backend = Some(backend);
            let vol = self.volume;
            if let Some(b) = self.backend.as_mut() {
                let _ = b.set_volume(vol);
            }
        }
        match self.backend.as_mut() {
            Some(b) => Ok(b.as_mut()),
            None => Err("No audio backend".into()),
        }
    }

    pub fn play(&mut self, uri: &str, meta: Option<TrackMeta>) -> Result<(), String> {
        self.meta = meta;
        self.ensure_backend()?.play(uri)
    }

    fn stop_soft(&mut self) {
        if let Some(b) = self.backend.as_mut() {
            let _ = b.stop();
        }
    }
}

/// Bounded check so a hung `mpv` never freezes the UI thread forever.
fn mpv_available_quick() -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = mpv::MpvBackend::available();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(std::time::Duration::from_millis(400))
        .unwrap_or(false)
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
    let player = player.inner().clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Short lock: remember meta, stop previous, ensure backend exists.
        let rodio = {
            let mut p = player.lock();
            p.meta = meta;
            p.stop_soft();
            p.ensure_backend()?.is_rodio()
        };

        if uri.starts_with("http://") || uri.starts_with("https://") {
            if rodio {
                // ffmpeg probe can take seconds — do it WITHOUT the mutex.
                let prepared = rodio_backend::FfmpegPcmSource::spawn(&uri)?;
                let mut p = player.lock();
                return p.ensure_backend()?.play_live_http(&uri, prepared);
            }
            // mpv plays HTTP natively
            let mut p = player.lock();
            return p.ensure_backend()?.play(&uri);
        }

        if rodio {
            let (path, source, duration_ms) = rodio_backend::RodioBackend::prepare_local(&uri)?;
            let mut p = player.lock();
            return p
                .ensure_backend()?
                .play_local_prepared(path, source, duration_ms);
        }

        let mut p = player.lock();
        p.ensure_backend()?.play(&uri)
    }));
    match result {
        Ok(inner) => inner,
        Err(_) => Err(
            "Audio backend crashed while decoding. Try another track (MP3/M4A).".into(),
        ),
    }
}

#[tauri::command]
pub fn playback_pause(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    if let Some(b) = p.backend.as_mut() {
        b.pause()
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_resume(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    if let Some(b) = p.backend.as_mut() {
        b.resume()
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_stop(player: tauri::State<'_, SharedPlayer>) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    if let Some(b) = p.backend.as_mut() {
        b.stop()
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_seek(
    player: tauri::State<'_, SharedPlayer>,
    position_ms: u64,
) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    if let Some(b) = p.backend.as_mut() {
        b.seek(position_ms)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_set_volume(
    player: tauri::State<'_, SharedPlayer>,
    volume: f32,
) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    p.volume = volume.clamp(0.0, 1.0);
    let vol = p.volume;
    if let Some(b) = p.backend.as_mut() {
        b.set_volume(vol)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_status(player: tauri::State<'_, SharedPlayer>) -> PlaybackStatus {
    // Never block the UI on a long play()/ffmpeg wait.
    let Some(mut p) = player.try_lock() else {
        return PlaybackStatus {
            playing: true,
            position_ms: 0,
            duration_ms: 0,
            uri: None,
        };
    };
    if let Some(b) = p.backend.as_mut() {
        b.status()
    } else {
        PlaybackStatus {
            playing: false,
            position_ms: 0,
            duration_ms: 0,
            uri: None,
        }
    }
}

#[tauri::command]
pub fn playback_set_eq(
    player: tauri::State<'_, SharedPlayer>,
    bands: Vec<f32>,
) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    if let Some(b) = p.backend.as_mut() {
        b.set_eq(&bands)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn playback_sleep_timer(
    player: tauri::State<'_, SharedPlayer>,
    minutes: Option<u64>,
) -> Result<(), String> {
    let Some(mut p) = player.try_lock() else {
        return Ok(());
    };
    p.sleep_deadline = minutes.map(|m| {
        std::time::Instant::now() + std::time::Duration::from_secs(m.saturating_mul(60))
    });
    Ok(())
}
