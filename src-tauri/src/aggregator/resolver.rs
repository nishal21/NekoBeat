use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

/// Serialize yt-dlp so play + prefetch don't thrash the same binary/network.
fn yt_dlp_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

pub async fn resolve_url(
    app: &tauri::AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
) -> Result<String, String> {
    println!("Resolver: Resolving URL: {}", url);
    let result = if url.contains("youtube.com") || url.contains("youtu.be") {
        // souphttpsrc cannot fetch googlevideo CDN on this setup (error -5).
        // Download with yt-dlp (correct UA/signing) then play a local file.
        resolve_youtube_download(app, url).await
    } else if url.contains("soundcloud.com") || url.contains("api-v2.soundcloud.com") {
        // souphttpsrc also fails on sndcdn CDN (error -5) — download then file:// play.
        resolve_soundcloud_download(app, url).await
    } else if url.contains("spotify.com") {
        crate::aggregator::spotify::resolve_spotify_url(app, url, hint_title, hint_artist).await
    } else {
        Err(format!("Unsupported external source URL: {}", url))
    };
    match &result {
        Ok(resolved) => println!(
            "Resolver: Successfully resolved to: {}...",
            &resolved[..std::cmp::min(resolved.len(), 120)]
        ),
        Err(e) => eprintln!("Resolver: Failed: {}", e),
    }
    result
}

/// Warm disk cache for a track without playing (next-up / skip latency).
pub async fn prefetch_url(
    app: &tauri::AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
) -> Result<(), String> {
    println!("Prefetch: warming cache for {}", url);
    let result = if url.contains("spotify.com") {
        crate::aggregator::spotify::prefetch_spotify_youtube(app, url, hint_title, hint_artist).await
    } else {
        resolve_url(app, url, hint_title, hint_artist).await
    };
    match result {
        Ok(uri) => {
            println!(
                "Prefetch: ready {}",
                &uri[..std::cmp::min(uri.len(), 100)]
            );
            Ok(())
        }
        Err(e) => {
            eprintln!("Prefetch: failed: {}", e);
            Err(e)
        }
    }
}

fn youtube_video_id(url: &str) -> Option<String> {
    if let Some(v) = url.split("v=").nth(1) {
        let id = v.split('&').next()?.trim();
        if id.len() >= 8 {
            return Some(id.to_string());
        }
    }
    if let Some(rest) = url.split("youtu.be/").nth(1) {
        let id = rest.split('?').next()?.trim();
        if id.len() >= 8 {
            return Some(id.to_string());
        }
    }
    None
}

fn yt_cache_dir(app: &AppHandle) -> PathBuf {
    let app_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = app_dir.join("yt_audio");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn find_cached_yt_file(dir: &Path, video_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy();
        if name.starts_with(video_id)
            && !name.ends_with(".part")
            && !name.ends_with(".ytdl")
        {
            if let Ok(meta) = entry.metadata() {
                if meta.len() > 50_000 {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// Download YouTube audio via yt-dlp to disk, return file:// URI for GStreamer.
/// yt-dlp talks to googlevideo itself — avoids broken souphttpsrc CDN streaming.
async fn resolve_youtube_download(app: &AppHandle, url: &str) -> Result<String, String> {
    let video_id = youtube_video_id(url)
        .ok_or_else(|| format!("YouTube: could not parse video id from {}", url))?;
    let cache_dir = yt_cache_dir(app);

    if let Some(existing) = find_cached_yt_file(&cache_dir, &video_id) {
        println!("YouTube: disk cache hit — instant play ({:?})", existing);
        return Ok(crate::path_util::path_to_file_uri(&existing));
    }

    // One yt-dlp at a time — play wins the lock first; prefetch waits then hits cache.
    let _guard = yt_dlp_lock().lock().await;

    // Re-check after waiting (another task may have finished the download).
    if let Some(existing) = find_cached_yt_file(&cache_dir, &video_id) {
        println!("YouTube: disk cache hit after wait — {:?}", existing);
        return Ok(crate::path_util::path_to_file_uri(&existing));
    }

    let ytdlp = crate::process_util::find_ytdlp();
    let mut last_err = String::new();

    if let Ok(ytdlp_path) = ytdlp {
        let out_tmpl = cache_dir
            .join(format!("{}.%(ext)s", video_id))
            .to_string_lossy()
            .to_string();

        println!(
            "YouTube: Downloading via yt-dlp to cache (id={}) — soup CDN stream broken on this build",
            video_id
        );

        // tv_embedded often yields smaller audio-only; android as fallback (progressive mp4).
        for client in ["tv_embedded", "android"] {
            // Clean partials from a previous failed attempt
            if let Ok(entries) = std::fs::read_dir(&cache_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with(&video_id)
                        && (name.ends_with(".part") || name.ends_with(".ytdl"))
                    {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }

            let args = vec![
                "-f".into(),
                "ba/bestaudio/best".into(),
                "--no-warnings".into(),
                "--no-playlist".into(),
                "--extractor-args".into(),
                format!("youtube:player_client={}", client),
                "-o".into(),
                out_tmpl.clone(),
                "--".into(),
                url.to_string(),
            ];

            let mut cmd = tokio::process::Command::new(&ytdlp_path);
            cmd.args(&args);
            match crate::process_util::run_silent_timeout(cmd, std::time::Duration::from_secs(180))
                .await
            {
                Ok(output) if output.status.success() => {
                    if let Some(path) = find_cached_yt_file(&cache_dir, &video_id) {
                        println!(
                            "YouTube: Downloaded via {} → {:?} ({} bytes)",
                            client,
                            path,
                            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
                        );
                        return Ok(crate::path_util::path_to_file_uri(&path));
                    }
                    last_err = format!("yt-dlp {} succeeded but cache file missing", client);
                }
                Ok(output) => {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    last_err = format!("{} | {}", stderr, stdout);
                    println!(
                        "YouTube: yt-dlp {} download failed: {}",
                        client,
                        &last_err[..std::cmp::min(last_err.len(), 200)]
                    );
                }
                Err(e) => {
                    last_err = e;
                    println!("YouTube: yt-dlp {} error: {}", client, last_err);
                }
            }
        }
    } else if let Err(e) = ytdlp {
        last_err = e;
        println!(
            "YouTube: yt-dlp missing ({}) — trying in-process rusty_ytdl",
            last_err
        );
    }

    // In-process fallback (critical on Android where yt-dlp is not bundled)
    match resolve_youtube_rusty(&cache_dir, url, &video_id).await {
        Ok(uri) => return Ok(uri),
        Err(e) => {
            if last_err.is_empty() {
                last_err = e;
            } else {
                last_err = format!("{}; rusty_ytdl: {}", last_err, e);
            }
        }
    }

    Err(format!("YouTube download failed: {}", last_err))
}

/// Download YouTube audio with rusty_ytdl (no external binary).
async fn resolve_youtube_rusty(
    cache_dir: &Path,
    url: &str,
    video_id: &str,
) -> Result<String, String> {
    use rusty_ytdl::{Video, VideoOptions, VideoQuality, VideoSearchOptions};

    println!("YouTube: rusty_ytdl download for {}", video_id);

    let options = VideoOptions {
        quality: VideoQuality::HighestAudio,
        filter: VideoSearchOptions::Audio,
        ..Default::default()
    };

    let video = Video::new_with_options(url, options)
        .map_err(|e| format!("init failed: {}", e))?;

    // Prefer container from format info when available
    let mut ext = "webm".to_string();
    if let Ok(info) = video.get_info().await {
        if let Some(fmt) = info
            .formats
            .iter()
            .find(|f| f.has_audio && !f.has_video)
            .or_else(|| info.formats.iter().find(|f| f.has_audio))
        {
            let c = fmt.mime_type.container.trim();
            if !c.is_empty() {
                ext = if c == "mp4" {
                    "m4a".to_string()
                } else {
                    c.to_string()
                };
            }
        }
    }

    let out_path = cache_dir.join(format!("{}.{}", video_id, ext));
    // Remove stale partial
    let _ = std::fs::remove_file(&out_path);

    video
        .download(&out_path)
        .await
        .map_err(|e| format!("download failed: {}", e))?;

    if let Ok(meta) = std::fs::metadata(&out_path) {
        if meta.len() > 50_000 {
            println!(
                "YouTube: rusty_ytdl saved {:?} ({} bytes)",
                out_path,
                meta.len()
            );
            return Ok(crate::path_util::path_to_file_uri(&out_path));
        }
    }

    let _ = std::fs::remove_file(&out_path);
    Err("downloaded file missing or too small".into())
}

/// Resolve a YouTube search query → download top hit → local file URI.
pub async fn resolve_youtube_search(app: &AppHandle, query: &str) -> Result<String, String> {
    println!("YouTube Search: Resolving stream for query: '{}'", query);

    let scrape_result = async {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!(
            "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
            urlencoding::encode(query)
        );

        let html = client
            .get(&url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+634")
            .send()
            .await
            .map_err(|e| format!("YouTube search request failed: {}", e))?
            .text()
            .await
            .map_err(|e| e.to_string())?;

        let marker = "var ytInitialData = ";
        let start = html.find(marker).ok_or("Could not find ytInitialData")?;
        let json_start = start + marker.len();
        let json_end = html[json_start..]
            .find(";</script>")
            .ok_or("Could not find end of ytInitialData")?;
        let json_str = &html[json_start..json_start + json_end];

        let data: serde_json::Value =
            serde_json::from_str(json_str).map_err(|e| e.to_string())?;

        let contents = data
            .pointer("/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents")
            .and_then(|c| c.as_array());

        let video_id = contents
            .and_then(|sections| {
                sections.iter().find_map(|s| {
                    s.pointer("/itemSectionRenderer/contents")
                        .and_then(|c| c.as_array())
                        .and_then(|items| {
                            items.iter().find_map(|item| {
                                let id = item
                                    .pointer("/videoRenderer/videoId")
                                    .and_then(|v| v.as_str())?;
                                // Skip YouTube Shorts / teasers (< 90s) — they make the bar race on a "preview"
                                let length = item
                                    .pointer("/videoRenderer/lengthText/simpleText")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let secs = parse_yt_length_secs(length);
                                if secs > 0 && secs < 90 {
                                    println!(
                                        "YouTube Search: skipping short result {} ({}s)",
                                        id, secs
                                    );
                                    return None;
                                }
                                Some(id.to_string())
                            })
                        })
                })
            })
            .ok_or_else(|| format!("YouTube Search: No video results for '{}'", query))?;

        Ok::<String, String>(video_id)
    }
    .await;

    if let Ok(video_id) = scrape_result {
        let video_url = format!("https://www.youtube.com/watch?v={}", video_id);
        println!(
            "YouTube Search: Found video '{}', downloading...",
            video_id
        );
        match resolve_youtube_download(app, &video_url).await {
            Ok(uri) => return Ok(uri),
            Err(e) => println!("YouTube Search: download failed for '{}': {}", video_id, e),
        }
    } else {
        println!(
            "YouTube Search: Scrape failed: {}",
            scrape_result.unwrap_err()
        );
    }

    // Last resort: yt-dlp search + download (skipped when yt-dlp missing)
    if crate::process_util::find_ytdlp().is_ok() {
        println!("YouTube Search: yt-dlp ytsearch1 download fallback...");
        let search_url = format!("ytsearch1:{}", query);
        return resolve_youtube_download(app, &search_url).await;
    }

    Err(format!(
        "YouTube Search: no results for '{}'",
        query
    ))
}

fn sc_track_id(url: &str) -> String {
    if let Some(rest) = url.split("/tracks/").nth(1) {
        let id = rest
            .split(['?', '&', '/'])
            .next()
            .unwrap_or("unknown")
            .trim();
        if !id.is_empty() {
            return id.to_string();
        }
    }
    format!("{:x}", md5_like(url))
}

/// Parse YouTube lengthText like "4:05" or "1:02:03" → seconds (0 if unknown).
fn parse_yt_length_secs(s: &str) -> u64 {
    let parts: Vec<&str> = s.trim().split(':').collect();
    match parts.len() {
        2 => {
            let m: u64 = parts[0].parse().unwrap_or(0);
            let sec: u64 = parts[1].parse().unwrap_or(0);
            m * 60 + sec
        }
        3 => {
            let h: u64 = parts[0].parse().unwrap_or(0);
            let m: u64 = parts[1].parse().unwrap_or(0);
            let sec: u64 = parts[2].parse().unwrap_or(0);
            h * 3600 + m * 60 + sec
        }
        _ => 0,
    }
}

fn md5_like(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn sc_cache_dir(app: &AppHandle) -> PathBuf {
    let app_dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = app_dir.join("sc_audio");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn find_cached_sc_file(dir: &Path, track_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy();
        if (name == format!("{}.mp3", track_id) || name.starts_with(&format!("{}_", track_id)))
            && !name.ends_with(".part")
        {
            if let Ok(meta) = entry.metadata() {
                if meta.len() > 8_000 {
                    return Some(path);
                }
            }
        }
    }
    None
}

async fn download_http_audio(url: &str, dest: &Path) -> Result<(), String> {
    if url.contains(".m3u8") || url.contains("/playlist/") {
        return Err("HLS playlist cannot be downloaded as a single file".into());
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Referer", "https://soundcloud.com/")
        .header("Origin", "https://soundcloud.com")
        .send()
        .await
        .map_err(|e| format!("SoundCloud download request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("SoundCloud download HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("SoundCloud download body failed: {}", e))?;
    if bytes.len() < 8_000 {
        return Err(format!(
            "SoundCloud download too small ({} bytes)",
            bytes.len()
        ));
    }

    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve SoundCloud → download progressive/preview MP3 → local file:// URI.
async fn resolve_soundcloud_download(app: &AppHandle, url: &str) -> Result<String, String> {
    let track_id = sc_track_id(url);
    let cache_dir = sc_cache_dir(app);

    if let Some(existing) = find_cached_sc_file(&cache_dir, &track_id) {
        let is_preview_cache = existing
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.contains("_preview"))
            .unwrap_or(false);
        if !is_preview_cache {
            println!("SoundCloud: disk cache hit — {:?}", existing);
            return Ok(crate::path_util::path_to_file_uri(&existing));
        }
        println!("SoundCloud: preview cache only — will prefer YouTube full match");
    }

    let resolved = crate::aggregator::soundcloud::resolve(url).await?;
    let (stream_url, is_preview) = if let Some(preview) = resolved.strip_prefix("PREVIEW:") {
        (preview.to_string(), true)
    } else {
        (resolved, false)
    };

    // Geo-blocked / SNIP: prefer a full YouTube match over a silent 30s preview CDN URL.
    if is_preview {
        if let Ok((title, artist)) = crate::aggregator::soundcloud::fetch_title_artist(url).await {
            let query = format!("{} {}", artist, title).trim().to_string();
            println!(
                "SoundCloud: SNIP/preview — trying YouTube full match for '{}'",
                query
            );
            match resolve_youtube_search(app, &query).await {
                Ok(yt) => {
                    println!("SoundCloud: YouTube fallback OK");
                    return Ok(yt);
                }
                Err(e) => println!("SoundCloud: YouTube fallback failed: {}", e),
            }
        }
    }

    // Prefer progressive HTTP audio. If we only got HLS, fall back to YouTube by failing up.
    if stream_url.contains(".m3u8") || stream_url.contains("/playlist/") {
        if let Ok((title, artist)) = crate::aggregator::soundcloud::fetch_title_artist(url).await {
            let query = format!("{} {}", artist, title).trim().to_string();
            return resolve_youtube_search(app, &query).await;
        }
        return Err(
            "SoundCloud: only HLS available and CDN streaming is broken on this build — try another track"
                .into(),
        );
    }

    let dest = cache_dir.join(format!(
        "{}{}.mp3",
        track_id,
        if is_preview { "_preview" } else { "" }
    ));
    println!(
        "SoundCloud: Downloading {} stream to {:?}",
        if is_preview { "preview" } else { "full" },
        dest
    );

    match download_http_audio(&stream_url, &dest).await {
        Ok(()) => {
            let file_uri = crate::path_util::path_to_file_uri(&dest);
            if is_preview {
                Ok(format!("PREVIEW:{}", file_uri))
            } else {
                Ok(file_uri)
            }
        }
        Err(e) => {
            eprintln!("SoundCloud: download failed: {}", e);
            if let Ok((title, artist)) = crate::aggregator::soundcloud::fetch_title_artist(url).await
            {
                let query = format!("{} {}", artist, title).trim().to_string();
                resolve_youtube_search(app, &query).await
            } else {
                Err(e)
            }
        }
    }
}
