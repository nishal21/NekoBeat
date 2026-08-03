use lofty::config::ParseOptions;
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Manager;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TrackData {
    pub filepath: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(default)]
    pub album_artist: Option<String>,
    pub duration_ms: u64,
    pub source: Option<String>,
    pub local_lyrics: Option<String>,
    #[serde(default)]
    pub artwork_url: Option<String>,
    /// Uppercase container/ext label, e.g. FLAC / MP3
    #[serde(default)]
    pub format: Option<String>,
    /// Audio bitrate in kbps when known
    #[serde(default)]
    pub bitrate_kbps: Option<u32>,
    /// Sample rate in Hz when known
    #[serde(default)]
    pub sample_rate_hz: Option<u32>,
    /// Channel count (1 = mono, 2 = stereo, …)
    #[serde(default)]
    pub channels: Option<u8>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
    #[serde(default)]
    pub disc_number: Option<u32>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub date_added: i64,
    #[serde(default)]
    pub replaygain_track_gain: Option<f64>,
    #[serde(default)]
    pub replaygain_track_peak: Option<f64>,
    #[serde(default)]
    pub replaygain_album_gain: Option<f64>,
    #[serde(default)]
    pub replaygain_album_peak: Option<f64>,
}

#[derive(Serialize, Debug, Clone)]
pub struct LibrarySettings {
    pub directories: Vec<String>,
    pub min_file_size_bytes: u64,
}

const DEFAULT_MIN_FILE_SIZE_BYTES: u64 = 16 * 1024;

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

fn covers_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("covers");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Folder cover fallbacks next to the audio file (cover.jpg, folder.png, …).
fn folder_cover_in_dir(dir: &Path) -> Option<PathBuf> {
    const NAMES: &[&str] = &[
        "Folder.jpg",
        "Folder.png",
        "folder.jpg",
        "folder.png",
        "Cover.jpg",
        "Cover.png",
        "cover.jpg",
        "cover.png",
        "AlbumArt.jpg",
        "AlbumArt.png",
        "AlbumArtSmall.jpg",
        "front.jpg",
        "front.png",
        "thumb.jpg",
        "Thumb.jpg",
    ];
    for name in NAMES {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Android often exposes the same tree as both `/sdcard/...` and `/storage/emulated/0/...`.
fn normalize_library_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy().replace('\\', "/");
    let mut normalized = raw;
    for prefix in ["/sdcard", "/mnt/sdcard", "/storage/self/primary"] {
        if let Some(rest) = normalized
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        {
            normalized = format!("/storage/emulated/0{rest}");
            break;
        }
    }
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    PathBuf::from(normalized)
}

fn file_identity(path: &Path) -> Option<(u64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((meta.len(), mtime))
}

fn dedupe_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        let norm = normalize_library_path(&root);
        let key = norm.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            out.push(norm);
        }
    }
    out
}

/// Collapse `/sdcard` vs `/storage/emulated/0` rows so each file appears once.
fn collapse_duplicate_filepaths(conn: &Connection) -> SqlResult<usize> {
    let paths: Vec<String> = {
        let mut stmt = conn.prepare("SELECT filepath FROM tracks")?;
        let rows = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(Result::ok)
            .collect();
        rows
    };
    let mut removed = 0usize;
    for path in paths {
        let norm = normalize_library_path(Path::new(&path))
            .to_string_lossy()
            .into_owned();
        if norm == path {
            continue;
        }
        let canon_exists: bool = conn
            .query_row(
                "SELECT 1 FROM tracks WHERE filepath = ?1",
                [&norm],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if canon_exists {
            conn.execute("DELETE FROM tracks WHERE filepath = ?1", [&path])?;
            removed += 1;
        } else {
            conn.execute(
                "UPDATE tracks SET filepath = ?1 WHERE filepath = ?2",
                params![norm, path],
            )?;
        }
    }
    Ok(removed)
}

fn picture_ext(mime: &MimeType) -> &'static str {
    match mime {
        MimeType::Jpeg => "jpg",
        MimeType::Png => "png",
        MimeType::Gif => "gif",
        MimeType::Bmp => "bmp",
        MimeType::Tiff => "tiff",
        _ => "img",
    }
}

/// Extract the first embedded picture into the covers cache.
fn extract_embedded_cover(path: &Path, tagged: &TaggedFile, covers: &Path) -> Option<PathBuf> {
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let picture = tag.pictures().first()?;
    let ext = picture_ext(picture.mime_type().unwrap_or(&MimeType::Jpeg));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cover".into());
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    // File stems are commonly repeated across albums ("01", "cover", etc.).
    // Include path and image bytes so covers cannot collide or stay stale.
    let mut hasher = Sha1::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(picture.data());
    let digest = format!("{:x}", hasher.finalize());
    let out = covers.join(format!("{}_{}_embed.{}", safe, &digest[..16], ext));
    if out.is_file() {
        return Some(out);
    }
    let mut f = fs::File::create(&out).ok()?;
    f.write_all(picture.data()).ok()?;
    Some(out)
}

fn resolve_track_artwork(
    path: &Path,
    tagged: Option<&TaggedFile>,
    covers: &Path,
    read_embedded: bool,
    folder_cache: &mut HashMap<PathBuf, Option<PathBuf>>,
) -> Option<String> {
    if let Some(dir) = path.parent() {
        let folder = folder_cache
            .entry(dir.to_path_buf())
            .or_insert_with(|| folder_cover_in_dir(dir))
            .clone();
        if let Some(folder) = folder {
            return Some(folder.to_string_lossy().into_owned());
        }
    }
    if read_embedded {
        if let Some(tagged) = tagged {
            if let Some(embedded) = extract_embedded_cover(path, tagged, covers) {
                return Some(embedded.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn format_label(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .filter(|s| !s.is_empty())
}

/// Sidecar `.lrc` next to the audio file.
fn sidecar_lyrics(path: &Path) -> Option<String> {
    for ext in ["lrc", "LRC"] {
        let p = path.with_extension(ext);
        if p.is_file() {
            if let Ok(text) = fs::read_to_string(&p) {
                let t = text.trim();
                if !t.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn tag_lyrics(tag: Option<&lofty::tag::Tag>) -> Option<String> {
    let tag = tag?;
    tag.get_string(ItemKey::Lyrics)
        .or_else(|| tag.get_string(ItemKey::UnsyncLyrics))
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

fn tag_number(tag: Option<&lofty::tag::Tag>, key: ItemKey) -> Option<f64> {
    tag?.get_string(key)?
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .trim()
        .parse()
        .ok()
}

fn extract_metadata(
    path: &Path,
    covers: &Path,
    read_embedded_covers: bool,
    folder_cache: &mut HashMap<PathBuf, Option<PathBuf>>,
) -> Result<(TrackData, u64, i64), String> {
    let path = normalize_library_path(path);
    let (file_size, file_mtime) = file_identity(&path).ok_or_else(|| {
        format!("Failed to stat file: {}", path.display())
    })?;

    let mut options = ParseOptions::new();
    options = options.read_cover_art(read_embedded_covers);

    let probe_result = match Probe::open(&path) {
        Ok(probe) => match probe.options(options).guess_file_type() {
            Ok(probe) => match probe.read() {
                Ok(res) => res,
                Err(e) => {
                    return Err(format!("Failed to read tagged file: {}", e));
                }
            },
            Err(e) => {
                return Err(format!("Failed to identify audio file: {}", e));
            }
        },
        Err(e) => {
            return Err(format!("Failed to open file: {}", e));
        }
    };

    let tag = probe_result
        .primary_tag()
        .or_else(|| probe_result.first_tag());

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
    let album_artist = tag
        .and_then(|t| t.get_string(ItemKey::AlbumArtist))
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty());
    let props = probe_result.properties();
    let duration_ms = props.duration().as_millis() as u64;
    let bitrate_kbps = props
        .audio_bitrate()
        .or_else(|| props.overall_bitrate())
        .filter(|&b| b > 0);
    let sample_rate_hz = props.sample_rate().filter(|&r| r > 0);
    let channels = props.channels().filter(|&c| c > 0);
    let format = format_label(&path);
    let artwork_url = resolve_track_artwork(
        &path,
        Some(&probe_result),
        covers,
        read_embedded_covers,
        folder_cache,
    );
    let local_lyrics = sidecar_lyrics(&path).or_else(|| tag_lyrics(tag));
    let genre = tag
        .and_then(|t| t.genre().as_deref().map(str::to_owned))
        .filter(|s| !s.trim().is_empty());
    let track_number = tag.and_then(|t| t.track());
    let disc_number = tag.and_then(|t| t.disk());
    let year = tag
        .and_then(|t| t.get_string(ItemKey::Year))
        .and_then(|value| value.get(..4).unwrap_or(value).parse::<u32>().ok());
    let date_added = chrono::Utc::now().timestamp();
    let replaygain_track_gain = tag_number(tag, ItemKey::ReplayGainTrackGain);
    let replaygain_track_peak = tag_number(tag, ItemKey::ReplayGainTrackPeak);
    let replaygain_album_gain = tag_number(tag, ItemKey::ReplayGainAlbumGain);
    let replaygain_album_peak = tag_number(tag, ItemKey::ReplayGainAlbumPeak);

    Ok((
        TrackData {
            filepath: path.to_string_lossy().into_owned(),
            title,
            artist,
            album,
            album_artist,
            duration_ms,
            source: Some("local".to_string()),
            local_lyrics,
            artwork_url,
            format,
            bitrate_kbps,
            sample_rate_hz,
            channels,
            genre,
            track_number,
            disc_number,
            year,
            date_added,
            replaygain_track_gain,
            replaygain_track_peak,
            replaygain_album_gain,
            replaygain_album_peak,
        },
        file_size,
        file_mtime,
    ))
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
                println!("Library: migrated {:?} -> {:?}", candidate, dest);
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
            album_artist TEXT,
            duration_ms INTEGER,
            local_lyrics TEXT,
            artwork_url TEXT,
            format TEXT,
            bitrate_kbps INTEGER,
            sample_rate_hz INTEGER,
            channels INTEGER,
            genre TEXT,
            track_number INTEGER,
            disc_number INTEGER,
            year INTEGER,
            date_added INTEGER NOT NULL DEFAULT 0,
            replaygain_track_gain REAL,
            replaygain_track_peak REAL,
            replaygain_album_gain REAL,
            replaygain_album_peak REAL
        )",
        [],
    )?;

    ensure_column(&conn, "local_lyrics", "TEXT")?;
    ensure_column(&conn, "artwork_url", "TEXT")?;
    ensure_column(&conn, "format", "TEXT")?;
    ensure_column(&conn, "bitrate_kbps", "INTEGER")?;
    ensure_column(&conn, "sample_rate_hz", "INTEGER")?;
    ensure_column(&conn, "channels", "INTEGER")?;
    ensure_column(&conn, "genre", "TEXT")?;
    ensure_column(&conn, "track_number", "INTEGER")?;
    ensure_column(&conn, "disc_number", "INTEGER")?;
    ensure_column(&conn, "year", "INTEGER")?;
    ensure_column(&conn, "date_added", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "album_artist", "TEXT")?;
    ensure_column(&conn, "replaygain_track_gain", "REAL")?;
    ensure_column(&conn, "replaygain_track_peak", "REAL")?;
    ensure_column(&conn, "replaygain_album_gain", "REAL")?;
    ensure_column(&conn, "replaygain_album_peak", "REAL")?;
    ensure_column(&conn, "file_size", "INTEGER")?;
    ensure_column(&conn, "file_mtime", "INTEGER")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS library_directories (
            path TEXT PRIMARY KEY,
            added_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS library_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO library_settings (key, value) VALUES ('min_file_size_bytes', ?1)",
        [DEFAULT_MIN_FILE_SIZE_BYTES.to_string()],
    )?;
    conn.execute(
        "UPDATE tracks SET date_added = CAST(strftime('%s','now') AS INTEGER) WHERE date_added = 0",
        [],
    )?;
    let _ = collapse_duplicate_filepaths(&conn);

    Ok(conn)
}

fn ensure_column(conn: &Connection, name: &str, sql_type: &str) -> SqlResult<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(tracks)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column?.eq_ignore_ascii_case(name) {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE tracks ADD COLUMN {name} {sql_type}"),
        [],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn scan_directory(app: tauri::AppHandle, path: String) -> Result<Vec<TrackData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|e| e.to_string())?;
        let covers = covers_dir(&app);
        let min_size = min_file_size(&conn);
        let root = normalize_library_path(Path::new(&path));
        if !root.is_dir() {
            return Err("Library directory does not exist".into());
        }
        conn.execute(
            "INSERT OR IGNORE INTO library_directories (path) VALUES (?1)",
            [root.to_string_lossy().as_ref()],
        )
        .map_err(|e| e.to_string())?;

        let paths = collect_audio_paths(std::iter::once(root), min_size);
        ingest_audio_paths(&conn, &covers, paths, true)
    })
    .await
    .map_err(|e| format!("scan_directory join: {e}"))?
}

fn collect_audio_paths<I>(roots: I, min_size: u64) -> Vec<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for root in dedupe_roots(roots.into_iter().collect()) {
        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() || !is_audio_ext(path) || !meets_min_file_size(path, min_size) {
                continue;
            }
            let norm = normalize_library_path(path);
            let key = norm.to_string_lossy().to_ascii_lowercase();
            if seen.insert(key) {
                paths.push(norm);
            }
        }
    }
    paths
}

fn load_cached_track(conn: &Connection, filepath: &str) -> Option<TrackData> {
    conn.query_row(
        "SELECT filepath, title, artist, album, album_artist, duration_ms, local_lyrics, artwork_url, format, bitrate_kbps, sample_rate_hz, channels, genre, track_number, disc_number, year, date_added, replaygain_track_gain, replaygain_track_peak, replaygain_album_gain, replaygain_album_peak FROM tracks WHERE filepath = ?1",
        [filepath],
        |row| {
            Ok(TrackData {
                filepath: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                artist: row
                    .get::<_, Option<String>>(2)?
                    .unwrap_or_else(|| "Unknown Artist".into()),
                album: row
                    .get::<_, Option<String>>(3)?
                    .unwrap_or_else(|| "Unknown Album".into()),
                album_artist: row.get(4)?,
                duration_ms: u64::try_from(row.get::<usize, i64>(5)?).unwrap_or(0),
                source: Some("local".into()),
                local_lyrics: row.get(6)?,
                artwork_url: row.get(7)?,
                format: row.get(8)?,
                bitrate_kbps: row
                    .get::<usize, Option<i64>>(9)?
                    .and_then(|v| u32::try_from(v).ok()),
                sample_rate_hz: row
                    .get::<usize, Option<i64>>(10)?
                    .and_then(|v| u32::try_from(v).ok()),
                channels: row
                    .get::<usize, Option<i64>>(11)?
                    .and_then(|v| u8::try_from(v).ok()),
                genre: row.get(12)?,
                track_number: row
                    .get::<usize, Option<i64>>(13)?
                    .and_then(|v| u32::try_from(v).ok()),
                disc_number: row
                    .get::<usize, Option<i64>>(14)?
                    .and_then(|v| u32::try_from(v).ok()),
                year: row
                    .get::<usize, Option<i64>>(15)?
                    .and_then(|v| u32::try_from(v).ok()),
                date_added: row.get(16)?,
                replaygain_track_gain: row.get(17)?,
                replaygain_track_peak: row.get(18)?,
                replaygain_album_gain: row.get(19)?,
                replaygain_album_peak: row.get(20)?,
            })
        },
    )
    .ok()
}

fn unchanged_cached_track(conn: &Connection, path: &Path, size: u64, mtime: i64) -> Option<TrackData> {
    let filepath = path.to_string_lossy();
    let row: Option<(i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(file_size, -1), COALESCE(file_mtime, -1) FROM tracks WHERE filepath = ?1",
            [filepath.as_ref()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    match row {
        Some((stored_size, stored_mtime))
            if stored_size >= 0
                && stored_mtime >= 0
                && stored_size as u64 == size
                && stored_mtime == mtime =>
        {
            load_cached_track(conn, filepath.as_ref())
        }
        _ => None,
    }
}

/// Fast bulk ingest: skip unchanged files, skip embedded cover decode, parallel tag reads.
fn ingest_audio_paths(
    conn: &Connection,
    covers: &Path,
    paths: Vec<PathBuf>,
    read_embedded_covers: bool,
) -> Result<Vec<TrackData>, String> {
    let _ = collapse_duplicate_filepaths(conn);

    let mut reuse = Vec::new();
    let mut to_parse = Vec::new();
    for path in paths {
        match file_identity(&path) {
            Some((size, mtime)) => {
                if let Some(cached) = unchanged_cached_track(conn, &path, size, mtime) {
                    // Re-parse when cover is missing so Refresh restores embedded / folder art
                    if cached
                        .artwork_url
                        .as_ref()
                        .map(|u| !u.trim().is_empty())
                        .unwrap_or(false)
                    {
                        reuse.push(cached);
                    } else {
                        to_parse.push(path);
                    }
                } else {
                    to_parse.push(path);
                }
            }
            None => to_parse.push(path),
        }
    }

    let covers_owned = covers.to_path_buf();
    let parsed: Vec<(TrackData, u64, i64)> = to_parse
        .par_iter()
        .filter_map(|path| {
            let mut folder_cache = HashMap::new();
            extract_metadata(path, &covers_owned, read_embedded_covers, &mut folder_cache).ok()
        })
        .collect();

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut tracks = reuse;
    for (mut track, size, mtime) in parsed {
        if let Ok(Some((lyrics, art))) = tx
            .query_row(
                "SELECT local_lyrics, artwork_url FROM tracks WHERE filepath = ?1",
                [&track.filepath],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
        {
            if track.local_lyrics.is_none() {
                track.local_lyrics = lyrics;
            }
            if track.artwork_url.is_none() {
                track.artwork_url = art;
            }
        }
        upsert_track_with_identity(&tx, &track, size, mtime).map_err(|e| e.to_string())?;
        tracks.push(track);
    }
    tx.commit().map_err(|e| e.to_string())?;

    // Stable unique list by normalized filepath.
    let mut seen = HashSet::new();
    tracks.retain(|t| seen.insert(normalize_library_path(Path::new(&t.filepath)).to_string_lossy().into_owned()));
    Ok(tracks)
}


#[tauri::command]
pub fn get_cached_tracks(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT filepath, title, artist, album, album_artist, duration_ms, local_lyrics, artwork_url, format, bitrate_kbps, sample_rate_hz, channels, genre, track_number, disc_number, year, date_added, replaygain_track_gain, replaygain_track_peak, replaygain_album_gain, replaygain_album_peak FROM tracks",
        )
        .map_err(|e| e.to_string())?;

    let track_iter = stmt
        .query_map([], |row| {
            let filepath: String = row.get(0)?;
            let raw_title = row.get::<_, Option<String>>(1)?.unwrap_or_default();
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
                artist: row
                    .get::<_, Option<String>>(2)?
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "Unknown Artist".into()),
                album: row
                    .get::<_, Option<String>>(3)?
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "Unknown Album".into()),
                album_artist: row.get(4)?,
                duration_ms: u64::try_from(row.get::<usize, i64>(5)?).unwrap_or(0),
                source: Some("local".to_string()),
                local_lyrics: row.get(6)?,
                artwork_url: row.get(7)?,
                format: row.get(8)?,
                bitrate_kbps: row
                    .get::<usize, Option<i64>>(9)?
                    .and_then(|v| u32::try_from(v).ok()),
                sample_rate_hz: row
                    .get::<usize, Option<i64>>(10)?
                    .and_then(|v| u32::try_from(v).ok()),
                channels: row
                    .get::<usize, Option<i64>>(11)?
                    .and_then(|v| u8::try_from(v).ok()),
                genre: row.get(12)?,
                track_number: row
                    .get::<usize, Option<i64>>(13)?
                    .and_then(|v| u32::try_from(v).ok()),
                disc_number: row
                    .get::<usize, Option<i64>>(14)?
                    .and_then(|v| u32::try_from(v).ok()),
                year: row
                    .get::<usize, Option<i64>>(15)?
                    .and_then(|v| u32::try_from(v).ok()),
                date_added: row.get(16)?,
                replaygain_track_gain: row.get(17)?,
                replaygain_track_peak: row.get(18)?,
                replaygain_album_gain: row.get(19)?,
                replaygain_album_peak: row.get(20)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    for track in track_iter {
        if let Ok(mut t) = track {
            t.filepath = normalize_library_path(Path::new(&t.filepath))
                .to_string_lossy()
                .into_owned();
            if seen.insert(t.filepath.clone()) {
                tracks.push(t);
            }
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

#[tauri::command]
pub fn reindex_library(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let _ = collapse_duplicate_filepaths(&conn);
    let paths: Vec<PathBuf> = {
        let mut stmt = conn
            .prepare("SELECT filepath FROM tracks")
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        rows.into_iter()
            .map(|p| normalize_library_path(Path::new(&p)))
            .collect()
    };
    let covers = covers_dir(&app);
    let min_size = min_file_size(&conn);
    let mut kept = Vec::new();
    for path in paths {
        if !path.is_file() || !meets_min_file_size(&path, min_size) {
            let _ = conn.execute(
                "DELETE FROM tracks WHERE filepath=?1",
                [path.to_string_lossy().as_ref()],
            );
            continue;
        }
        kept.push(path);
    }
    ingest_audio_paths(&conn, &covers, kept, true)
}

fn is_audio_ext(path: &Path) -> bool {
    path.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            matches!(
                e.as_str(),
                "mp3"
                    | "flac"
                    | "m4a"
                    | "mp4"
                    | "wav"
                    | "ogg"
                    | "opus"
                    | "aac"
                    | "wma"
                    | "aiff"
                    | "aif"
                    | "wv"
                    | "ape"
                    | "alac"
                    | "webm"
                    | "dsf"
                    | "dff"
            )
        })
        .unwrap_or(false)
}

fn min_file_size(conn: &Connection) -> u64 {
    conn.query_row(
        "SELECT value FROM library_settings WHERE key='min_file_size_bytes'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| value.parse().ok())
    .unwrap_or(DEFAULT_MIN_FILE_SIZE_BYTES)
}

fn meets_min_file_size(path: &Path, minimum: u64) -> bool {
    minimum == 0
        || fs::metadata(path)
            .map(|meta| meta.len() >= minimum)
            .unwrap_or(false)
}

fn upsert_track(conn: &Connection, track: &TrackData) -> SqlResult<()> {
    let (size, mtime) = file_identity(Path::new(&track.filepath)).unwrap_or((0, 0));
    upsert_track_with_identity(conn, track, size, mtime)
}

fn upsert_track_with_identity(
    conn: &Connection,
    track: &TrackData,
    file_size: u64,
    file_mtime: i64,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO tracks (filepath, title, artist, album, album_artist, duration_ms, local_lyrics, artwork_url, format, bitrate_kbps, sample_rate_hz, channels, genre, track_number, disc_number, year, date_added, replaygain_track_gain, replaygain_track_peak, replaygain_album_gain, replaygain_album_peak, file_size, file_mtime)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
         ON CONFLICT(filepath) DO UPDATE SET
           title=excluded.title, artist=excluded.artist, album=excluded.album,
           album_artist=COALESCE(excluded.album_artist, tracks.album_artist),
           duration_ms=excluded.duration_ms,
           local_lyrics=COALESCE(excluded.local_lyrics, tracks.local_lyrics),
           artwork_url=COALESCE(excluded.artwork_url, tracks.artwork_url),
           format=COALESCE(excluded.format, tracks.format),
           bitrate_kbps=COALESCE(excluded.bitrate_kbps, tracks.bitrate_kbps),
           sample_rate_hz=COALESCE(excluded.sample_rate_hz, tracks.sample_rate_hz),
           channels=COALESCE(excluded.channels, tracks.channels),
           genre=COALESCE(excluded.genre, tracks.genre),
           track_number=COALESCE(excluded.track_number, tracks.track_number),
           disc_number=COALESCE(excluded.disc_number, tracks.disc_number),
           year=COALESCE(excluded.year, tracks.year),
           replaygain_track_gain=COALESCE(excluded.replaygain_track_gain, tracks.replaygain_track_gain),
           replaygain_track_peak=COALESCE(excluded.replaygain_track_peak, tracks.replaygain_track_peak),
           replaygain_album_gain=COALESCE(excluded.replaygain_album_gain, tracks.replaygain_album_gain),
           replaygain_album_peak=COALESCE(excluded.replaygain_album_peak, tracks.replaygain_album_peak),
           file_size=excluded.file_size,
           file_mtime=excluded.file_mtime",
        params![
            track.filepath,
            track.title,
            track.artist,
            track.album,
            track.album_artist,
            track.duration_ms as i64,
            track.local_lyrics,
            track.artwork_url,
            track.format,
            track.bitrate_kbps.map(|b| b as i64),
            track.sample_rate_hz.map(|r| r as i64),
            track.channels.map(|c| c as i64),
            track.genre,
            track.track_number.map(|v| v as i64),
            track.disc_number.map(|v| v as i64),
            track.year.map(|v| v as i64),
            track.date_added,
            track.replaygain_track_gain,
            track.replaygain_track_peak,
            track.replaygain_album_gain,
            track.replaygain_album_peak,
            file_size as i64,
            file_mtime,
        ],
    )?;
    Ok(())
}

/// Save fetched cover / lyrics for a library row (title+artist enrichment).
/// HTTP covers are downloaded into app `covers/` so they work offline forever.
#[tauri::command]
pub async fn update_library_enrichment(
    app: tauri::AppHandle,
    filepath: String,
    artwork_url: Option<String>,
    local_lyrics: Option<String>,
) -> Result<(), String> {
    if filepath.trim().is_empty() {
        return Err("empty filepath".into());
    }
    let mut art = artwork_url;
    if let Some(ref url) = art {
        let trimmed = url.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            match cache_http_cover_to_disk(&app, trimmed).await {
                Ok(local) => art = Some(local.to_string_lossy().into_owned()),
                Err(e) => eprintln!("Library: cover cache failed (keeping URL): {}", e),
            }
        }
    }
    let art_for_db = art.clone();
    let lyrics_for_db = local_lyrics.clone();
    let fp = filepath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|e| e.to_string())?;
        if let Some(ref url) = art_for_db {
            if !url.trim().is_empty() {
                conn.execute(
                    "UPDATE tracks SET artwork_url = ?1 WHERE filepath = ?2",
                    params![url, fp],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        if let Some(ref lyrics) = lyrics_for_db {
            if !lyrics.trim().is_empty() {
                conn.execute(
                    "UPDATE tracks SET local_lyrics = ?1 WHERE filepath = ?2",
                    params![lyrics, fp],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

/// Download a remote cover into app storage and point the library row at the local file.
/// Returns the local filesystem path (stable offline).
#[tauri::command]
pub async fn cache_remote_artwork(
    app: tauri::AppHandle,
    filepath: String,
    url: String,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".into());
    }
    // Already a local cover / file path — just persist the pointer
    if !url.starts_with("http://") && !url.starts_with("https://") {
        if !filepath.trim().is_empty() {
            let fp = filepath.clone();
            let local = url.clone();
            let app2 = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let conn = init_db(&app2).map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE tracks SET artwork_url = ?1 WHERE filepath = ?2",
                    params![local, fp],
                )
                .map_err(|e| e.to_string())?;
                Ok::<(), String>(())
            })
            .await;
        }
        return Ok(url);
    }

    let local = cache_http_cover_to_disk(&app, &url).await?;
    let local_str = local.to_string_lossy().into_owned();
    if !filepath.trim().is_empty() {
        let fp = filepath.clone();
        let path_for_db = local_str.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let conn = init_db(&app2).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE tracks SET artwork_url = ?1 WHERE filepath = ?2",
                params![path_for_db, fp],
            )
            .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(local_str)
}

/// Read a local cover file into a data URL so the WebView can show it
/// (Android asset protocol often fails for `/storage/...` and app covers dirs;
/// Media3 still uses `file://` successfully outside the app).
#[tauri::command]
pub fn artwork_as_data_url(path: String) -> Result<String, String> {
    let raw_in = path.trim();
    if raw_in.is_empty() {
        return Err("empty path".into());
    }
    let mut raw = raw_in.to_string();
    if let Some(rest) = raw.strip_prefix("file:") {
        // file:///data/... or file://localhost/data/...
        let rest = rest.trim_start_matches('/');
        let rest = rest.strip_prefix("localhost/").unwrap_or(rest);
        // Windows drive: C:/...
        if rest.len() >= 2 && rest.as_bytes().get(1) == Some(&b':') {
            raw = rest.to_string();
        } else {
            raw = format!("/{rest}");
        }
    }

    let p = PathBuf::from(&raw);
    if !p.is_file() {
        return Err(format!("not a file: {raw}"));
    }
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 6_000_000 {
        return Err("cover too large".into());
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty cover".into());
    }
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        _ => {
            if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                "image/png"
            } else if bytes.len() > 11 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
                "image/webp"
            } else {
                "image/jpeg"
            }
        }
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

async fn cache_http_cover_to_disk(app: &tauri::AppHandle, url: &str) -> Result<PathBuf, String> {
    let covers = covers_dir(app);
    let mut hasher = Sha1::new();
    hasher.update(url.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let stem = format!("remote_{}", &digest[..16.min(digest.len())]);

    // Reuse existing download
    for ext in ["jpg", "jpeg", "png", "webp", "gif"] {
        let existing = covers.join(format!("{}.{}", stem, ext));
        if existing.is_file() {
            return Ok(existing);
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("cover download: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("cover HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let ext = if content_type.contains("png") {
        "png"
    } else if content_type.contains("webp") {
        "webp"
    } else if content_type.contains("gif") {
        "gif"
    } else {
        "jpg"
    };
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("cover body: {e}"))?;
    if bytes.len() < 200 {
        return Err("cover too small".into());
    }
    let path = covers.join(format!("{}.{}", stem, ext));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("cover write: {e}"))?;
    println!("Library: cached cover -> {:?}", path);
    Ok(path)
}

/// Import individual audio files (mobile file picker — no folder walk).
#[tauri::command]
pub async fn import_audio_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<TrackData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|e| e.to_string())?;
        let covers = covers_dir(&app);
        let import_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("library_import");
        let _ = fs::create_dir_all(&import_dir);
        let min_size = min_file_size(&conn);
        let mut seen_inputs = HashSet::new();
        let mut resolved = Vec::new();
        for raw in paths {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() || !seen_inputs.insert(trimmed.clone()) {
                continue;
            }
            let is_content_uri = trimmed.starts_with("content:");
            let path = {
                #[cfg(target_os = "android")]
                {
                    if trimmed.starts_with("content:") {
                        match crate::android_content::materialize_content_uri(&trimmed, &import_dir)
                        {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("Library: content URI copy failed: {}", e);
                                continue;
                            }
                        }
                    } else {
                        PathBuf::from(&trimmed)
                    }
                }
                #[cfg(not(target_os = "android"))]
                {
                    PathBuf::from(&trimmed)
                }
            };
            if !path.is_file() {
                continue;
            }
            if !is_audio_ext(&path) && !is_content_uri {
                continue;
            }
            if !meets_min_file_size(&path, min_size) {
                continue;
            }
            resolved.push(normalize_library_path(&path));
        }
        let tracks = ingest_audio_paths(&conn, &covers, resolved, true)?;
        println!("Library: imported {} file(s)", tracks.len());
        Ok(tracks)
    })
    .await
    .map_err(|e| format!("import_audio_files join: {e}"))?
}

/// Scan common device music folders (Android Music / Download). Needs READ_MEDIA_AUDIO.
#[tauri::command]
pub async fn scan_device_music(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots: Vec<PathBuf> = Vec::new();

        #[cfg(target_os = "android")]
        {
            // Only storage/emulated roots — /sdcard is the same tree and caused duplicates.
            for p in [
                "/storage/emulated/0/Music",
                "/storage/emulated/0/Download",
                "/storage/emulated/0/Podcasts",
                "/storage/emulated/0/Audiobooks",
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

        roots = dedupe_roots(roots);
        if roots.is_empty() {
            return Err(
                "No Music/Download folder found. Grant audio permission, or use Add songs to pick files."
                    .into(),
            );
        }

        let conn = init_db(&app).map_err(|e| e.to_string())?;
        let covers = covers_dir(&app);
        let min_size = min_file_size(&conn);
        let paths = collect_audio_paths(roots, min_size);
        let tracks = ingest_audio_paths(&conn, &covers, paths, true)?;
        if tracks.is_empty() {
            return Err(
                "No audio files found in Music/Download. Try Add songs and pick files manually."
                    .into(),
            );
        }
        println!("Library: device scan found {} track(s)", tracks.len());
        Ok(tracks)
    })
    .await
    .map_err(|e| format!("scan_device_music join: {e}"))?
}

/// Re-walk saved folders (desktop) and/or device Music/Download (Android) for new files.
#[tauri::command]
pub async fn refresh_library(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|e| e.to_string())?;
        let covers = covers_dir(&app);
        let min_size = min_file_size(&conn);
        let mut roots: Vec<PathBuf> = {
            let mut stmt = conn
                .prepare("SELECT path FROM library_directories")
                .map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            rows.into_iter()
                .map(|p| normalize_library_path(Path::new(&p)))
                .filter(|p| p.is_dir())
                .collect()
        };

        #[cfg(target_os = "android")]
        {
            for p in [
                "/storage/emulated/0/Music",
                "/storage/emulated/0/Download",
                "/storage/emulated/0/Podcasts",
                "/storage/emulated/0/Audiobooks",
            ] {
                let pb = PathBuf::from(p);
                if pb.is_dir() {
                    roots.push(pb);
                }
            }
        }

        roots = dedupe_roots(roots);
        if roots.is_empty() {
            return Err(
                "No music folders to refresh. Scan music or add a folder first.".into(),
            );
        }

        let paths = collect_audio_paths(roots, min_size);
        let tracks = ingest_audio_paths(&conn, &covers, paths, true)?;
        println!("Library: refresh found {} track(s)", tracks.len());
        Ok(tracks)
    })
    .await
    .map_err(|e| format!("refresh_library join: {e}"))?
}

#[tauri::command]
pub fn get_library_settings(app: tauri::AppHandle) -> Result<LibrarySettings, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT path FROM library_directories ORDER BY path COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let directories = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<SqlResult<Vec<String>>>()
        .map_err(|e| e.to_string())?;
    Ok(LibrarySettings {
        directories,
        min_file_size_bytes: min_file_size(&conn),
    })
}

#[tauri::command]
pub fn set_library_min_file_size(
    app: tauri::AppHandle,
    min_file_size_bytes: u64,
) -> Result<(), String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO library_settings (key, value) VALUES ('min_file_size_bytes', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [min_file_size_bytes.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_library_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM library_directories WHERE path=?1", [path])
        .map_err(|e| e.to_string())?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_extension_check_is_case_insensitive_and_rejects_sidecars() {
        assert!(is_audio_ext(Path::new("track.FLAC")));
        assert!(is_audio_ext(Path::new("track.m4a")));
        assert!(!is_audio_ext(Path::new("track.lrc")));
        assert!(!is_audio_ext(Path::new("track")));
    }

    #[test]
    fn column_migration_is_idempotent() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute(
            "CREATE TABLE tracks (id INTEGER PRIMARY KEY, filepath TEXT UNIQUE)",
            [],
        )
        .expect("create tracks");

        ensure_column(&conn, "artwork_url", "TEXT").expect("first migration");
        ensure_column(&conn, "artwork_url", "TEXT").expect("repeat migration");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = 'artwork_url'",
                [],
                |row| row.get(0),
            )
            .expect("column count");
        assert_eq!(count, 1);
    }

    #[test]
    fn minimum_file_size_policy_handles_missing_and_small_files() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("nekobeat-min-size-{}.mp3", std::process::id()));
        fs::write(&path, [0_u8; 8]).expect("write fixture");
        assert!(meets_min_file_size(&path, 8));
        assert!(!meets_min_file_size(&path, 9));
        let _ = fs::remove_file(path);
    }
}
