use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use lofty::probe::Probe;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackData {
    pub filepath: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub source: Option<String>,
}

pub fn init_db() -> SqlResult<Connection> {
    // In production, resolving the user data dir via Tauri AppHandle is preferred.
    // For now, an in-memory or generic local file database for demo purposes is fine.
    let conn = Connection::open("nekobeat.db")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY,
            filepath TEXT UNIQUE,
            title TEXT,
            artist TEXT,
            album TEXT,
            duration_ms INTEGER
        )",
        [],
    )?;
    Ok(conn)
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<TrackData>, String> {
    let mut tracks = Vec::new();
    let conn = init_db().map_err(|e| e.to_string())?;

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        // only scan known audio formats roughly
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ext_str == "mp3" || ext_str == "flac" || ext_str == "m4a" || ext_str == "wav" {
                if let Ok(track) = extract_metadata(path) {
                    
                    // Insert or ignore into DB for fast caching
                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO tracks (filepath, title, artist, album, duration_ms)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            track.filepath,
                            track.title,
                            track.artist,
                            track.album,
                            track.duration_ms as i64
                        ],
                    );
                    
                    tracks.push(track);
                }
            }
        }
    }

    Ok(tracks)
}

fn extract_metadata(path: &Path) -> Result<TrackData, String> {
    let probe_result = match Probe::open(path) {
        Ok(probe) => match probe.read() {
            Ok(res) => res,
            Err(_) => return Err("Failed to read tagged file".into()),
        },
        Err(_) => return Err("Failed to open file".into()),
    };

    let tag = probe_result.primary_tag().or_else(|| probe_result.first_tag());
    
    let title = tag.and_then(|t| t.title().as_deref().map(|s| s.to_string())).unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
    let artist = tag.and_then(|t| t.artist().as_deref().map(|s| s.to_string())).unwrap_or_else(|| "Unknown Artist".into());
    let album = tag.and_then(|t| t.album().as_deref().map(|s| s.to_string())).unwrap_or_else(|| "Unknown Album".into());
    let duration_ms = probe_result.properties().duration().as_millis() as u64;

    Ok(TrackData {
        filepath: path.to_string_lossy().into_owned(),
        title,
        artist,
        album,
        duration_ms,
        source: Some("local".to_string()),
    })
}

#[tauri::command]
pub fn get_cached_tracks() -> Result<Vec<TrackData>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT filepath, title, artist, album, duration_ms FROM tracks")
        .map_err(|e| e.to_string())?;
    
    let track_iter = stmt.query_map([], |row| {
        Ok(TrackData {
            filepath: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album: row.get(3)?,
            duration_ms: row.get::<usize, i64>(4)? as u64,
            source: Some("local".to_string()),
        })
    }).map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    for track in track_iter {
        if let Ok(t) = track {
            tracks.push(t);
        }
    }

    Ok(tracks)
}
