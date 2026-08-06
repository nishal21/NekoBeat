//! Lyrics: sidecar .lrc → LRCLib get → LRCLib search (Harmonoid-style cascade).
use crate::playback::TrackMeta;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub time_ms: u64,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LyricsOut {
    pub lines: Vec<LyricLine>,
    pub plain: Option<String>,
}

fn parse_lrc(text: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();
    let re = regex::Regex::new(r"\[(\d+):(\d+)(?:\.(\d+))?\](.*)").ok();
    let Some(re) = re else {
        return lines;
    };
    for raw in text.lines() {
        if let Some(c) = re.captures(raw) {
            let m: u64 = c[1].parse().unwrap_or(0);
            let s: u64 = c[2].parse().unwrap_or(0);
            let frac = c.get(3).map(|m| m.as_str()).unwrap_or("0");
            let ms_part: u64 = if frac.len() == 2 {
                frac.parse::<u64>().unwrap_or(0) * 10
            } else {
                frac.parse().unwrap_or(0)
            };
            let time_ms = m * 60_000 + s * 1000 + ms_part;
            let text = c[4].trim().to_string();
            if !text.is_empty() {
                lines.push(LyricLine { time_ms, text });
            }
        }
    }
    lines
}

fn plain_to_lines(plain: &str) -> Vec<LyricLine> {
    let parts: Vec<&str> = plain
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return vec![];
    }
    // Untimed lines (UI treats all-zero as plain text, not synced)
    parts
        .into_iter()
        .map(|text| LyricLine {
            time_ms: 0,
            text: text.to_string(),
        })
        .collect()
}

fn from_lrclib_json(resp: &serde_json::Value) -> Option<LyricsOut> {
    if let Some(synced) = resp.get("syncedLyrics").and_then(|v| v.as_str()) {
        let lines = parse_lrc(synced);
        if !lines.is_empty() {
            return Some(LyricsOut {
                lines,
                plain: resp
                    .get("plainLyrics")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }
    }
    if let Some(plain) = resp.get("plainLyrics").and_then(|v| v.as_str()) {
        let lines = plain_to_lines(plain);
        if !lines.is_empty() {
            return Some(LyricsOut {
                lines,
                plain: Some(plain.to_string()),
            });
        }
    }
    None
}

fn lrclib_get(track: &TrackMeta) -> Option<LyricsOut> {
    let url = format!(
        "https://lrclib.net/api/get?artist_name={}&track_name={}&album_name={}&duration={}",
        urlencoding::encode(&track.artist),
        urlencoding::encode(&track.title),
        urlencoding::encode(track.album.as_deref().unwrap_or("")),
        track.duration_ms.unwrap_or(0) / 1000
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("NekoBeat/0.3 (lyrics)")
        .build()
        .ok()?;
    let resp: serde_json::Value = client.get(&url).send().ok()?.json().ok()?;
    from_lrclib_json(&resp)
}

fn lrclib_search(track: &TrackMeta) -> Option<LyricsOut> {
    let url = format!(
        "https://lrclib.net/api/search?artist_name={}&track_name={}",
        urlencoding::encode(&track.artist),
        urlencoding::encode(&track.title)
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("NekoBeat/0.3 (lyrics)")
        .build()
        .ok()?;
    let arr: Vec<serde_json::Value> = client.get(&url).send().ok()?.json().ok()?;
    for item in arr.iter().take(5) {
        if let Some(out) = from_lrclib_json(item) {
            return Some(out);
        }
        // Search hits often only have id — fetch by id
        if let Some(id) = item.get("id").and_then(|v| v.as_i64()) {
            let get_url = format!("https://lrclib.net/api/get?id={id}");
            if let Ok(resp) = client.get(&get_url).send() {
                if let Ok(v) = resp.json::<serde_json::Value>() {
                    if let Some(out) = from_lrclib_json(&v) {
                        return Some(out);
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn lyrics_get(track: TrackMeta) -> Result<LyricsOut, String> {
    // 1) sidecar .lrc next to file
    if let Some(path) = &track.path {
        let lrc = Path::new(path).with_extension("lrc");
        if let Ok(text) = std::fs::read_to_string(&lrc) {
            let lines = parse_lrc(&text);
            if !lines.is_empty() {
                return Ok(LyricsOut {
                    lines,
                    plain: None,
                });
            }
        }
    }
    // 2) exact LRCLib get
    if let Some(out) = lrclib_get(&track) {
        return Ok(out);
    }
    // 3) fuzzy search (streaming tracks often miss duration/album)
    if let Some(out) = lrclib_search(&track) {
        return Ok(out);
    }
    Ok(LyricsOut {
        lines: vec![],
        plain: None,
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn lyrics_notif_show(title: String, artist: String, line: String) -> Result<(), String> {
    crate::lyrics_notification::show_lyrics_line(&title, &artist, &line)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn lyrics_notif_show(_title: String, _artist: String, _line: String) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub fn lyrics_notif_hide() -> Result<(), String> {
    crate::lyrics_notification::clear_lyrics_notification()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn lyrics_notif_hide() -> Result<(), String> {
    Ok(())
}
