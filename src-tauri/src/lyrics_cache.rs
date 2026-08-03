//! Local lyrics disk cache: `app_data/Lyrics/<sha256(key)>.lrc`
//!
//! Plain files on disk so lyrics still open offline.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// True when the text has timed `[mm:ss.xx]` LRC lines.
pub fn looks_synced(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // At least one LRC timestamp like [00:12.34] or [0:12.3] or [01:02]
    lazy_static::lazy_static! {
        static ref LRC_TS: regex::Regex =
            regex::Regex::new(r"\[\d{1,2}:\d{2}([.:]\d{1,3})?\]").unwrap();
    }
    LRC_TS.is_match(t)
}

fn lyrics_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("Lyrics");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.trim().as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn cache_file(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("empty lyrics cache key".into());
    }
    Ok(lyrics_dir(app)?.join(format!("{}.lrc", hash_key(k))))
}

/// Read cached LRC/plain lyrics for a stable key (filepath, track id, or stream URL).
pub fn read_cached(app: &AppHandle, key: &str) -> Option<String> {
    let path = cache_file(app, key).ok()?;
    let text = fs::read_to_string(path).ok()?;
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    Some(text)
}

/// Persist lyrics in the app Lyrics folder (not the user's music folder).
pub fn write_cached(app: &AppHandle, key: &str, lyrics: &str) -> Result<(), String> {
    let text = lyrics.trim();
    if text.is_empty() {
        return Err("empty lyrics".into());
    }
    let path = cache_file(app, key)?;
    // Atomic replace avoids a truncated cache entry if the app is killed mid-write.
    let temp = path.with_extension("lrc.tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    println!("Lyrics cache: wrote {}", path.display());
    Ok(())
}

/// Sidecar `Song.lrc` / `Song.LRC` beside an audio file.
pub fn read_sidecar(filepath: &str) -> Option<String> {
    let path = Path::new(filepath);
    if !path.is_file() {
        return None;
    }
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

#[tauri::command]
pub fn save_lyrics_cache(app: AppHandle, cache_key: String, lyrics: String) -> Result<(), String> {
    write_cached(&app, &cache_key, &lyrics)
}

#[tauri::command]
pub fn read_lyrics_cache(app: AppHandle, cache_key: String) -> Result<Option<String>, String> {
    Ok(read_cached(&app, &cache_key))
}
