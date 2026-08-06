//! Cover resolve — local tags/folder → SpotiFLAC extensions → iTunes.
use crate::playback::TrackMeta;
use crate::sidecar;
use base64::{engine::general_purpose::STANDARD, Engine};
use lofty::prelude::*;
use lofty::probe::Probe;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[tauri::command]
pub fn cover_resolve(
    app: tauri::AppHandle,
    track: TrackMeta,
) -> Result<String, String> {
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("covers");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    if let Some(url) = track.cover_url.as_deref() {
        if url.starts_with("data:image/") && !url.contains("image/svg") {
            return Ok(url.to_string());
        }
        if url.starts_with("http://") || url.starts_with("https://") {
            let url = upgrade_cover_url(url);
            if let Ok(path) = cache_remote(&cache, &track.id, &url) {
                return file_as_data_url(&path);
            }
            return Ok(url);
        }
        if Path::new(url).is_file() {
            let key = cover_cache_key(&track);
            if let Ok(dest) = copy_into_cache(&cache, &key, Path::new(url)) {
                return file_as_data_url(&dest);
            }
            return file_as_data_url(url);
        }
    }

    let key = cover_cache_key(&track);
    if let Some(existing) = find_cached(&cache, &key) {
        return file_as_data_url(&existing);
    }

    if let Some(path) = track.path.as_deref() {
        if let Some(saved) = extract_embedded(&cache, &key, Path::new(path)) {
            return file_as_data_url(&saved);
        }
        if let Some(parent) = Path::new(path).parent() {
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
                let c = parent.join(name);
                if c.is_file() {
                    let dest = copy_into_cache(&cache, &key, &c)?;
                    return file_as_data_url(&dest);
                }
            }
        }
    }

    // SpotiFLAC metadata extensions (spotify-web, amazon, apple-music, …)
    // — same source Mobile uses for covers when the file has no embedded art.
    if sidecar::available(Some(&app))
        && !track.title.is_empty()
        && !track.id.starts_with("yt:")
    {
        if let Ok(Some(url)) = sidecar::lookup_cover(
            &app,
            &track.artist,
            &track.title,
            track.album.as_deref(),
        ) {
            let url = upgrade_cover_url(&url);
            if let Ok(path) = cache_remote(&cache, &key, &url) {
                return file_as_data_url(&path);
            }
            return Ok(url);
        }
    }

    // iTunes last for local library misses
    if track.path.is_some() && !track.id.starts_with("yt:") {
        if let Some(path) = fetch_itunes_art(&cache, &key, &track) {
            return file_as_data_url(&path);
        }
    }

    Ok(String::new())
}

/// Bump common CDN thumbnails toward larger art (SpotiFLAC Mobile style).
fn upgrade_cover_url(url: &str) -> String {
    let mut u = url.to_string();
    // Spotify mosaic ids: 64→300→640
    u = u.replace("ab67616d00004851", "ab67616d0000b273");
    u = u.replace("ab67616d00001e02", "ab67616d0000b273");
    // iTunes
    u = u.replace("100x100bb", "600x600bb");
    u = u.replace("60x60bb", "600x600bb");
    // Deezer square sizes
    if u.contains("cdn-images.dzcdn.net") {
        if let Ok(re) = regex::Regex::new(r"/\d+x\d+-") {
            u = re.replace(&u, "/1900x1900-").into_owned();
        }
    }
    // Tidal
    if u.contains("resources.tidal.com") {
        if let Ok(re) = regex::Regex::new(r"/\d+x\d+\.jpg") {
            u = re.replace(&u, "/origin.jpg").into_owned();
        }
    }
    u
}

fn cover_cache_key(track: &TrackMeta) -> String {
    if !track.id.is_empty() {
        return sanitize_id(&track.id);
    }
    if let Some(p) = &track.path {
        return short_hash(p);
    }
    short_hash(&format!("{}|{}", track.artist, track.title))
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(80)
        .collect()
}

fn short_hash(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(&h.finalize()[..12])
}

fn find_cached(cache: &Path, key: &str) -> Option<PathBuf> {
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let p = cache.join(format!("{key}.{ext}"));
        if p.is_file() && p.metadata().map(|m| m.len() > 64).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

fn mime_ext(mime: &str) -> &'static str {
    if mime.contains("png") {
        "png"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "jpg"
    }
}

fn extract_embedded(cache: &Path, key: &str, audio: &Path) -> Option<PathBuf> {
    let tagged = Probe::open(audio).ok()?.read().ok()?;
    // Prefer primary tag, then any tag that has pictures
    let pic = tagged
        .primary_tag()
        .and_then(|t| t.pictures().first())
        .or_else(|| {
            tagged.tags().iter().find_map(|t| t.pictures().first())
        })?;
    let ext = mime_ext(pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg"));
    let out = cache.join(format!("{key}.{ext}"));
    if out.is_file() && out.metadata().map(|m| m.len() > 64).unwrap_or(false) {
        return Some(out);
    }
    std::fs::write(&out, pic.data()).ok()?;
    Some(out)
}

fn copy_into_cache(cache: &Path, key: &str, src: &Path) -> Result<PathBuf, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();
    let dest = cache.join(format!("{key}.{ext}"));
    if !dest.is_file() {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    }
    Ok(dest)
}

fn cache_remote(cache: &Path, id: &str, url: &str) -> Result<PathBuf, String> {
    let key = if id.is_empty() {
        short_hash(url)
    } else {
        sanitize_id(id)
    };
    if let Some(existing) = find_cached(cache, &key) {
        return Ok(existing);
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("NekoBeat/0.3")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("cover http {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() < 32 {
        return Err("cover too small".into());
    }
    let ext = mime_ext(&mime);
    let dest = cache.join(format!("{key}.{ext}"));
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest)
}

fn fetch_itunes_art(cache: &Path, key: &str, track: &TrackMeta) -> Option<PathBuf> {
    if track.title.is_empty() && track.artist.is_empty() {
        return None;
    }
    let album = track.album.as_deref().unwrap_or("");
    let term = if !album.is_empty() {
        format!("{} {}", track.artist, album)
    } else {
        format!("{} {}", track.artist, track.title)
    }
    .trim()
    .chars()
    .take(80)
    .collect::<String>();
    if term.len() < 2 {
        return None;
    }
    let entity = if !album.is_empty() { "album" } else { "song" };
    let url = format!(
        "https://itunes.apple.com/search?term={}&entity={entity}&limit=1",
        urlencoding::encode(&term)
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("NekoBeat/0.3")
        .build()
        .ok()?;
    let body: serde_json::Value = client.get(&url).send().ok()?.json().ok()?;
    let art = body
        .pointer("/results/0/artworkUrl100")
        .and_then(|v| v.as_str())?;
    let hi = art.replace("100x100bb", "600x600bb");
    cache_remote(cache, key, &hi).ok()
}

fn file_as_data_url(path: impl AsRef<Path>) -> Result<String, String> {
    let path = path.as_ref();
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    ))
}
