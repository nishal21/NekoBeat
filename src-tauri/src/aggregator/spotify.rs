use tauri::{AppHandle, Emitter, Manager};
use serde_json::Value;
use std::path::PathBuf;
use futures::future::FutureExt;

use crate::sidecar_util::{self, METADATA_TIMEOUT};
#[cfg(not(target_os = "android"))]
use crate::sidecar_util::DOWNLOAD_TIMEOUT;

/// Resolve Spotify: prefer cached HiFi file → instant YouTube match → background SpotiFLAC HiFi.
/// Optional `hint_title` / `hint_artist` from search UI skip METADATA entirely.
/// When `warm_cache_only`, skips background HiFi (used by next-track prefetch).
pub async fn resolve_spotify_url(
    app: &AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
    hint_duration_ms: Option<u64>,
) -> Result<String, String> {
    resolve_spotify_url_inner(app, url, hint_title, hint_artist, hint_duration_ms, false).await
}

pub async fn prefetch_spotify_youtube(
    app: &AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
    hint_duration_ms: Option<u64>,
) -> Result<String, String> {
    resolve_spotify_url_inner(app, url, hint_title, hint_artist, hint_duration_ms, true).await
}

async fn resolve_spotify_url_inner(
    app: &AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
    hint_duration_ms: Option<u64>,
    warm_cache_only: bool,
) -> Result<String, String> {
    println!(
        "Spotify: Resolving (hybrid{}) for URL: {}",
        if warm_cache_only { ", prefetch" } else { "" },
        url
    );

    let track_id = spotify_id_from_url(url);

    // 1) Cached liked / HiFi file — always prefer local when present.
    if let Some(ref id) = track_id {
        if let Ok(Some(path)) = crate::offline::check_liked_cache(app.clone(), id.clone()).await {
            let file_uri = crate::path_util::path_to_file_uri(std::path::Path::new(&path));
            println!("Spotify: Using cached liked/HiFi at {}", path);
            return Ok(file_uri);
        }
        if let Some(cached) = find_hifi_cache(app, id) {
            let file_uri = crate::path_util::path_to_file_uri(&cached);
            println!("Spotify: Using HiFi cache at {:?}", cached);
            return Ok(file_uri);
        }
    }

    let hint_t = hint_title.map(str::trim).filter(|s| !s.is_empty());
    let hint_a = hint_artist.map(str::trim).filter(|s| !s.is_empty());

    let (title, artist) = if let Some(t) = hint_t {
        let a = hint_a.unwrap_or("").to_string();
        println!("Spotify: Using UI title/artist hints (skip METADATA)");
        (t.to_string(), a)
    } else {
        let meta = fetch_spotify_metadata(app, url).await.ok();
        meta.as_ref()
            .map(|m| {
                (
                    m.get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    m.get("artist")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .unwrap_or_default()
    };

    let clean_title = crate::aggregator::resolver::clean_spotify_query_part(&title);
    let clean_artist = crate::aggregator::resolver::clean_spotify_query_part(
        artist.split(',').next().unwrap_or(&artist),
    );

    // Instant YouTube match — same primary path on desktop and Android
    // (Android Go AAR is optional background only; never block playback).
    let mut query = format!("{} {}", clean_artist, clean_title)
        .trim()
        .to_string();
    if query.is_empty() {
        if let Some(ref id) = track_id {
            let raw = id.trim_start_matches("sp-");
            query = format!("spotify track {}", raw);
        }
    }
    if query.is_empty() {
        return Err(
            "Spotify: could not resolve track metadata — rebuild spotiflac-cli sidecar".into(),
        );
    }

    println!(
        "Spotify: Instant YouTube match for '{}' (raw '{} — {}')",
        query, artist, title
    );
    let yt_query = if query.to_lowercase().contains("official") {
        query.clone()
    } else {
        format!("{} official audio", query)
    };
    let stream = crate::aggregator::resolver::resolve_youtube_search_matched(
        app,
        &yt_query,
        Some(clean_title.as_str()),
        Some(clean_artist.as_str()),
        hint_duration_ms.filter(|&ms| ms >= 30_000),
    )
    .await?;

    // Hints mean we found the right match — overwrite liked offline file (fixes prior bad downloads)
    if hint_title.map(str::trim).filter(|s| !s.is_empty()).is_some() {
        if let Some(ref id) = track_id {
            if let Some(path) = file_uri_to_path(&stream) {
                if path.is_file() {
                    let _ = crate::offline::replace_liked_audio_file(app, id, &path);
                }
            }
        }
    }

    if warm_cache_only {
        return Ok(stream);
    }

    // Background silent HiFi — desktop CLI; Android Go AAR in :spotiflac process.
    #[cfg(not(target_os = "android"))]
    {
        let app_bg = app.clone();
        let url_bg = url.to_string();
        let id_bg = track_id.clone();
        let title_bg = title.clone();
        let artist_bg = artist.clone();
        tauri::async_runtime::spawn(async move {
            match download_spotify_hifi(&app_bg, &url_bg).await {
                Ok(path) => {
                    println!("Spotify: HiFi ready at {:?}", path);
                    if let Some(ref id) = id_bg {
                        crate::offline::update_local_audio_path_for_track(&app_bg, id, &path);
                    }
                    let _ = app_bg.emit(
                        "spotify-hifi-ready",
                        serde_json::json!({
                            "id": id_bg,
                            "path": path.to_string_lossy(),
                            "title": title_bg,
                            "artist": artist_bg,
                        }),
                    );
                }
                Err(e) => {
                    eprintln!("Spotify: Background HiFi failed (non-fatal): {}", e);
                }
            }
        });
    }

    #[cfg(target_os = "android")]
    {
        if crate::spotiflac_mobile::aar_available() {
            let app_bg = app.clone();
            let url_bg = url.to_string();
            let id_bg = track_id.clone();
            let title_bg = title.clone();
            let artist_bg = artist.clone();
            let clean_t = clean_title.clone();
            let clean_a = clean_artist.clone();
            let dur = hint_duration_ms;
            tauri::async_runtime::spawn(async move {
                match crate::spotiflac_mobile::download_track(
                    &app_bg, &url_bg, &clean_t, &clean_a, dur,
                )
                .await
                {
                    Ok(path) => {
                        println!("Spotify: Android AAR HiFi ready at {:?}", path);
                        if let Some(ref id) = id_bg {
                            crate::offline::update_local_audio_path_for_track(&app_bg, id, &path);
                        }
                        let _ = app_bg.emit(
                            "spotify-hifi-ready",
                            serde_json::json!({
                                "id": id_bg,
                                "path": path.to_string_lossy(),
                                "title": title_bg,
                                "artist": artist_bg,
                            }),
                        );
                    }
                    Err(e) => {
                        eprintln!("Spotify: Android AAR HiFi failed (non-fatal): {e}");
                    }
                }
            });
        }
    }

    Ok(stream)
}

fn spotify_id_from_url(url: &str) -> Option<String> {
    let parts: Vec<&str> = url.split('/').collect();
    let last = parts.last()?;
    let id = last.split('?').next()?;
    if id.len() >= 10 {
        Some(format!("sp-{}", id))
    } else {
        None
    }
}

fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let raw = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))?;
    // Windows file:///C:/... → C:/...
    let path = if cfg!(windows) && raw.len() >= 2 && raw.as_bytes()[1] == b':' {
        PathBuf::from(raw)
    } else if cfg!(windows) {
        PathBuf::from(format!("/{}", raw))
    } else {
        PathBuf::from(format!("/{}", raw))
    };
    Some(path)
}

fn hifi_cache_dir(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let dir = app_dir.join("nekobeat_spotify_hifi");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn find_hifi_cache(app: &AppHandle, track_id: &str) -> Option<PathBuf> {
    let dir = hifi_cache_dir(app);
    let raw_id = track_id.trim_start_matches("sp-");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(raw_id) && entry.path().is_file() {
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > 10_000 {
                        return Some(entry.path());
                    }
                }
            }
        }
    }
    None
}

/// Spotify oEmbed — no auth, works when sidecar METADATA is unavailable.
async fn fetch_spotify_oembed(url: &str) -> Result<Value, String> {
    let oembed_url = format!(
        "https://open.spotify.com/oembed?url={}",
        urlencoding::encode(url)
    );
    let client = reqwest::Client::new();
    let res = client
        .get(&oembed_url)
        .send()
        .await
        .map_err(|e| format!("oEmbed request: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("oEmbed HTTP {}", res.status()));
    }
    let parsed: Value = res.json().await.map_err(|e| format!("oEmbed parse: {}", e))?;
    let full_title = parsed["title"].as_str().unwrap_or("").to_string();
    if full_title.is_empty() {
        return Err("oEmbed: empty title".into());
    }
    let parts: Vec<&str> = full_title.split('·').map(|s| s.trim()).collect();
    let (title, artist) = if parts.len() >= 2 {
        (parts[0].to_string(), parts[1].to_string())
    } else {
        (
            full_title,
            parsed["author_name"].as_str().unwrap_or("").to_string(),
        )
    };
    // Artist-less oEmbed must not win the metadata race — "Believe official audio" matches random songs
    if artist.trim().is_empty() {
        return Err("oEmbed: no artist (need sidecar METADATA)".into());
    }
    Ok(serde_json::json!({ "title": title, "artist": artist }))
}

async fn fetch_spotify_sidecar_metadata(app: &AppHandle, url: &str) -> Result<Value, String> {
    let output = sidecar_util::run_sidecar(app, &[url, "METADATA"], METADATA_TIMEOUT).await?;

    let json_line = sidecar_util::last_json_line(&output.stdout);
    if let Ok(parsed) = serde_json::from_str::<Value>(&json_line) {
        let title = parsed
            .get("title")
            .or_else(|| parsed.pointer("/track/name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let artist = parsed
            .get("artist")
            .or_else(|| parsed.pointer("/track/artists"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !title.is_empty() {
            return Ok(serde_json::json!({ "title": title, "artist": artist }));
        }
    }
    Err("METADATA sidecar: no title".into())
}

/// Race oEmbed (fast) against sidecar METADATA — first usable title+artist wins.
async fn fetch_spotify_metadata(app: &AppHandle, url: &str) -> Result<Value, String> {
    let url_a = url.to_string();
    let url_b = url.to_string();
    let app_clone = app.clone();

    let oembed = async move { fetch_spotify_oembed(&url_a).await }.boxed();
    let sidecar = async move { fetch_spotify_sidecar_metadata(&app_clone, &url_b).await }.boxed();

    match futures::future::select_ok(vec![oembed, sidecar]).await {
        Ok((meta, _)) => {
            println!("Spotify: Got metadata (raced oEmbed/sidecar)");
            Ok(meta)
        }
        Err(e) => Err(format!("Spotify metadata failed: {}", e)),
    }
}

#[cfg(not(target_os = "android"))]
async fn download_spotify_hifi(app: &AppHandle, url: &str) -> Result<PathBuf, String> {
    let out_dir = hifi_cache_dir(app);
    let out_str = out_dir.to_string_lossy().to_string();

    let output =
        sidecar_util::run_sidecar(app, &[url, &out_str], DOWNLOAD_TIMEOUT).await?;

    if !output.success {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        if err.contains("cooldown") || out.contains("cooldown") {
            return Err("API cooldown".into());
        }
        return Err(format!("HiFi sidecar failed: {} {}", err, out));
    }

    let json_line = sidecar_util::last_json_line(&output.stdout);

    if let Ok(parsed) = serde_json::from_str::<Value>(&json_line) {
        if parsed["success"].as_bool() == Some(true) {
            if let Some(file_path) = parsed["file"].as_str() {
                return Ok(PathBuf::from(file_path));
            }
        }
        if parsed["fallback"].as_bool() == Some(true) {
            return Err("lossless providers exhausted".into());
        }
    }

    Err(format!("Could not parse HiFi output: {}", json_line))
}
