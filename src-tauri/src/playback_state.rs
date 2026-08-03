//! Durable playback queue state stored under the platform app-data directory.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const STATE_VERSION: u32 = 1;
const STATE_FILE: &str = "playback-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    #[serde(default = "state_version")]
    pub version: u32,
    #[serde(default)]
    pub queue: Vec<Value>,
    #[serde(default = "default_index")]
    pub current_index: i64,
    #[serde(default)]
    pub loop_enabled: bool,
    #[serde(default)]
    pub shuffle_enabled: bool,
    #[serde(default)]
    pub current_track: Option<Value>,
    #[serde(default)]
    pub position_ms: u64,
}

fn state_version() -> u32 {
    STATE_VERSION
}

fn default_index() -> i64 {
    -1
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            queue: Vec::new(),
            current_index: -1,
            loop_enabled: false,
            shuffle_enabled: false,
            current_track: None,
            position_ms: 0,
        }
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(STATE_FILE))
}

fn string_field<'a>(track: &'a Value, key: &str) -> Option<&'a str> {
    track.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
}

fn looks_like_local_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
        || value.starts_with("content:")
        || value.starts_with("file:")
        || (value.len() > 2 && value.as_bytes()[1] == b':' && matches!(value.as_bytes()[2], b'\\' | b'/'))
}

fn local_path_exists(value: &str) -> bool {
    if value.starts_with("content:") {
        // Android content URIs cannot be checked with std::fs and may remain valid.
        return true;
    }
    let path = value.strip_prefix("file://").unwrap_or(value);
    Path::new(path).is_file()
}

fn sanitize_track(mut track: Value) -> Option<Value> {
    let source = string_field(&track, "source").unwrap_or_default().to_owned();
    let id = string_field(&track, "id").unwrap_or_default().to_owned();
    let stream_url = string_field(&track, "stream_url")
        .or_else(|| string_field(&track, "streamUrl"))
        .unwrap_or_default()
        .to_owned();
    let local_audio = string_field(&track, "local_audio_path")
        .or_else(|| string_field(&track, "localAudioPath"))
        .map(str::to_owned);
    let local_artwork = string_field(&track, "local_artwork_path")
        .or_else(|| string_field(&track, "localArtworkPath"))
        .map(str::to_owned);
    let artwork = string_field(&track, "artwork_url")
        .or_else(|| string_field(&track, "artworkUrl"))
        .map(str::to_owned);
    let pure_local = source == "local"
        || (looks_like_local_path(&id) && (stream_url.is_empty() || looks_like_local_path(&stream_url)));
    let playable_path = if !stream_url.is_empty() { &stream_url } else { &id };
    if pure_local && (!looks_like_local_path(playable_path) || !local_path_exists(playable_path)) {
        return None;
    }

    if let Some(path) = local_audio {
        if !local_path_exists(&path) {
            if let Some(object) = track.as_object_mut() {
                object.remove("local_audio_path");
                object.remove("localAudioPath");
            }
        }
    }
    if let Some(path) = local_artwork {
        if !local_path_exists(&path) {
            if let Some(object) = track.as_object_mut() {
                object.remove("local_artwork_path");
                object.remove("localArtworkPath");
            }
        }
    }
    if let Some(path) = artwork {
        if looks_like_local_path(&path) && !local_path_exists(&path) {
            if let Some(object) = track.as_object_mut() {
                object.remove("artwork_url");
                object.remove("artworkUrl");
            }
        }
    }
    if !pure_local && looks_like_local_path(&stream_url) && !local_path_exists(&stream_url) {
        if let Some(object) = track.as_object_mut() {
            object.remove("stream_url");
            object.remove("streamUrl");
        }
    }
    Some(track)
}

fn sanitize(mut state: PlaybackState) -> PlaybackState {
    if state.version != STATE_VERSION {
        return PlaybackState::default();
    }

    let selected_id = state
        .queue
        .get(state.current_index.max(0) as usize)
        .and_then(|track| string_field(track, "id"))
        .map(str::to_owned);
    state.queue = state.queue.into_iter().filter_map(sanitize_track).collect();
    state.current_track = state.current_track.and_then(sanitize_track);
    state.current_index = selected_id
        .and_then(|id| {
            state
                .queue
                .iter()
                .position(|track| string_field(track, "id") == Some(id.as_str()))
        })
        .map(|index| index as i64)
        .unwrap_or_else(|| if state.queue.is_empty() { -1 } else { 0 });
    if state.current_track.is_none() && state.current_index >= 0 {
        state.current_track = state.queue.get(state.current_index as usize).cloned();
    }
    state
}

fn load_from(path: &Path) -> PlaybackState {
    let Ok(bytes) = fs::read(path) else {
        return PlaybackState::default();
    };
    match serde_json::from_slice::<PlaybackState>(&bytes) {
        Ok(state) => sanitize(state),
        Err(error) => {
            eprintln!("Playback state: ignoring corrupt state: {error}");
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let corrupt = path.with_extension(format!("corrupt-{stamp}.json"));
            let _ = fs::rename(path, corrupt);
            PlaybackState::default()
        }
    }
}

fn atomic_write(path: &Path, state: &PlaybackState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let mut file = File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;

    let had_previous = path.exists();
    if had_previous {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if had_previous {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

#[tauri::command]
pub fn load_playback_state(app: AppHandle) -> Result<PlaybackState, String> {
    Ok(load_from(&state_path(&app)?))
}

#[tauri::command]
pub fn save_playback_state(app: AppHandle, state: PlaybackState) -> Result<(), String> {
    let mut state = sanitize(state);
    state.version = STATE_VERSION;
    atomic_write(&state_path(&app)?, &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, source: &str) -> Value {
        serde_json::json!({ "id": id, "source": source, "title": id })
    }

    #[test]
    fn corrupt_state_falls_back_and_is_quarantined() {
        let dir = std::env::temp_dir().join(format!(
            "nekobeat-playback-state-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(STATE_FILE);
        fs::write(&path, b"{broken").unwrap();
        let state = load_from(&path);
        assert!(state.queue.is_empty());
        assert!(!path.exists());
        assert!(fs::read_dir(&dir)
            .unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().contains("corrupt-")));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_local_tracks_are_removed_but_external_ids_remain() {
        let state = PlaybackState {
            queue: vec![
                track("Z:\\definitely-missing\\song.mp3", "local"),
                track("sp-external-id", "spotify"),
            ],
            current_index: 1,
            ..PlaybackState::default()
        };
        let clean = sanitize(state);
        assert_eq!(clean.queue.len(), 1);
        assert_eq!(string_field(&clean.queue[0], "id"), Some("sp-external-id"));
        assert_eq!(clean.current_index, 0);
    }

    #[test]
    fn atomic_write_round_trips_versioned_state() {
        let dir = std::env::temp_dir().join(format!(
            "nekobeat-playback-write-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(STATE_FILE);
        let state = PlaybackState {
            queue: vec![track("yt-123", "youtube")],
            current_index: 0,
            ..PlaybackState::default()
        };
        atomic_write(&path, &state).unwrap();
        let restored = load_from(&path);
        assert_eq!(restored.queue.len(), 1);
        assert_eq!(restored.version, STATE_VERSION);
        let _ = fs::remove_dir_all(dir);
    }
}
