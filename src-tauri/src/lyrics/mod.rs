//! Lyrics: LRCLib-first cascade + sidecar/tag (Harmonoid order).
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
    let Some(re) = re else { return lines };
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

fn lrclib_fetch(track: &TrackMeta) -> Option<LyricsOut> {
    let url = format!(
        "https://lrclib.net/api/get?artist_name={}&track_name={}&album_name={}&duration={}",
        urlencoding::encode(&track.artist),
        urlencoding::encode(&track.title),
        urlencoding::encode(track.album.as_deref().unwrap_or("")),
        track.duration_ms.unwrap_or(0) / 1000
    );
    let resp: serde_json::Value = reqwest::blocking::get(&url).ok()?.json().ok()?;
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
        return Some(LyricsOut {
            lines: vec![LyricLine {
                time_ms: 0,
                text: plain.to_string(),
            }],
            plain: Some(plain.to_string()),
        });
    }
    None
}

#[tauri::command]
pub fn lyrics_get(track: TrackMeta) -> Result<LyricsOut, String> {
    // 1) sidecar .lrc
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
    // 2) network LRCLib
    if let Some(out) = lrclib_fetch(&track) {
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
