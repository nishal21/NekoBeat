//! Spotube-inspired stream search + resolve.
//! Play uses the **direct** yt-dlp URL (or a local cache file) — never buffer the
//! entire stream through a sync proxy (that froze the Windows UI).
use crate::playback::TrackMeta;
use crate::ytdlp;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

#[derive(Default)]
pub struct StreamState {
    pub matches: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOut {
    /// Playable URI: https CDN URL or file:// cache path
    pub proxy_url: String,
    pub track: TrackMeta,
}

fn parse_search_lines(text: &str) -> Vec<TrackMeta> {
    let mut out = Vec::new();
    for line in text.lines() {
        let parts: Vec<_> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let id = parts[0].trim();
        if id.is_empty() || id == "NA" {
            continue;
        }
        let dur: Option<u64> = parts
            .get(4)
            .and_then(|s| s.parse::<f64>().ok())
            .map(|s| (s * 1000.0) as u64);
        let thumb = parts
            .get(3)
            .map(|s| s.trim().to_string())
            .filter(|s| s.starts_with("http"));
        out.push(TrackMeta {
            id: format!("yt:{id}"),
            title: parts[1].to_string(),
            artist: parts[2].to_string(),
            album: None,
            duration_ms: dur,
            cover_url: thumb,
            isrc: None,
            spotify_id: None,
            source: Some("stream".into()),
            path: None,
            stream_url: None,
            quality_label: Some("stream".into()),
        });
    }
    out
}

#[tauri::command]
pub fn stream_search(app: AppHandle, query: String) -> Result<Vec<TrackMeta>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }

    if crate::sidecar::available(Some(&app)) {
        // Fast path: spotify-web first (SpotiFLAC Mobile style), then all providers
        for prov in ["spotify-web", "amazon", "apple-music", "deezer"] {
            if let Ok(data) = crate::sidecar::search_provider(&app, prov, q, 16) {
                let rows = crate::hifi::ext_tracks_public(&data, "stream");
                if !rows.is_empty() {
                    return Ok(rows);
                }
            }
        }
        if let Ok(data) = crate::sidecar::search(&app, q, 16) {
            let rows = crate::hifi::ext_tracks_public(&data, "stream");
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
    }

    if q.contains("spotify.com/") || q.starts_with("spotify:") {
        if let Ok(resolved) = crate::zarz_api::resolve_url("https://api.zarz.moe", q) {
            let yt = resolved
                .song_urls
                .get("YouTubeMusic")
                .or_else(|| resolved.song_urls.get("YouTube"))
                .cloned();
            if let Some(yt_url) = yt {
                let meta = yt_meta_from_url(&app, &yt_url, &resolved)?;
                return Ok(vec![meta]);
            }
        }
    }

    let output = ytdlp::run_timeout(
        Some(&app),
        &[
            &format!("ytsearch8:{q}"),
            "--flat-playlist",
            "--no-warnings",
            "--print",
            "%(id)s\t%(title)s\t%(uploader)s\t%(thumbnail)s\t%(duration)s",
        ],
        45,
    )?;

    if !output.status.success() {
        return Err(format!(
            "yt-dlp search failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(240)
                .collect::<String>()
        ));
    }
    let rows = parse_search_lines(&String::from_utf8_lossy(&output.stdout));
    if rows.is_empty() {
        return Err("No search results".into());
    }
    Ok(rows)
}

fn yt_meta_from_url(
    app: &AppHandle,
    yt_url: &str,
    resolved: &crate::zarz_api::ResolvedLinks,
) -> Result<TrackMeta, String> {
    let output = ytdlp::run_timeout(
        Some(app),
        &[
            yt_url,
            "--flat-playlist",
            "--no-warnings",
            "--print",
            "%(id)s\t%(title)s\t%(uploader)s\t%(thumbnail)s\t%(duration)s",
        ],
        30,
    )?;
    let text = String::from_utf8_lossy(&output.stdout);
    if let Some(mut row) = parse_search_lines(&text).into_iter().next() {
        row.isrc = resolved.isrc.clone();
        row.spotify_id = resolved.spotify_id.clone();
        row.source = Some("stream".into());
        return Ok(row);
    }
    let id = yt_url
        .split("v=")
        .nth(1)
        .or_else(|| yt_url.split('/').last())
        .unwrap_or("unknown")
        .split('&')
        .next()
        .unwrap_or("unknown");
    Ok(TrackMeta {
        id: format!("yt:{id}"),
        title: "Resolved track".into(),
        artist: "YouTube".into(),
        album: None,
        duration_ms: None,
        cover_url: None,
        isrc: resolved.isrc.clone(),
        spotify_id: resolved.spotify_id.clone(),
        source: Some("stream".into()),
        path: None,
        stream_url: Some(yt_url.to_string()),
        quality_label: Some("stream".into()),
    })
}

/// Resolve a playable local audio file for rodio (MP3/M4A/WAV/FLAC only).
#[tauri::command]
pub fn stream_resolve(
    app: AppHandle,
    state: tauri::State<'_, StreamState>,
    track: TrackMeta,
) -> Result<ResolveOut, String> {
    resolve_stream_inner(&app, &state, track)
}

/// Delete bad cache for a track so the next resolve re-downloads.
#[tauri::command]
pub fn stream_invalidate(
    app: AppHandle,
    state: tauri::State<'_, StreamState>,
    track_id: String,
) -> Result<(), String> {
    use tauri::Manager;
    state.matches.lock().remove(&track_id);
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("stream-cache");
    let safe = sanitize_id(&track_id);
    if let Ok(rd) = std::fs::read_dir(&cache_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&safe))
            {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    Ok(())
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(64)
        .collect()
}

/// True if bytes look like a rodio-safe container (not WebM/Matroska).
fn is_rodio_safe(path: &std::path::Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut buf = [0u8; 16];
    let Ok(n) = f.read(&mut buf) else {
        return false;
    };
    if n < 4 {
        return false;
    }
    let meta_ok = path
        .metadata()
        .map(|m| m.len() >= 8_000)
        .unwrap_or(false);
    if !meta_ok {
        return false;
    }
    // EBML = WebM/MKV — rodio/symphonia panics on Windows
    if buf.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return false;
    }
    if buf.starts_with(b"ID3") {
        return true;
    }
    // MPEG frame sync
    if buf[0] == 0xFF && (buf[1] & 0xE0) == 0xE0 {
        return true;
    }
    if n >= 8 && &buf[4..8] == b"ftyp" {
        return true;
    }
    if buf.starts_with(b"RIFF") || buf.starts_with(b"fLaC") {
        return true;
    }
    // Ogg/Opus often trips the same seek panic — skip
    if buf.starts_with(b"OggS") {
        return false;
    }
    false
}

fn resolve_stream_inner(
    app: &AppHandle,
    state: &StreamState,
    track: TrackMeta,
) -> Result<ResolveOut, String> {
    use tauri::Manager;

    let watch = if let Some(u) = track.stream_url.as_deref().filter(|u| u.starts_with("http")) {
        u.to_string()
    } else if let Some(id) = track.id.strip_prefix("yt:") {
        format!("https://www.youtube.com/watch?v={id}")
    } else {
        format!("ytsearch1:{} {}", track.artist, track.title)
    };

    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("stream-cache");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let safe = sanitize_id(&track.id);
    let mp3_out = cache_dir.join(format!("{safe}.mp3"));

    // Instant: local MP3 cache
    if mp3_out.is_file() && is_rodio_safe(&mp3_out) {
        return finish_resolve(state, track, mp3_out);
    }
    if let Some(existing) = find_cached_audio(&cache_dir, &safe) {
        let ext = existing
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "mp3" && is_rodio_safe(&existing) {
            return finish_resolve(state, track, existing);
        }
    }

    // Fast path: direct CDN URL (~1s) — rodio/mpv play via ffmpeg/http immediately.
    // Background thread still builds an MP3 cache for the next play / seek.
    if ytdlp::find_ffmpeg(Some(app)).is_some() {
        match ytdlp::get_direct_url(Some(app), &watch) {
            Ok(url) => {
                spawn_background_mp3_cache(app.clone(), watch.clone(), mp3_out.clone());
                let mut track = track;
                track.stream_url = Some(url.clone());
                track.quality_label = Some(
                    track
                        .quality_label
                        .unwrap_or_else(|| "stream".into()),
                );
                state.matches.lock().insert(track.id.clone(), url.clone());
                return Ok(ResolveOut {
                    proxy_url: url,
                    track,
                });
            }
            Err(e) => {
                eprintln!("[nekobeat] fast stream URL failed: {e} — falling back to download");
            }
        }
    }

    // Slow fallback: full download + remux (no ffmpeg / -g failed)
    resolve_stream_download(app, state, track, &watch, &cache_dir, &safe, &mp3_out)
}

fn spawn_background_mp3_cache(app: AppHandle, watch: String, mp3_out: std::path::PathBuf) {
    std::thread::spawn(move || {
        if mp3_out.is_file() {
            return;
        }
        let tmp = mp3_out.with_extension("mp3.part");
        let tmp_s = tmp.to_string_lossy().to_string();
        let _ = ytdlp::run_timeout(
            Some(&app),
            &[
                "-f",
                "bestaudio/best",
                "-x",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "5",
                "--no-playlist",
                "--no-warnings",
                "-o",
                &tmp_s,
                "--",
                &watch,
            ],
            240,
        );
        if tmp.is_file() && is_rodio_safe(&tmp) {
            let _ = std::fs::rename(&tmp, &mp3_out);
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    });
}

fn resolve_stream_download(
    app: &AppHandle,
    state: &StreamState,
    track: TrackMeta,
    watch: &str,
    cache_dir: &std::path::Path,
    safe: &str,
    mp3_out: &std::path::Path,
) -> Result<ResolveOut, String> {
    let has_ffmpeg = ytdlp::find_ffmpeg(Some(app)).is_some();
    let mp3_s = mp3_out.to_string_lossy().to_string();
    if has_ffmpeg {
        let _ = ytdlp::run_timeout(
            Some(app),
            &[
                "-f",
                "bestaudio/best",
                "-x",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "5",
                "--no-playlist",
                "--no-warnings",
                "-o",
                &mp3_s,
                "--",
                watch,
            ],
            180,
        );
        if mp3_out.is_file() && is_rodio_safe(mp3_out) {
            return finish_resolve(state, track, mp3_out.to_path_buf());
        }
        let _ = std::fs::remove_file(mp3_out);
    }

    let out_tmpl = cache_dir.join(format!("{safe}.%(ext)s"));
    let out_s = out_tmpl.to_string_lossy().to_string();
    let output = ytdlp::run_timeout(
        Some(app),
        &[
            "-f",
            "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
            "--no-playlist",
            "--no-warnings",
            "-o",
            &out_s,
            "--",
            watch,
        ],
        120,
    );

    match output {
        Ok(out) if out.status.success() => {
            let raw = find_any_downloaded(cache_dir, safe).ok_or_else(|| {
                "yt-dlp finished but no audio file was written".to_string()
            })?;
            let ext = raw
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "mp3" && is_rodio_safe(&raw) {
                return finish_resolve(state, track, raw);
            }
            if has_ffmpeg {
                ytdlp::remux_to_mp3(Some(app), &raw, mp3_out)?;
                let _ = std::fs::remove_file(&raw);
                if is_rodio_safe(mp3_out) {
                    return finish_resolve(state, track, mp3_out.to_path_buf());
                }
            }
            let _ = std::fs::remove_file(&raw);
            Err(
                "No playable MP3. Install ffmpeg.exe into src-tauri/bin (next to yt-dlp.exe) and play again."
                    .into(),
            )
        }
        Ok(out) => Err(format!(
            "Could not resolve stream: {}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(240)
                .collect::<String>()
        )),
        Err(e) => Err(e),
    }
}

fn finish_resolve(
    state: &StreamState,
    mut track: TrackMeta,
    path: std::path::PathBuf,
) -> Result<ResolveOut, String> {
    if !is_rodio_safe(&path) {
        let _ = std::fs::remove_file(&path);
        return Err("Downloaded audio is not playable. Need MP3 — install ffmpeg.".into());
    }
    let path_s = path.to_string_lossy().into_owned();
    state.matches.lock().insert(track.id.clone(), path_s.clone());
    track.stream_url = Some(path_s.clone());
    track.path = Some(path_s.clone());
    Ok(ResolveOut {
        proxy_url: path_s,
        track,
    })
}

fn find_any_downloaded(dir: &std::path::Path, safe_id: &str) -> Option<std::path::PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::path::PathBuf, u64)> = None;
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name()?.to_string_lossy();
        if !name.starts_with(safe_id) {
            continue;
        }
        if name.contains(".part") || name.ends_with(".ytdl") {
            continue;
        }
        let len = e.metadata().ok()?.len();
        if len < 8_000 {
            continue;
        }
        let take = match &best {
            None => true,
            Some((_, bl)) => len > *bl,
        };
        if take {
            best = Some((p, len));
        }
    }
    best.map(|(p, _)| p)
}

fn find_cached_audio(dir: &std::path::Path, safe_id: &str) -> Option<std::path::PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(std::path::PathBuf, i32, std::time::SystemTime)> = None;
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name()?.to_string_lossy();
        if !name.starts_with(safe_id) {
            continue;
        }
        if name.contains(".part") || name.ends_with(".ytdl") {
            continue;
        }
        let ext = p.extension()?.to_string_lossy().to_ascii_lowercase();
        // Keep m4a in listing so we can remux; rank mp3 highest
        let rank = match ext.as_str() {
            "mp3" => 100,
            "wav" => 90,
            "flac" => 85,
            "m4a" | "aac" | "mp4" => 40,
            "webm" | "opus" | "ogg" => 10,
            _ => continue,
        };
        if rank >= 85 && !is_rodio_safe(&p) {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        let modified = e.metadata().ok()?.modified().ok()?;
        let take = match &best {
            None => true,
            Some((_, br, bt)) => rank > *br || (rank == *br && modified > *bt),
        };
        if take {
            best = Some((p, rank, modified));
        }
    }
    best.map(|(p, _, _)| p)
}
