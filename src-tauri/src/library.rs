use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey};
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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
    /// Uppercase container/ext label, e.g. FLAC / MP3 (Harmonoid-style format chip)
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

/// Harmonoid-style folder cover fallbacks next to the audio file.
fn folder_cover_fallback(audio_path: &Path) -> Option<PathBuf> {
    let dir = audio_path.parent()?;
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

/// Extract first embedded picture into covers cache (Harmonoid embeds-at-index idea).
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

fn resolve_track_artwork(path: &Path, tagged: &TaggedFile, covers: &Path) -> Option<String> {
    if let Some(embedded) = extract_embedded_cover(path, tagged, covers) {
        return Some(embedded.to_string_lossy().into_owned());
    }
    folder_cover_fallback(path).map(|p| p.to_string_lossy().into_owned())
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
    let mut tracks = Vec::new();
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let covers = covers_dir(&app);
    let min_size = min_file_size(&conn);
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Library directory does not exist".into());
    }
    conn.execute(
        "INSERT OR IGNORE INTO library_directories (path) VALUES (?1)",
        [root.to_string_lossy().as_ref()],
    )
    .map_err(|e| e.to_string())?;

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && is_audio_ext(path) && meets_min_file_size(path, min_size) {
            if let Ok(mut track) = extract_metadata(path, &covers) {
                // Keep prior lyrics / cover if we already enriched this path
                let mut stmt = conn
                    .prepare("SELECT local_lyrics, artwork_url FROM tracks WHERE filepath = ?1")
                    .map_err(|e| e.to_string())?;
                if let Ok((lyrics, art)) = stmt.query_row(params![track.filepath], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                }) {
                    if track.local_lyrics.is_none() {
                        track.local_lyrics = lyrics;
                    }
                    if track.artwork_url.is_none() {
                        track.artwork_url = art;
                    }
                }

                upsert_track(&conn, &track).map_err(|e| e.to_string())?;
                tracks.push(track);
            }
        }
    }

    Ok(tracks)
}

fn format_label(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_uppercase())
        .filter(|s| !s.is_empty())
}

/// Harmonoid-style: sidecar `.lrc` next to the audio file.
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

fn extract_metadata(path: &Path, covers: &Path) -> Result<TrackData, String> {
    let probe_result = match Probe::open(path) {
        Ok(probe) => match probe.guess_file_type() {
            Ok(probe) => match probe.read() {
                Ok(res) => res,
                Err(e) => {
                    eprintln!("Library: Failed to read tags for {:?}: {}", path, e);
                    return Err(format!("Failed to read tagged file: {}", e));
                }
            },
            Err(e) => {
                eprintln!("Library: Failed to identify {:?}: {}", path, e);
                return Err(format!("Failed to identify audio file: {}", e));
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
    let format = format_label(path);
    let artwork_url = resolve_track_artwork(path, &probe_result, covers);
    // Lyrics cascade: sidecar LRC → embedded tags (online fetch stays on FE)
    let local_lyrics = sidecar_lyrics(path).or_else(|| tag_lyrics(tag));
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

    println!(
        "Library: {:?} => has_tag={}, title='{}', artist='{}', {}ms, {:?}kbps, art={}, lyrics={}",
        path.file_name().unwrap_or_default(),
        has_tag,
        title,
        artist,
        duration_ms,
        bitrate_kbps,
        artwork_url.as_deref().unwrap_or("-"),
        local_lyrics.is_some()
    );

    Ok(TrackData {
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
    })
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

#[tauri::command]
pub fn reindex_library(app: tauri::AppHandle) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let paths: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT filepath FROM tracks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        rows
    };
    let covers = covers_dir(&app);
    let min_size = min_file_size(&conn);
    let mut tracks = Vec::new();
    for filepath in paths {
        let path = Path::new(&filepath);
        if !path.is_file() || !meets_min_file_size(path, min_size) {
            conn.execute("DELETE FROM tracks WHERE filepath=?1", [&filepath])
                .map_err(|e| e.to_string())?;
            continue;
        }
        if let Ok(mut track) = extract_metadata(path, &covers) {
            let prior: Option<(Option<String>, Option<String>, i64)> = conn
                .query_row(
                    "SELECT local_lyrics, artwork_url, date_added FROM tracks WHERE filepath=?1",
                    [&filepath],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();
            if let Some((lyrics, artwork, date_added)) = prior {
                track.local_lyrics = track.local_lyrics.or(lyrics);
                track.artwork_url = track.artwork_url.or(artwork);
                track.date_added = date_added;
            }
            upsert_track(&conn, &track).map_err(|e| e.to_string())?;
            tracks.push(track);
        }
    }
    Ok(tracks)
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
    conn.execute(
        "INSERT INTO tracks (filepath, title, artist, album, album_artist, duration_ms, local_lyrics, artwork_url, format, bitrate_kbps, sample_rate_hz, channels, genre, track_number, disc_number, year, date_added, replaygain_track_gain, replaygain_track_peak, replaygain_album_gain, replaygain_album_peak)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
           replaygain_album_peak=COALESCE(excluded.replaygain_album_peak, tracks.replaygain_album_peak)",
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
        ],
    )?;
    Ok(())
}

/// Save fetched cover / lyrics for a library row (title+artist enrichment).
#[tauri::command]
pub fn update_library_enrichment(
    app: tauri::AppHandle,
    filepath: String,
    artwork_url: Option<String>,
    local_lyrics: Option<String>,
) -> Result<(), String> {
    if filepath.trim().is_empty() {
        return Err("empty filepath".into());
    }
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    if let Some(ref url) = artwork_url {
        if !url.trim().is_empty() {
            conn.execute(
                "UPDATE tracks SET artwork_url = ?1 WHERE filepath = ?2",
                params![url, filepath],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(ref lyrics) = local_lyrics {
        if !lyrics.trim().is_empty() {
            conn.execute(
                "UPDATE tracks SET local_lyrics = ?1 WHERE filepath = ?2",
                params![lyrics, filepath],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Import individual audio files (mobile file picker — no folder walk).
#[tauri::command]
pub async fn import_audio_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<TrackData>, String> {
    let conn = init_db(&app).map_err(|e| e.to_string())?;
    let covers = covers_dir(&app);
    let import_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("library_import");
    let _ = fs::create_dir_all(&import_dir);
    let mut tracks = Vec::new();
    let min_size = min_file_size(&conn);
    let mut seen_inputs = std::collections::HashSet::new();
    let mut seen_paths = std::collections::HashSet::new();
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
                    match crate::android_content::materialize_content_uri(&trimmed, &import_dir) {
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
            eprintln!("Library: skip missing file {:?}", path);
            continue;
        }
        if !is_audio_ext(&path) && !is_content_uri {
            continue;
        }
        if !meets_min_file_size(&path, min_size) {
            continue;
        }
        if !seen_paths.insert(path.clone()) {
            continue;
        }
        match extract_metadata(&path, &covers) {
            Ok(mut track) => {
                let mut stmt = conn
                    .prepare("SELECT local_lyrics, artwork_url FROM tracks WHERE filepath = ?1")
                    .map_err(|e| e.to_string())?;
                if let Ok((lyrics, art)) = stmt.query_row(params![track.filepath], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                }) {
                    if track.local_lyrics.is_none() {
                        track.local_lyrics = lyrics;
                    }
                    if track.artwork_url.is_none() {
                        track.artwork_url = art;
                    }
                }
                upsert_track(&conn, &track).map_err(|e| e.to_string())?;
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
    let covers = covers_dir(&app);
    let min_size = min_file_size(&conn);
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
            if !path.is_file() || !is_audio_ext(path) || !meets_min_file_size(path, min_size) {
                continue;
            }
            let key = path.to_string_lossy().to_string();
            if !seen.insert(key) {
                continue;
            }
            if let Ok(mut track) = extract_metadata(path, &covers) {
                let mut stmt = conn
                    .prepare("SELECT local_lyrics, artwork_url FROM tracks WHERE filepath = ?1")
                    .map_err(|e| e.to_string())?;
                if let Ok((lyrics, art)) = stmt.query_row(params![track.filepath], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                }) {
                    if track.local_lyrics.is_none() {
                        track.local_lyrics = lyrics;
                    }
                    if track.artwork_url.is_none() {
                        track.artwork_url = art;
                    }
                }
                upsert_track(&conn, &track).map_err(|e| e.to_string())?;
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
