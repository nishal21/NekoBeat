//! SpotiFLAC-inspired HiFi — extension download + progress + metadata embed.
use crate::playback::TrackMeta;
use crate::sidecar;
use crate::ytdlp;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub track: TrackMeta,
    pub status: String,
    /// 0.0 … 1.0
    pub progress: f32,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub measured_format: Option<String>,
    pub requested_quality: Option<String>,
    pub bit_depth: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub service: Option<String>,
    pub needs_login: Option<bool>,
    /// queued | preparing | downloading | embedding | done | error
    pub stage: Option<String>,
    pub stage_label: Option<String>,
    pub bytes_received: Option<u64>,
    pub bytes_total: Option<u64>,
    pub speed_mbps: Option<f32>,
    pub metadata_embedded: Option<bool>,
    /// True when the finished file was upserted into the Library DB.
    pub library_added: Option<bool>,
}

#[derive(Default)]
pub struct HifiState {
    pub jobs: Mutex<Vec<DownloadJob>>,
}

pub fn ext_tracks_public(data: &Value, quality: &str) -> Vec<TrackMeta> {
    ext_tracks_to_meta(data, quality)
}

fn ext_tracks_to_meta(data: &Value, quality: &str) -> Vec<TrackMeta> {
    let arr = if let Some(a) = data.as_array() {
        a.clone()
    } else if let Some(a) = data.get("tracks").and_then(|t| t.as_array()) {
        a.clone()
    } else {
        Vec::new()
    };
    arr.into_iter()
        .filter_map(|t| {
            let id = t
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())?
                .to_string();
            let title = t
                .get("name")
                .or_else(|| t.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let artist = t
                .get("artists")
                .or_else(|| t.get("artist"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let album = t
                .get("album_name")
                .or_else(|| t.get("album"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let cover = t
                .get("cover_url")
                .or_else(|| t.get("images"))
                .and_then(|v| {
                    if let Some(s) = v.as_str() {
                        Some(s.to_string())
                    } else if let Some(arr) = v.as_array() {
                        arr.iter()
                            .find_map(|x| x.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .filter(|s| s.starts_with("http"))
                .map(|s| {
                    s.replace("ab67616d00004851", "ab67616d0000b273")
                        .replace("ab67616d00001e02", "ab67616d0000b273")
                });
            let duration_ms = t.get("duration_ms").and_then(|v| v.as_u64());
            let provider = t
                .get("provider_id")
                .and_then(|v| v.as_str())
                .unwrap_or("extension")
                .to_string();
            Some(TrackMeta {
                id: format!("{provider}:{id}"),
                title,
                artist,
                album,
                duration_ms,
                cover_url: cover,
                isrc: t
                    .get("isrc")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                spotify_id: t
                    .get("spotify_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                source: Some(if quality == "stream" {
                    "stream".into()
                } else {
                    "hifi".into()
                }),
                path: None,
                stream_url: t
                    .get("external_urls")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                quality_label: Some(quality.to_string()),
            })
        })
        .collect()
}

fn patch_job(app: &AppHandle, state: &HifiState, id: &str, f: impl FnOnce(&mut DownloadJob)) {
    let snapshot = {
        let mut jobs = state.jobs.lock();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            f(j);
            Some(j.clone())
        } else {
            None
        }
    };
    if let Some(job) = snapshot {
        let _ = app.emit("hifi-job-update", job);
    }
}

fn format_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let v = n as f64;
    if v >= MB {
        format!("{:.1} MB", v / MB)
    } else if v >= KB {
        format!("{:.0} KB", v / KB)
    } else {
        format!("{n} B")
    }
}

/// Watch output dir for growing audio files while a blocking download runs.
fn spawn_dir_watcher(
    app: AppHandle,
    state: Arc<HifiState>,
    id: String,
    dir: PathBuf,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut last_size = 0u64;
        let mut last_tick = std::time::Instant::now();
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(400));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let size = dir_audio_bytes(&dir);
            if size == 0 {
                continue;
            }
            let elapsed = last_tick.elapsed().as_secs_f32().max(0.2);
            let delta = size.saturating_sub(last_size);
            let speed = (delta as f32 / elapsed) / (1024.0 * 1024.0);
            // Indeterminate total — map growing file to 15%…88%
            let pct = (0.15 + (size as f32 / (size as f32 + 8_000_000.0)) * 0.73).min(0.88);
            patch_job(&app, &state, &id, |j| {
                j.status = "running".into();
                j.stage = Some("downloading".into());
                j.stage_label = Some(format!("Downloading · {}", format_bytes(size)));
                j.bytes_received = Some(size);
                j.progress = pct;
                if speed > 0.01 {
                    j.speed_mbps = Some(speed);
                }
            });
            last_size = size;
            last_tick = std::time::Instant::now();
        }
    });
}

fn dir_audio_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    matches!(
                        e.to_ascii_lowercase().as_str(),
                        "flac" | "m4a" | "mp3" | "part" | "ytdl"
                    )
                })
                .unwrap_or(false)
        })
        .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
        .sum()
}

/// Embed title/artist/album/cover into the downloaded file (FLAC/MP3/M4A).
fn embed_track_metadata(path: &Path, track: &TrackMeta) -> bool {
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::tag::Tag;

    let Ok(mut tagged) = lofty::read_from_path(path) else {
        return false;
    };
    let tag = if let Some(t) = tagged.primary_tag_mut() {
        t
    } else {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
        match tagged.primary_tag_mut() {
            Some(t) => t,
            None => return false,
        }
    };

    if !track.title.is_empty() {
        tag.set_title(track.title.clone());
    }
    if !track.artist.is_empty() {
        tag.set_artist(track.artist.clone());
    }
    if let Some(album) = &track.album {
        if !album.is_empty() {
            tag.set_album(album.clone());
        }
    }
    if let Some(isrc) = &track.isrc {
        tag.insert_text(ItemKey::Isrc, isrc.clone());
    }

    if let Some(url) = track.cover_url.as_deref().filter(|u| u.starts_with("http")) {
        if let Some(bytes) = fetch_cover_bytes(url) {
            let mime = if url.contains(".png") {
                MimeType::Png
            } else {
                MimeType::Jpeg
            };
            let pic = Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes);
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(pic);
        }
    }

    use lofty::config::WriteOptions;
    tagged
        .save_to_path(path, WriteOptions::default())
        .is_ok()
}
fn fetch_cover_bytes(url: &str) -> Option<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("NekoBeat/0.3")
        .build()
        .ok()?;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().ok()?;
    if bytes.len() < 64 {
        return None;
    }
    Some(bytes.to_vec())
}

fn finish_ok(
    app: &AppHandle,
    state: &HifiState,
    id: &str,
    track: &TrackMeta,
    path: PathBuf,
    bit: Option<u32>,
    rate: Option<u32>,
    label: String,
    service: String,
    embed: bool,
) {
    patch_job(app, state, id, |j| {
        j.stage = Some("embedding".into());
        j.stage_label = Some("Embedding metadata & cover…".into());
        j.progress = 0.92;
        j.file_path = Some(path.to_string_lossy().into_owned());
        j.service = Some(service.clone());
    });

    let embedded = if embed {
        embed_track_metadata(&path, track)
    } else {
        false
    };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let library_added = crate::library::import_downloaded(app, &path).is_ok();
    let path_display = path.to_string_lossy().into_owned();

    patch_job(app, state, id, |j| {
        j.file_path = Some(path_display.clone());
        j.bit_depth = bit;
        j.sample_rate_hz = rate;
        j.measured_format = Some(label);
        j.service = Some(service);
        j.progress = 1.0;
        j.status = "done".into();
        j.stage = Some("done".into());
        j.stage_label = Some({
            let mut s = if embedded {
                format!("Done · {} · metadata embedded", format_bytes(size))
            } else if embed {
                format!("Done · {} · metadata embed skipped", format_bytes(size))
            } else {
                format!("Done · {}", format_bytes(size))
            };
            if library_added {
                s.push_str(" · added to Library");
            }
            s
        });
        j.bytes_received = Some(size);
        j.bytes_total = Some(size);
        j.metadata_embedded = Some(embedded);
        j.library_added = Some(library_added);
        j.error = None;
        j.needs_login = Some(false);
    });
}

/// Resolve HiFi download folder (custom setting or app data /hifi).
pub fn resolved_download_dir(
    app: &AppHandle,
    cfg: &crate::settings::AppSettings,
) -> Result<PathBuf, String> {
    let custom = cfg.download_dir.trim();
    let dir = if custom.is_empty() {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("hifi")
    } else {
        PathBuf::from(custom)
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("download folder: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn hifi_download_dir(
    app: AppHandle,
    settings: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
) -> Result<String, String> {
    let cfg = settings.lock().clone();
    Ok(resolved_download_dir(&app, &cfg)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub fn hifi_search(
    app: tauri::AppHandle,
    settings: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
    query: String,
) -> Result<Vec<TrackMeta>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let (base, region, quality, meta_priority, dl_priority) = {
        let s = settings.lock();
        (
            s.zarz_api_base.clone(),
            s.songlink_region.clone(),
            s.hifi_quality.clone(),
            s.metadata_provider_priority.clone(),
            s.download_provider_priority.clone(),
        )
    };

    if !sidecar::available(Some(&app)) {
        return Err(
            "spotiflac-cli missing — build scripts/build-spotiflac-cli.ps1 (SpotiFLAC Mobile runtime)"
                .into(),
        );
    }

    let _ = sidecar::ensure_runtime(&app)?;
    let meta = if meta_priority.is_empty() {
        vec![
            "spotify-web".into(),
            "amazon".into(),
            "apple-music".into(),
            "deezer".into(),
            "ytmusic-spotiflac".into(),
        ]
    } else {
        meta_priority
    };
    let dl = if dl_priority.is_empty() {
        vec![
            "tidal-web".into(),
            "amazon".into(),
            "qobuz-web".into(),
            "deezer".into(),
        ]
    } else {
        dl_priority
    };
    // Don't block search on priority writes — fire-and-forget style
    let _ = sidecar::set_priority(&app, &dl, &meta);

    if q.contains("spotify.com/") || q.starts_with("spotify:") {
        if let Ok(handled) = sidecar::call(Some(&app), "handle-url", json!({ "url": q })) {
            let rows = ext_tracks_to_meta(&handled, &quality);
            if !rows.is_empty() {
                return Ok(rows);
            }
            if handled.get("id").is_some() || handled.get("name").is_some() {
                let rows = ext_tracks_to_meta(&json!([handled]), &quality);
                if !rows.is_empty() {
                    return Ok(rows);
                }
            }
        }
        let resolved = crate::zarz_api::resolve_url_region(&base, &q, &region)?;
        let id = resolved
            .spotify_id
            .clone()
            .unwrap_or_else(|| q.clone());
        if let Some(isrc) = resolved.isrc.clone() {
            if let Ok(data) = sidecar::search_provider(&app, "spotify-web", &isrc, 10) {
                let rows = ext_tracks_to_meta(&data, &quality);
                if !rows.is_empty() {
                    return Ok(rows);
                }
            }
        }
        return Ok(vec![TrackMeta {
            id: format!("spotify:{id}"),
            title: resolved
                .song_urls
                .get("Spotify")
                .cloned()
                .unwrap_or_else(|| "Resolved Spotify track".into()),
            artist: "SpotiFLAC resolve".into(),
            album: None,
            duration_ms: None,
            cover_url: None,
            isrc: resolved.isrc,
            spotify_id: resolved.spotify_id.or(Some(id)),
            source: Some("hifi".into()),
            path: None,
            stream_url: resolved.tidal_url.or(resolved.qobuz_url),
            quality_label: Some(quality),
        }]);
    }

    // SpotiFLAC Mobile style: hit preferred metadata providers one-by-one (fast first hit)
    const LIMIT: i32 = 16;
    for prov in &meta {
        if let Ok(data) = sidecar::search_provider(&app, prov, &q, LIMIT) {
            let rows = ext_tracks_to_meta(&data, &quality);
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
    }

    // Fallback: all enabled metadata extensions together
    if let Ok(data) = sidecar::search(&app, &q, LIMIT) {
        let rows = ext_tracks_to_meta(&data, &quality);
        if !rows.is_empty() {
            return Ok(rows);
        }
    }

    Err(
        "No HiFi results from installed metadata extensions. Install/enable spotify-web (or amazon) under Extensions — HiFi does not use yt-dlp."
            .into(),
    )
}

#[tauri::command]
pub fn hifi_enqueue(
    app: AppHandle,
    state: tauri::State<'_, Arc<HifiState>>,
    settings: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
    track: TrackMeta,
) -> Result<DownloadJob, String> {
    let id = Uuid::new_v4().to_string();
    let cfg = settings.lock().clone();
    let quality = cfg.hifi_quality.clone();
    let service = cfg.preferred_download_service.clone();
    let use_ext = sidecar::available(Some(&app));

    let job = DownloadJob {
        id: id.clone(),
        track: track.clone(),
        status: "queued".into(),
        progress: 0.0,
        file_path: None,
        error: None,
        measured_format: None,
        requested_quality: Some(quality.clone()),
        bit_depth: None,
        sample_rate_hz: None,
        service: Some(if use_ext {
            service.clone()
        } else {
            "yt-dlp".into()
        }),
        needs_login: Some(false),
        stage: Some("queued".into()),
        stage_label: Some("Queued…".into()),
        bytes_received: Some(0),
        bytes_total: None,
        speed_mbps: None,
        metadata_embedded: None,
        library_added: None,
    };
    state.jobs.lock().push(job.clone());
    let _ = app.emit("hifi-job-update", job.clone());

    let jobs = state.inner().clone();
    let data_dir = resolved_download_dir(&app, &cfg)?;

    let app2 = app.clone();
    std::thread::spawn(move || {
        run_download_job(&app2, &jobs, &id, &track, &data_dir, &cfg);
    });

    Ok(job)
}

fn provider_id_from_track(track: &TrackMeta) -> Option<String> {
    let id = &track.id;
    if let Some((prov, _)) = id.split_once(':') {
        if prov != "yt" && prov != "spotify" && prov != "demo" {
            return Some(prov.to_string());
        }
    }
    None
}

fn looks_like_auth_error(msg: &str) -> bool {
    let l = msg.to_lowercase();
    l.contains("login")
        || l.contains("auth")
        || l.contains("credential")
        || l.contains("session")
        || l.contains("verification")
        || l.contains("sign in")
        || l.contains("unauthorized")
        || l.contains("401")
}

fn run_download_job(
    app: &AppHandle,
    state: &Arc<HifiState>,
    id: &str,
    track: &TrackMeta,
    dir: &PathBuf,
    cfg: &crate::settings::AppSettings,
) {
    patch_job(app, state, id, |j| {
        j.status = "running".into();
        j.stage = Some("preparing".into());
        j.stage_label = Some("Preparing download…".into());
        j.progress = 0.05;
        j.needs_login = Some(false);
    });

    let stop = Arc::new(AtomicBool::new(false));
    spawn_dir_watcher(
        app.clone(),
        state.clone(),
        id.to_string(),
        dir.clone(),
        stop.clone(),
    );

    if sidecar::available(Some(app)) {
        let _ = sidecar::set_priority(
            app,
            &cfg.download_provider_priority,
            &cfg.metadata_provider_priority,
        );

        let mut track = track.clone();
        if let Some(sid) = track.spotify_id.clone().or_else(|| {
            track
                .id
                .strip_prefix("spotify:")
                .map(|s| s.to_string())
        }) {
            if let Ok(r) = crate::zarz_api::resolve_spotify_track_region(
                &cfg.zarz_api_base,
                &sid,
                &cfg.songlink_region,
            ) {
                if track.isrc.is_none() {
                    track.isrc = r.isrc;
                }
                if track.spotify_id.is_none() {
                    track.spotify_id = r.spotify_id.or(Some(sid));
                }
            }
        }

        let service = if cfg.preferred_download_service == "yt-dlp" {
            cfg.download_provider_priority
                .first()
                .cloned()
                .unwrap_or_else(|| "tidal-web".into())
        } else {
            cfg.preferred_download_service.clone()
        };

        let source = provider_id_from_track(&track).unwrap_or_else(|| service.clone());

        patch_job(app, state, id, |j| {
            j.service = Some(service.clone());
            j.stage = Some("downloading".into());
            j.stage_label = Some(format!("Downloading via {service}…"));
            j.progress = 0.12;
        });

        let req = json!({
            "isrc": track.isrc.clone().unwrap_or_default(),
            "service": service,
            "spotify_id": track.spotify_id.clone().unwrap_or_default(),
            "track_name": track.title,
            "artist_name": track.artist,
            "album_name": track.album.clone().unwrap_or_default(),
            "album_artist": track.artist,
            "cover_url": track.cover_url.clone().unwrap_or_default(),
            "output_dir": dir.to_string_lossy(),
            "filename_format": cfg.filename_format,
            "quality": cfg.hifi_quality,
            "embed_metadata": true,
            "embed_lyrics": cfg.embed_lyrics,
            "embed_max_quality_cover": cfg.embed_max_quality_cover,
            "embed_replaygain": cfg.embed_replaygain,
            "item_id": id,
            "duration_ms": track.duration_ms.unwrap_or(0),
            "source": source,
            "use_extensions": true,
            "use_fallback": cfg.auto_fallback,
            "songlink_region": cfg.songlink_region,
            "lyrics_mode": cfg.lyrics_mode,
            "tidal_high_format": cfg.tidal_high_format,
            "allow_quality_variant": cfg.allow_quality_variants,
        });

        match sidecar::download(app, req) {
            Ok(resp) => {
                let success = resp.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                if success {
                    stop.store(true, Ordering::Relaxed);
                    if let Some(path_s) = resp.get("file_path").and_then(|v| v.as_str()) {
                        let path = PathBuf::from(path_s);
                        let bit = resp
                            .get("actual_bit_depth")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32);
                        let rate = resp
                            .get("actual_sample_rate")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32);
                        let svc = resp
                            .get("service")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&service)
                            .to_string();
                        let label = match (bit, rate) {
                            (Some(b), Some(r)) => {
                                format!("FLAC · {b}bit · {}kHz", r as f64 / 1000.0)
                            }
                            _ => resp
                                .get("audio_codec")
                                .and_then(|v| v.as_str())
                                .unwrap_or("FLAC")
                                .to_string(),
                        };
                        // Prefer cover from response
                        let mut t = track.clone();
                        if let Some(c) = resp.get("cover_url").and_then(|v| v.as_str()) {
                            if !c.is_empty() {
                                t.cover_url = Some(c.to_string());
                            }
                        }
                        if let Some(title) = resp.get("title").and_then(|v| v.as_str()) {
                            if !title.is_empty() {
                                t.title = title.to_string();
                            }
                        }
                        if let Some(artist) = resp.get("artist").and_then(|v| v.as_str()) {
                            if !artist.is_empty() {
                                t.artist = artist.to_string();
                            }
                        }
                        if let Some(album) = resp.get("album").and_then(|v| v.as_str()) {
                            if !album.is_empty() {
                                t.album = Some(album.to_string());
                            }
                        }
                        finish_ok(
                            app,
                            state,
                            id,
                            &t,
                            path,
                            bit,
                            rate,
                            label,
                            svc,
                            cfg.embed_metadata,
                        );
                        return;
                    }
                }
                let err = resp
                    .get("error")
                    .or_else(|| resp.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("extension download failed")
                    .to_string();
                let auth = looks_like_auth_error(&err);
                if auth && !cfg.auto_fallback {
                    stop.store(true, Ordering::Relaxed);
                    patch_job(app, state, id, |j| {
                        j.status = "error".into();
                        j.stage = Some("error".into());
                        j.stage_label = Some("Login required".into());
                        j.error = Some(format!(
                            "{err} — open Extensions → Account for {service}"
                        ));
                        j.needs_login = Some(true);
                        j.service = Some(service);
                    });
                    return;
                }
                patch_job(app, state, id, |j| {
                    j.progress = 0.35;
                    j.stage_label = Some("Extension failed — trying fallback…".into());
                    j.error = Some(format!("extension: {err} — trying yt-dlp…"));
                    if auth {
                        j.needs_login = Some(true);
                    }
                });
            }
            Err(e) => {
                let auth = looks_like_auth_error(&e);
                if auth && !cfg.auto_fallback {
                    stop.store(true, Ordering::Relaxed);
                    patch_job(app, state, id, |j| {
                        j.status = "error".into();
                        j.stage = Some("error".into());
                        j.stage_label = Some("Login required".into());
                        j.error = Some(format!("{e} — open Extensions → Account / Connect"));
                        j.needs_login = Some(true);
                    });
                    return;
                }
                patch_job(app, state, id, |j| {
                    j.progress = 0.35;
                    j.stage_label = Some("Extension error — trying fallback…".into());
                    j.error = Some(format!("extension: {e} — trying yt-dlp…"));
                    j.needs_login = Some(auth);
                });
            }
        }
    }

    run_ytdlp_download(app, state, id, track, dir, cfg.embed_metadata, stop);
}

fn media_url(track: &TrackMeta) -> String {
    if let Some(u) = track.stream_url.as_deref() {
        if u.starts_with("http") {
            return u.to_string();
        }
    }
    let video = track.id.strip_prefix("yt:").unwrap_or(&track.id);
    if video
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && video.len() >= 6
        && !video.contains(' ')
    {
        return format!("https://www.youtube.com/watch?v={video}");
    }
    format!("ytsearch1:{} {}", track.artist, track.title)
}

fn run_ytdlp_download(
    app: &AppHandle,
    state: &Arc<HifiState>,
    id: &str,
    track: &TrackMeta,
    dir: &PathBuf,
    embed: bool,
    stop: Arc<AtomicBool>,
) {
    patch_job(app, state, id, |j| {
        j.service = Some("yt-dlp".into());
        j.stage = Some("downloading".into());
        j.stage_label = Some("Downloading via yt-dlp…".into());
        j.progress = 0.4;
    });

    let out_tmpl = dir.join("%(title)s-%(id)s.%(ext)s");
    let url = media_url(track);
    let out_s = out_tmpl.to_string_lossy().to_string();

    let result = ytdlp::run_timeout(
        Some(app),
        &[
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "flac",
            "--embed-thumbnail",
            "--embed-metadata",
            "--no-warnings",
            "-o",
            &out_s,
            &url,
        ],
        300,
    );

    stop.store(true, Ordering::Relaxed);

    match result {
        Ok(output) if output.status.success() => {
            if let Some(path) = newest_flac(dir) {
                let (bit_depth, sample_rate_hz, label) = measure_flac(&path);
                finish_ok(
                    app,
                    state,
                    id,
                    track,
                    path,
                    bit_depth,
                    sample_rate_hz,
                    label,
                    "yt-dlp".into(),
                    embed,
                );
            } else {
                patch_job(app, state, id, |j| {
                    j.status = "error".into();
                    j.stage = Some("error".into());
                    j.stage_label = Some("Failed".into());
                    j.error = Some("FLAC not found after yt-dlp".into());
                });
            }
        }
        Ok(output) => {
            let err = String::from_utf8_lossy(&output.stderr).into_owned();
            patch_job(app, state, id, |j| {
                j.status = "error".into();
                j.stage = Some("error".into());
                j.stage_label = Some("Failed".into());
                j.error = Some(err.chars().take(240).collect());
            });
        }
        Err(e) => {
            patch_job(app, state, id, |j| {
                j.status = "error".into();
                j.stage = Some("error".into());
                j.stage_label = Some("Failed".into());
                j.error = Some(e);
            });
        }
    }
}

fn newest_flac(dir: &PathBuf) -> Option<PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("flac"))
                .unwrap_or(false)
        })
        .collect();
    files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    files.pop()
}

#[tauri::command]
pub fn hifi_jobs(state: tauri::State<'_, Arc<HifiState>>) -> Vec<DownloadJob> {
    state.jobs.lock().clone()
}

fn measure_flac(path: &PathBuf) -> (Option<u32>, Option<u32>, String) {
    use lofty::file::AudioFile;
    if let Ok(tagged) = lofty::read_from_path(path) {
        let props = tagged.properties();
        let bit = props.bit_depth().map(|b| b as u32);
        let rate = props.sample_rate().filter(|&r| r > 0);
        let label = match (bit, rate) {
            (Some(b), Some(r)) => {
                let khz = f64::from(r) / 1000.0;
                format!("FLAC · {b}bit · {khz:.1}kHz")
            }
            _ => "FLAC".into(),
        };
        return (bit, rate, label);
    }
    (None, None, "FLAC".into())
}
