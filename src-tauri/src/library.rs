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
    pub local_lyrics: Option<String>,
}

pub fn init_db() -> SqlResult<Connection> {
    let conn = Connection::open("nekobeat.db")?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY,
            filepath TEXT UNIQUE,
            title TEXT,
            artist TEXT,
            album TEXT,
            duration_ms INTEGER,
            local_lyrics TEXT
        )",
        [],
    )?;

    // Migration: Add local_lyrics column if it doesn't exist (for existing databases)
    let _ = conn.execute("ALTER TABLE tracks ADD COLUMN local_lyrics TEXT", []);

    Ok(conn)
}

#[tauri::command]
pub async fn scan_directory(path: String) -> Result<Vec<TrackData>, String> {
    let mut tracks = Vec::new();
    let conn = init_db().map_err(|e| e.to_string())?;

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ext_str == "mp3" || ext_str == "flac" || ext_str == "m4a" || ext_str == "wav" {
                if let Ok(mut track) = extract_metadata(path) {
                    
                    // Check if we already have this track and its lyrics
                    let mut stmt = conn.prepare("SELECT local_lyrics FROM tracks WHERE filepath = ?1").map_err(|e| e.to_string())?;
                    let existing_lyrics: Option<String> = stmt.query_row(params![track.filepath], |row| row.get(0)).ok();
                    track.local_lyrics = existing_lyrics;

                    // Insert or update DB entry with fresh metadata
                    let _ = conn.execute(
                        "INSERT INTO tracks (filepath, title, artist, album, duration_ms, local_lyrics)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(filepath) DO UPDATE SET title=?2, artist=?3, album=?4, duration_ms=?5",
                        params![
                            track.filepath,
                            track.title,
                            track.artist,
                            track.album,
                            track.duration_ms as i64,
                            track.local_lyrics
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
            Err(e) => {
                eprintln!("Library: Failed to read tags for {:?}: {}", path, e);
                return Err(format!("Failed to read tagged file: {}", e));
            },
        },
        Err(e) => {
            eprintln!("Library: Failed to open {:?}: {}", path, e);
            return Err(format!("Failed to open file: {}", e));
        },
    };

    let tag = probe_result.primary_tag().or_else(|| probe_result.first_tag());
    let has_tag = tag.is_some();
    
    let title = tag.and_then(|t| t.title().as_deref().map(|s| s.to_string())).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
    let artist = tag.and_then(|t| t.artist().as_deref().map(|s| s.to_string())).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Unknown Artist".into());
    let album = tag.and_then(|t| t.album().as_deref().map(|s| s.to_string())).filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Unknown Album".into());
    let duration_ms = probe_result.properties().duration().as_millis() as u64;

    println!("Library: {:?} => has_tag={}, title='{}', artist='{}', duration={}ms", 
        path.file_name().unwrap_or_default(), has_tag, title, artist, duration_ms);

    Ok(TrackData {
        filepath: path.to_string_lossy().into_owned(),
        title,
        artist,
        album,
        duration_ms,
        source: Some("local".to_string()),
        local_lyrics: None,
    })
}

#[tauri::command]
pub fn get_cached_tracks() -> Result<Vec<TrackData>, String> {
    let conn = init_db().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT filepath, title, artist, album, duration_ms, local_lyrics FROM tracks")
        .map_err(|e| e.to_string())?;
    
    let track_iter = stmt.query_map([], |row| {
        let filepath: String = row.get(0)?;
        let raw_title: String = row.get(1)?;
        let title = if raw_title.trim().is_empty() {
            // Fallback: use filename stem
            std::path::Path::new(&filepath)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        } else {
            raw_title
        };
        Ok(TrackData {
            filepath,
            title,
            artist: row.get(2)?,
            album: row.get(3)?,
            duration_ms: row.get::<usize, i64>(4)? as u64,
            source: Some("local".to_string()),
            local_lyrics: row.get(5)?,
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
