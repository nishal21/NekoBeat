use crate::playback::TrackMeta;
use lofty::file::AudioFile;
use lofty::prelude::*;
use lofty::probe::Probe;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

#[derive(Clone)]
pub struct LibraryDb {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DbTrack {
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    path: String,
    duration_ms: Option<u64>,
    cover_path: Option<String>,
    liked: bool,
}

impl LibraryDb {
    pub fn open(app_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
        let path = app_dir.join("nekobeat.db");
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT,
                path TEXT NOT NULL UNIQUE,
                duration_ms INTEGER,
                cover_path TEXT,
                liked INTEGER NOT NULL DEFAULT 0
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn upsert(&self, t: &DbTrack) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "INSERT INTO tracks (id,title,artist,album,path,duration_ms,cover_path,liked)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(path) DO UPDATE SET
                   title=excluded.title, artist=excluded.artist, album=excluded.album,
                   duration_ms=excluded.duration_ms, cover_path=excluded.cover_path",
                params![
                    t.id,
                    t.title,
                    t.artist,
                    t.album,
                    t.path,
                    t.duration_ms.map(|v| v as i64),
                    t.cover_path,
                    t.liked as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<TrackMeta>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id,title,artist,album,path,duration_ms,cover_path FROM tracks ORDER BY artist, album, title",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TrackMeta {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artist: r.get(2)?,
                    album: r.get(3)?,
                    path: Some(r.get(4)?),
                    duration_ms: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                    cover_url: r.get(6)?,
                    source: Some("local".into()),
                    isrc: None,
                    spotify_id: None,
                    stream_url: None,
                    quality_label: None,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn liked(&self) -> Result<Vec<TrackMeta>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id,title,artist,album,path,duration_ms,cover_path FROM tracks WHERE liked=1 ORDER BY artist, title",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TrackMeta {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    artist: r.get(2)?,
                    album: r.get(3)?,
                    path: Some(r.get(4)?),
                    duration_ms: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                    cover_url: r.get(6)?,
                    source: Some("local".into()),
                    isrc: None,
                    spotify_id: None,
                    stream_url: None,
                    quality_label: None,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn set_liked(&self, id: &str, liked: bool) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "UPDATE tracks SET liked=?1 WHERE id=?2",
                params![liked as i64, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn scan_file(path: &Path, cover_dir: &Path) -> Option<DbTrack> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let title = tag
        .and_then(|t| t.title().map(|s| s.to_string()))
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Unknown".into())
        });
    let artist = tag
        .and_then(|t| t.artist().map(|s| s.to_string()))
        .unwrap_or_else(|| "Unknown Artist".into());
    let album = tag.and_then(|t| t.album().map(|s| s.to_string()));
    let duration_ms = Some(tagged.properties().duration().as_millis() as u64);
    let id = format!("{:x}", md5_like(&path.to_string_lossy()));

    let mut cover_path = None;
    // Reuse on-disk cache if present (don't re-extract every scan).
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let existing = cover_dir.join(format!("{id}.{ext}"));
        if existing.is_file() {
            cover_path = Some(existing.to_string_lossy().into_owned());
            break;
        }
    }
    if cover_path.is_none() {
        // Check every tag — some MP3s stash APIC on a non-primary frame set
        for t in tagged.tags() {
            if let Some(pic) = t.pictures().first() {
                let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
                let ext = if mime.contains("png") {
                    "png"
                } else if mime.contains("webp") {
                    "webp"
                } else {
                    "jpg"
                };
                let out = cover_dir.join(format!("{id}.{ext}"));
                if std::fs::write(&out, pic.data()).is_ok() {
                    cover_path = Some(out.to_string_lossy().into_owned());
                    break;
                }
            }
        }
    }
    if cover_path.is_none() {
        if let Some(folder) = path.parent() {
            for name in [
                "cover.jpg",
                "Cover.jpg",
                "folder.jpg",
                "Folder.jpg",
                "cover.png",
                "folder.png",
                "AlbumArt.jpg",
                "AlbumArtSmall.jpg",
                "front.jpg",
                "Front.jpg",
            ] {
                let c = folder.join(name);
                if c.is_file() {
                    let ext = c
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("jpg");
                    let dest = cover_dir.join(format!("{id}.{ext}"));
                    if std::fs::copy(&c, &dest).is_ok() {
                        cover_path = Some(dest.to_string_lossy().into_owned());
                    } else {
                        cover_path = Some(c.to_string_lossy().into_owned());
                    }
                    break;
                }
            }
        }
    }

    Some(DbTrack {
        id,
        title,
        artist,
        album,
        path: path.to_string_lossy().into_owned(),
        duration_ms,
        cover_path,
        liked: false,
    })
}

fn md5_like(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

pub fn scan_paths(db: &LibraryDb, paths: &[String], app_dir: &Path) -> Result<Vec<TrackMeta>, String> {
    let cover_dir = app_dir.join("covers");
    std::fs::create_dir_all(&cover_dir).map_err(|e| e.to_string())?;
    let exts = ["mp3", "flac", "m4a", "aac", "ogg", "wav", "opus", "wma"];
    for root in paths {
        for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !exts.contains(&ext.as_str()) {
                continue;
            }
            if let Some(t) = scan_file(path, &cover_dir) {
                let _ = db.upsert(&t);
            }
        }
    }
    db.list()
}

/// Add a single downloaded file into the library (HiFi / imports).
pub fn import_file(db: &LibraryDb, app_dir: &Path, path: &Path) -> Result<TrackMeta, String> {
    let cover_dir = app_dir.join("covers");
    std::fs::create_dir_all(&cover_dir).map_err(|e| e.to_string())?;
    let t = scan_file(path, &cover_dir).ok_or_else(|| {
        format!("Could not read audio file: {}", path.display())
    })?;
    db.upsert(&t)?;
    Ok(TrackMeta {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        path: Some(t.path),
        duration_ms: t.duration_ms,
        cover_url: t.cover_path,
        source: Some("local".into()),
        isrc: None,
        spotify_id: None,
        stream_url: None,
        quality_label: None,
    })
}

pub fn import_downloaded(app: &tauri::AppHandle, path: &Path) -> Result<TrackMeta, String> {
    let db = app.state::<LibraryDb>();
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let meta = import_file(&db, &dir, path)?;
    let _ = app.emit("library-changed", meta.clone());
    Ok(meta)
}

#[tauri::command]
pub fn library_scan(
    db: tauri::State<'_, LibraryDb>,
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<TrackMeta>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    scan_paths(&db, &paths, &dir)
}

#[tauri::command]
pub fn library_list(db: tauri::State<'_, LibraryDb>) -> Result<Vec<TrackMeta>, String> {
    db.list()
}

#[tauri::command]
pub fn library_like(
    db: tauri::State<'_, LibraryDb>,
    id: String,
    liked: bool,
) -> Result<(), String> {
    db.set_liked(&id, liked)
}

#[tauri::command]
pub fn library_liked(db: tauri::State<'_, LibraryDb>) -> Result<Vec<TrackMeta>, String> {
    db.liked()
}
