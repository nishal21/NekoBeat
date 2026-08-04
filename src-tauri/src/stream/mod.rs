//! Spotube-inspired stream search + resolve + local proxy.
use crate::playback::TrackMeta;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::thread;

#[derive(Default)]
pub struct StreamState {
    pub matches: Mutex<HashMap<String, String>>,
    pub proxy_port: Mutex<Option<u16>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOut {
    pub proxy_url: String,
    pub track: TrackMeta,
}

static PROXY_MAP: once_cell::sync::Lazy<Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

pub fn start_proxy(state: &StreamState) -> Result<u16, String> {
    if let Some(p) = *state.proxy_port.lock() {
        return Ok(p);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    *state.proxy_port.lock() = Some(port);

    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let _ = handle_proxy(stream);
            });
        }
    });
    Ok(port)
}

fn handle_proxy(mut stream: TcpStream) -> Result<(), String> {
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/");
    let id = path.trim_start_matches("/stream/");
    let url = PROXY_MAP
        .lock()
        .get(id)
        .cloned()
        .ok_or_else(|| "unknown stream".to_string())?;

    let resp = reqwest::blocking::get(&url).map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    let header = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: audio/mpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn stream_search(query: String) -> Result<Vec<TrackMeta>, String> {
    if let Ok(output) = Command::new("yt-dlp")
        .args([
            format!("ytsearch5:{query}"),
            "--flat-playlist".into(),
            "--print".into(),
            "%(id)s\t%(title)s\t%(uploader)s\t%(thumbnail)s\t%(duration)s".into(),
        ])
        .output()
    {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut out = Vec::new();
            for line in text.lines() {
                let parts: Vec<_> = line.split('\t').collect();
                if parts.len() < 3 {
                    continue;
                }
                let dur: Option<u64> = parts
                    .get(4)
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(|s| (s * 1000.0) as u64);
                out.push(TrackMeta {
                    id: format!("yt:{}", parts[0]),
                    title: parts[1].to_string(),
                    artist: parts[2].to_string(),
                    album: None,
                    duration_ms: dur,
                    cover_url: parts.get(3).map(|s| s.to_string()),
                    isrc: None,
                    spotify_id: None,
                    source: Some("stream".into()),
                    path: None,
                    stream_url: Some(format!("ytsearch:{}", parts[0])),
                    quality_label: Some("stream".into()),
                });
            }
            if !out.is_empty() {
                return Ok(out);
            }
        }
    }

    Ok(vec![TrackMeta {
        id: format!("demo:{}", query),
        title: query.clone(),
        artist: "Search".into(),
        album: Some("Install yt-dlp for live results".into()),
        duration_ms: None,
        cover_url: None,
        isrc: None,
        spotify_id: None,
        source: Some("stream".into()),
        path: None,
        stream_url: None,
        quality_label: Some("demo".into()),
    }])
}

#[tauri::command]
pub fn stream_resolve(
    state: tauri::State<'_, StreamState>,
    track: TrackMeta,
) -> Result<ResolveOut, String> {
    let port = start_proxy(&state)?;
    let video_id = track
        .id
        .strip_prefix("yt:")
        .unwrap_or(track.id.as_str())
        .to_string();

    let url = if let Ok(output) = Command::new("yt-dlp")
        .args([
            "-f",
            "bestaudio",
            "-g",
            &format!("https://www.youtube.com/watch?v={video_id}"),
        ])
        .output()
    {
        if output.status.success() {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    if url.is_empty() {
        return Err("Could not resolve stream (need yt-dlp)".into());
    }

    PROXY_MAP.lock().insert(track.id.clone(), url.clone());
    state.matches.lock().insert(track.id.clone(), url);

    let mut track = track;
    let proxy_url = format!("http://127.0.0.1:{port}/stream/{}", track.id);
    track.stream_url = Some(proxy_url.clone());
    Ok(ResolveOut { proxy_url, track })
}
