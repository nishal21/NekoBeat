use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::Accessor;
use lofty::probe::Probe;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
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

/// Library DB lives in app data — NEVER under src-tauri/, or tauri:dev rebuilds
/// (and "closes" the app) whenever tracks are scanned/cleared.
pub fn library_db_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("nekobeat_library.db")
}

fn migrate_legacy_cwd_db(dest: &Path) {
    if dest.exists() {
        return;
    }
    // Old builds wrote nekobeat.db into the process cwd (often src-tauri during dev)
    for candidate in [
        PathBuf::from("nekobeat.db"),
        PathBuf::from("src-tauri/nekobeat.db"),
    ] {
        if candidate.is_file() {
            if fs::copy(&candidate, dest).is_ok() {
                println!(
                    "Library: migrated {:?} -> {:?}",
                    candidate, dest
                );
                let _ = fs::remove_file(&candidate);
            }
            break;
        }
    }
}

pub fn init_db(app: &tauri::AppHandle) -> SqlResult<Connection> {
    let path = library_db_path(app);
    migrate_legacy_cwd_db(&path);
    let conn = Connection::open(&path)?;
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
pub async fn scan_directory(app: tauri::AppHandle, path: String) -> Result<Vec<TrackData>, String> {
    let mut tracks = Vec::new();
    let conn = init_db(&app).map_err(|e| e.to_string())?;

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            if ext_str == "mp3" || ext_str == "flac" || ext_str == "m4a" || ext_str == "wav" {
                if let Ok(mut track) = extract_metadata(path) {
                    // Check if we already have this track and its lyrics
                    let mut stmt = conn
                        .prepare("SELECT local_lyrics FROM tracks WHERE filepath = ?1")
                        .map_err(|e| e.to_string())?;
                    let existing_lyrics: Option<String> = stmt
                        .query_row(params![track.filepath], |row| row.get(0))
                        .ok();
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
            }
        },
        Err(e) => {
            eprintln!("Library: Failed to open {:?}: {}", path, e);
            return Err(format!("Failed to open file: {}", e));
        }
    };

    let tag = probe_result
        .primary_tag()
        .or_else(|| probe_result.first_tag());
    let has_tag = tag.is_some();

    let title = tag
        .and_then(|t| t.title().as_deref().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let artist = tag
        .and_then(|t| t.artist().as_deref().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Unknown Artist".into());
    let album = tag
        .and_then(|t| t.album().as_deref().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Unknown Album".into());
    let duration_ms = probe_result.properties().duration().as_millis() as u64;

    println!(
        "Library: {:?} => has_tag={}, title='{}', artist='{}', duration={}ms",
        path.file_name().unwrap_or_default(),
        has_tag,
        title,
        artist,
        duration_ms
    );

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
pub fn get_cached_tracks(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT filepath, title, artist, album, duration_ms, local_lyrics FROM tracks")
        .map_err(|e| e.to_string())?;

    let track_iter = stmt
        .query_map([], |row| {
            let filepath: String = row.get(0)?;
            let raw_title: String = row.get(1)?;
            let title = if raw_title.trim().is_empty() {
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
        })
        .map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    for track in track_iter {
        if let Ok(t) = track {
            tracks.push(t);
        }
    }

    Ok(tracks)
}

#[tauri::command]
pub fn clear_library(app: tauri::AppHandle) -> Result<usize, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM tracks", [])
        .map_err(|e| e.to_string())?;
    println!("Library: cleared {} local track(s) from index", deleted);
    Ok(deleted)
}

fn is_audio_ext(path: &Path) -> bool {
    path.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            matches!(
                e.as_str(),
                "mp3" | "flac" | "m4a" | "wav" | "ogg" | "opus" | "aac" | "wma" | "aiff"
            )
        })
        .unwrap_or(false)
}

fn upsert_track(conn: &Connection, track: &TrackData) {
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
}

/// Import individual audio files (mobile file picker — no folder walk).
#[tauri::command]
pub async fn import_audio_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        if !path.is_file() {
            eprintln!("Library: skip missing file {:?}", path);
            continue;
        }
        if !is_audio_ext(&path) {
            continue;
        }
        match extract_metadata(&path) {
            Ok(mut track) => {
                let mut stmt = conn
                    .prepare("SELECT local_lyrics FROM tracks WHERE filepath = ?1")
                    .map_err(|e| e.to_string())?;
                track.local_lyrics = stmt
                    .query_row(params![track.filepath], |row| row.get(0))
                    .ok();
                upsert_track(&conn, &track);
                tracks.push(track);
            }
            Err(e) => eprintln!("Library: import failed {:?}: {}", path, e),
        }
    }
    println!("Library: imported {} file(s)", tracks.len());
    Ok(tracks)
}

/// Scan common device music folders (Android Music / Download). Needs READ_MEDIA_AUDIO.
#[tauri::command]
pub async fn scan_device_music(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    let mut roots: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "android")]
    {
        for p in [
            "/storage/emulated/0/Music",
            "/storage/emulated/0/Download",
            "/storage/emulated/0/Podcasts",
            "/storage/emulated/0/Audiobooks",
            "/sdcard/Music",
            "/sdcard/Download",
        ] {
            let pb = PathBuf::from(p);
            if pb.is_dir() {
                roots.push(pb);
            }
        }
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            for sub in ["Music", "Downloads", "Download"] {
                let pb = PathBuf::from(&home).join(sub);
                if pb.is_dir() {
                    roots.push(pb);
                }
            }
        }
    }

    if roots.is_empty() {
        return Err(
            "No Music/Download folder found. Grant audio permission, or use Add songs to pick files."
                .into(),
        );
    }

    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for root in roots {
        println!("Library: scanning device music root {:?}", root);
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() || !is_audio_ext(path) {
                continue;
            }
            let key = path.to_string_lossy().to_string();
            if !seen.insert(key) {
                continue;
            }
            if let Ok(mut track) = extract_metadata(path) {
                let mut stmt = conn
                    .prepare("SELECT local_lyrics FROM tracks WHERE filepath = ?1")
                    .map_err(|e| e.to_string())?;
                track.local_lyrics = stmt
                    .query_row(params![track.filepath], |row| row.get(0))
                    .ok();
                upsert_track(&conn, &track);
                tracks.push(track);
            }
        }
    }

    if tracks.is_empty() {
        return Err(
            "No audio files found in Music/Download. Try Add songs and pick files manually.".into(),
        );
    }
    println!("Library: device scan found {} track(s)", tracks.len());
    Ok(tracks)
}

#[tauri::command]
pub fn runtime_platform() -> String {
    #[cfg(target_os = "android")]
    {
        return "android".into();
    }
    #[cfg(target_os = "ios")]
    {
        return "ios".into();
    }
    #[cfg(target_os = "windows")]
    {
        return "windows".into();
    }
    #[cfg(target_os = "macos")]
    {
        return "macos".into();
    }
    #[cfg(target_os = "linux")]
    {
        return "linux".into();
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "ios",
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    {
        "unknown".into()
    }
}
