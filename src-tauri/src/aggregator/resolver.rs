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
    resolve_url_with_duration(app, url, hint_title, hint_artist, None).await
}

pub async fn resolve_url_with_duration(
    app: &tauri::AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
    hint_duration_ms: Option<u64>,
) -> Result<String, String> {
    println!("Resolver: Resolving URL: {}", url);
    let result = if url.contains("youtube.com") || url.contains("youtu.be") {
        // Direct YouTube URL — already the chosen video (no rematch).
        resolve_youtube_download(app, url).await
    } else if url.contains("soundcloud.com") || url.contains("api-v2.soundcloud.com") {
        resolve_soundcloud_download(app, url).await
    } else if url.contains("spotify.com") {
        crate::aggregator::spotify::resolve_spotify_url(
            app,
            url,
            hint_title,
            hint_artist,
            hint_duration_ms,
        )
        .await
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
    prefetch_url_with_duration(app, url, hint_title, hint_artist, None).await
}

pub async fn prefetch_url_with_duration(
    app: &tauri::AppHandle,
    url: &str,
    hint_title: Option<&str>,
    hint_artist: Option<&str>,
    hint_duration_ms: Option<u64>,
) -> Result<(), String> {
    println!("Prefetch: warming cache for {}", url);
    let result = if url.contains("spotify.com") {
        crate::aggregator::spotify::prefetch_spotify_youtube(
            app,
            url,
            hint_title,
            hint_artist,
            hint_duration_ms,
        )
        .await
    } else {
        resolve_url_with_duration(app, url, hint_title, hint_artist, hint_duration_ms).await
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

    // Order: yt-dlp (bundled libytdlp.so on Android) → rusty → Piped/Invidious.
    // Old Android order (proxies first) timed out for minutes and play never started.
    match &ytdlp {
        Ok(ytdlp_path) => {
            let out_tmpl = cache_dir
                .join(format!("{}.%(ext)s", video_id))
                .to_string_lossy()
                .to_string();

            println!(
                "YouTube: Downloading via yt-dlp to cache (id={}) — soup CDN stream broken on this build",
                video_id
            );

            // android client first on phone; tv_embedded often smaller audio-only.
            let clients: &[&str] = if cfg!(target_os = "android") {
                &["android", "tv_embedded", "ios"]
            } else {
                &["tv_embedded", "android"]
            };

            for client in clients {
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

                let mut cmd = tokio::process::Command::new(ytdlp_path);
                cmd.args(&args);
                match crate::process_util::run_silent_timeout(cmd, std::time::Duration::from_secs(120))
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
                        push_err(
                            &mut last_err,
                            format!("yt-dlp {} succeeded but cache file missing", client),
                        );
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        let msg = format!("yt-dlp {}: {} | {}", client, stderr, stdout);
                        println!(
                            "YouTube: yt-dlp download failed: {}",
                            &msg[..std::cmp::min(msg.len(), 200)]
                        );
                        push_err(&mut last_err, msg);
                    }
                    Err(e) => {
                        println!("YouTube: yt-dlp {} error: {}", client, e);
                        push_err(&mut last_err, format!("yt-dlp {}: {}", client, e));
                    }
                }
            }
        }
        Err(e) => {
            println!("YouTube: yt-dlp unavailable ({}) — trying in-process download", e);
            push_err(&mut last_err, format!("yt-dlp unavailable: {}", e));
        }
    }

    match resolve_youtube_rusty(&cache_dir, url, &video_id).await {
        Ok(uri) => return Ok(uri),
        Err(e) => push_err(&mut last_err, format!("rusty_ytdl: {}", e)),
    }

    match resolve_youtube_via_proxy_apis(&cache_dir, &video_id).await {
        Ok(uri) => return Ok(uri),
        Err(e) => push_err(&mut last_err, format!("proxy: {}", e)),
    }

    Err(format!(
        "YouTube download failed (yt-dlp + rusty + Piped/Invidious): {}",
        if last_err.is_empty() {
            "unknown error — all download paths failed".to_string()
        } else {
            last_err.chars().take(360).collect::<String>()
        }
    ))
}

fn push_err(last: &mut String, msg: String) {
    let msg = msg.trim();
    if msg.is_empty() {
        return;
    }
    if last.is_empty() {
        *last = msg.to_string();
    } else if !last.contains(msg) {
        *last = format!("{}; {}", last, msg);
    }
}

/// Download YouTube audio with rusty_ytdl (no external binary).
/// Falls back to reqwest fetch of the stream URL when Video::download fails (common on Android).
async fn resolve_youtube_rusty(
    cache_dir: &Path,
    url: &str,
    video_id: &str,
) -> Result<String, String> {
    use rusty_ytdl::{Video, VideoOptions, VideoQuality, VideoSearchOptions};

    println!("YouTube: rusty_ytdl download for {}", video_id);
    let _ = std::fs::create_dir_all(cache_dir);

    let options = VideoOptions {
        quality: VideoQuality::HighestAudio,
        filter: VideoSearchOptions::Audio,
        ..Default::default()
    };

    let video = Video::new_with_options(url, options)
        .map_err(|e| format!("init failed: {}", e))?;

    let info = video
        .get_info()
        .await
        .map_err(|e| format!("get_info failed: {}", e))?;

    // Prefer MP4/M4A for Android GStreamer (isomp4 + faad/androidmedia); then webm/opus.
    let mut formats: Vec<_> = info
        .formats
        .iter()
        .filter(|f| f.has_audio)
        .collect();
    formats.sort_by_key(|f| {
        let c = f.mime_type.container.to_ascii_lowercase();
        let audio_only = !f.has_video;
        let rank = if c.contains("mp4") || c.contains("m4a") {
            0
        } else if c.contains("webm") {
            1
        } else {
            2
        };
        (if audio_only { 0 } else { 1 }, rank)
    });

    let mut last = String::new();

    for fmt in formats.iter().take(6) {
        let container = fmt.mime_type.container.trim().to_ascii_lowercase();
        let ext = if container.contains("mp4") || container == "m4a" {
            "m4a"
        } else if container.contains("webm") {
            "webm"
        } else if !container.is_empty() {
            container.as_str()
        } else {
            "m4a"
        };
        let out_path = cache_dir.join(format!("{}.{}", video_id, ext));
        let _ = std::fs::remove_file(&out_path);

        let stream_url = fmt.url.trim();
        if stream_url.is_empty() {
            continue;
        }

        // 1) Direct HTTP download (works when rusty download() misbehaves on Android)
        match download_url_to_file(stream_url, &out_path).await {
            Ok(()) => {
                if file_big_enough(&out_path) {
                    println!(
                        "YouTube: reqwest saved {:?} ({} bytes, {})",
                        out_path,
                        std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0),
                        ext
                    );
                    return Ok(crate::path_util::path_to_file_uri(&out_path));
                }
                let _ = std::fs::remove_file(&out_path);
                push_err(&mut last, format!("{} reqwest file too small", ext));
            }
            Err(e) => push_err(&mut last, format!("{} reqwest: {}", ext, e)),
        }
    }

    // 2) rusty_ytdl built-in download as last resort
    let out_path = cache_dir.join(format!("{}.m4a", video_id));
    let _ = std::fs::remove_file(&out_path);
    match video.download(&out_path).await {
        Ok(()) if file_big_enough(&out_path) => {
            println!("YouTube: rusty download() saved {:?}", out_path);
            return Ok(crate::path_util::path_to_file_uri(&out_path));
        }
        Ok(()) => {
            let _ = std::fs::remove_file(&out_path);
            push_err(&mut last, "rusty download() file too small".into());
        }
        Err(e) => push_err(&mut last, format!("rusty download(): {}", e)),
    }

    Err(if last.is_empty() {
        "no usable audio formats".into()
    } else {
        last
    })
}

fn file_big_enough(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() > 20_000)
        .unwrap_or(false)
}

async fn download_url_to_file(url: &str, out_path: &Path) -> Result<(), String> {
    // Match googlevideo signed client — Chrome desktop UA often gets HTTP 403.
    let ua = if url.contains("googlevideo.com") || url.contains("c=ANDROID") {
        "com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip"
    } else if url.contains("c=TV") || url.contains("c=TVHTML5") {
        "Mozilla/5.0 (ChromiumStylePlatform) cobalt/Version"
    } else {
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
    };
    let client = reqwest::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(url)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }

    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("body: {}", e))?;
    if bytes.len() < 20_000 {
        return Err(format!("body too small ({} bytes)", bytes.len()));
    }

    if let Some(parent) = out_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = out_path.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write: {}", e))?;
    std::fs::rename(&tmp, out_path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// Public Piped / Invidious instances — proxy stream URLs (avoids googlevideo 403 / PO token).
const YT_PROXY_APIS: &[&str] = &[
    "https://pipedapi.adminforge.de",
    "https://pipedapi.nosebs.ru",
    "https://api.piped.private.coffee",
    "https://pipedapi.darkness.services",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.syncpundit.io",
    "https://pipedapi.leptons.xyz",
    "https://invidious.nerdvpn.de",
    "https://inv.nadeko.net",
    "https://yewtu.be",
    "https://invidious.fdn.fr",
    "https://yt.artemislena.eu",
];

/// Download YouTube audio via Piped or Invidious JSON APIs (works on Android without yt-dlp).
async fn resolve_youtube_via_proxy_apis(
    cache_dir: &Path,
    video_id: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        )
        // Keep short — this is a last resort after yt-dlp/rusty.
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last = String::new();
    // Prefer a small set so fallback finishes quickly on Android.
    let bases: &[&str] = if cfg!(target_os = "android") {
        &[
            "https://pipedapi.adminforge.de",
            "https://api.piped.private.coffee",
            "https://inv.nadeko.net",
            "https://invidious.nerdvpn.de",
        ]
    } else {
        YT_PROXY_APIS
    };

    for base in bases {
        let base = base.trim_end_matches('/');
        // Piped: /streams/{id}  |  Invidious: /api/v1/videos/{id}
        let urls = [
            format!("{}/streams/{}", base, video_id),
            format!("{}/api/v1/videos/{}", base, video_id),
        ];

        for api_url in urls {
            let res = match client.get(&api_url).header("Accept", "application/json").send().await {
                Ok(r) => r,
                Err(e) => {
                    push_err(&mut last, format!("{}: {}", base, e));
                    continue;
                }
            };
            if !res.status().is_success() {
                push_err(
                    &mut last,
                    format!("{} → HTTP {}", api_url, res.status()),
                );
                continue;
            }
            let json: serde_json::Value = match res.json().await {
                Ok(j) => j,
                Err(e) => {
                    push_err(&mut last, format!("{} parse: {}", base, e));
                    continue;
                }
            };

            let stream = pick_proxy_audio_url(&json);
            let Some((audio_url, ext)) = stream else {
                push_err(&mut last, format!("{}: no audioStreams", base));
                continue;
            };

            let out_path = cache_dir.join(format!("{}.{}", video_id, ext));
            let _ = std::fs::remove_file(&out_path);
            println!(
                "YouTube: proxy download via {} → {}",
                base,
                &audio_url[..std::cmp::min(audio_url.len(), 80)]
            );
            match download_url_to_file(&audio_url, &out_path).await {
                Ok(()) if file_big_enough(&out_path) => {
                    println!(
                        "YouTube: proxy saved {:?} ({} bytes)",
                        out_path,
                        std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0)
                    );
                    return Ok(crate::path_util::path_to_file_uri(&out_path));
                }
                Ok(()) => {
                    let _ = std::fs::remove_file(&out_path);
                    push_err(&mut last, format!("{}: file too small", base));
                }
                Err(e) => push_err(&mut last, format!("{} download: {}", base, e)),
            }
        }
    }

    Err(if last.is_empty() {
        "all Piped/Invidious proxies failed".into()
    } else {
        last.chars().take(280).collect()
    })
}

fn pick_proxy_audio_url(json: &serde_json::Value) -> Option<(String, String)> {
    // Piped: audioStreams[{url, mimeType, quality}]
    // Invidious: adaptiveFormats[{url, type, container}] + formatStreams
    let mut candidates: Vec<(i32, String, String)> = Vec::new();

    if let Some(arr) = json.get("audioStreams").and_then(|v| v.as_array()) {
        for item in arr {
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() {
                continue;
            }
            let mime = item
                .get("mimeType")
                .or_else(|| item.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            let ext = if mime.contains("mp4") || mime.contains("m4a") {
                "m4a"
            } else if mime.contains("webm") {
                "webm"
            } else if mime.contains("mpeg") || mime.contains("mp3") {
                "mp3"
            } else {
                "m4a"
            };
            let bitrate = item
                .get("bitrate")
                .and_then(|v| v.as_u64())
                .or_else(|| {
                    item.get("quality")
                        .and_then(|v| v.as_str())
                        .and_then(|q| q.trim_end_matches(" kbps").parse().ok())
                })
                .unwrap_or(0) as i32;
            let rank = if ext == "m4a" { 100_000 } else { 0 } + bitrate;
            candidates.push((rank, url, ext.to_string()));
        }
    }

    if let Some(arr) = json.get("adaptiveFormats").and_then(|v| v.as_array()) {
        for item in arr {
            let typ = item
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if !typ.starts_with("audio/") {
                continue;
            }
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() {
                continue;
            }
            let ext = if typ.contains("mp4") {
                "m4a"
            } else if typ.contains("webm") {
                "webm"
            } else {
                "m4a"
            };
            let bitrate = item
                .get("bitrate")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok())
                .or_else(|| item.get("bitrate").and_then(|v| v.as_u64()))
                .unwrap_or(0) as i32;
            let rank = if ext == "m4a" { 100_000 } else { 0 } + bitrate;
            candidates.push((rank, url, ext.to_string()));
        }
    }

    // Progressive muxed (itag 18) — last resort but often works
    if let Some(arr) = json.get("formatStreams").and_then(|v| v.as_array()) {
        for item in arr {
            let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if url.is_empty() {
                continue;
            }
            let container = item
                .get("container")
                .and_then(|v| v.as_str())
                .unwrap_or("mp4")
                .to_lowercase();
            let ext = if container.contains("mp4") { "mp4" } else { "webm" };
            candidates.push((1, url, ext.to_string()));
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates
        .into_iter()
        .next()
        .map(|(_, url, ext)| (url, ext))
}

/// Resolve a YouTube search query → download best-matching hit → local file URI.
/// When `want_title` / `want_artist` / `want_duration_ms` are set (Spotify hybrid),
/// scores the top results instead of blindly taking the first video.
pub async fn resolve_youtube_search(app: &AppHandle, query: &str) -> Result<String, String> {
    resolve_youtube_search_matched(app, query, None, None, None).await
}

pub async fn resolve_youtube_search_matched(
    app: &AppHandle,
    query: &str,
    want_title: Option<&str>,
    want_artist: Option<&str>,
    want_duration_ms: Option<u64>,
) -> Result<String, String> {
    println!(
        "YouTube Search: Resolving '{}' (match title={:?} artist={:?} dur={:?})",
        query, want_title, want_artist, want_duration_ms
    );

    let candidates = scrape_youtube_search_candidates(query, 12).await;
    let video_id = match candidates {
        Ok(list) if !list.is_empty() => {
            let best = pick_best_youtube_match(&list, want_title, want_artist, want_duration_ms);
            println!(
                "YouTube Search: picked '{}' score={} title='{}' channel='{}'",
                best.id, best.score, best.title, best.channel
            );
            best.id
        }
        Ok(_) => {
            return Err(format!("YouTube Search: No video results for '{}'", query));
        }
        Err(e) => {
            println!("YouTube Search: Scrape failed: {}", e);
            String::new()
        }
    };

    if !video_id.is_empty() {
        let video_url = format!("https://www.youtube.com/watch?v={}", video_id);
        match resolve_youtube_download(app, &video_url).await {
            Ok(uri) => return Ok(uri),
            Err(e) => println!("YouTube Search: download failed for '{}': {}", video_id, e),
        }
    }

    if crate::process_util::find_ytdlp().is_ok() {
        println!("YouTube Search: yt-dlp ytsearch1 download fallback...");
        let search_url = format!("ytsearch1:{}", query);
        return resolve_youtube_download(app, &search_url).await;
    }

    Err(format!("YouTube Search: no results for '{}'", query))
}

#[derive(Clone, Debug)]
struct YtSearchHit {
    id: String,
    title: String,
    channel: String,
    length_secs: u64,
    score: i32,
}

async fn scrape_youtube_search_candidates(
    query: &str,
    limit: usize,
) -> Result<Vec<YtSearchHit>, String> {
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

    let mut out = Vec::new();
    if let Some(sections) = contents {
        for s in sections {
            let Some(items) = s
                .pointer("/itemSectionRenderer/contents")
                .and_then(|c| c.as_array())
            else {
                continue;
            };
            for item in items {
                let Some(id) = item
                    .pointer("/videoRenderer/videoId")
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                let title = item
                    .pointer("/videoRenderer/title/runs/0/text")
                    .or_else(|| item.pointer("/videoRenderer/title/simpleText"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let channel = item
                    .pointer("/videoRenderer/ownerText/runs/0/text")
                    .or_else(|| item.pointer("/videoRenderer/longBylineText/runs/0/text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let length = item
                    .pointer("/videoRenderer/lengthText/simpleText")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let length_secs = parse_yt_length_secs(length);
                // Skip Shorts / teasers
                if length_secs > 0 && length_secs < 90 {
                    continue;
                }
                out.push(YtSearchHit {
                    id: id.to_string(),
                    title,
                    channel,
                    length_secs,
                    score: 0,
                });
                if out.len() >= limit {
                    break;
                }
            }
            if out.len() >= limit {
                break;
            }
        }
    }

    if out.is_empty() {
        return Err(format!("YouTube Search: No video results for '{}'", query));
    }
    Ok(out)
}

fn pick_best_youtube_match(
    hits: &[YtSearchHit],
    want_title: Option<&str>,
    want_artist: Option<&str>,
    want_duration_ms: Option<u64>,
) -> YtSearchHit {
    // No hints → first non-short (legacy Browse/YouTube behavior)
    if want_title.is_none() && want_artist.is_none() && want_duration_ms.is_none() {
        return hits[0].clone();
    }

    let title_n = normalize_match_text(want_title.unwrap_or(""));
    let artist_n = normalize_match_text(want_artist.unwrap_or(""));
    let want_secs = want_duration_ms.map(|ms| ms / 1000).filter(|&s| s >= 30);

    let mut scored: Vec<YtSearchHit> = hits
        .iter()
        .map(|h| {
            let mut out = h.clone();
            out.score = score_youtube_hit(h, &title_n, &artist_n, want_secs);
            out
        })
        .collect();
    scored.sort_by(|a, b| b.score.cmp(&a.score));
    scored.into_iter().next().unwrap_or_else(|| hits[0].clone())
}

fn normalize_match_text(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() || ch.is_whitespace() {
            out.push(ch);
        } else {
            out.push(' ');
        }
    }
    // Drop noisy phrases after normalization
    let mut cleaned = out;
    for noise in [
        "official audio",
        "official video",
        "official music video",
        "music video",
        "lyric video",
        "lyrics",
        "audio",
        "hd",
        "hq",
        "4k",
        "remastered",
        "remaster",
        "visualizer",
        "topic",
        "from the soundtrack",
        "original motion picture soundtrack",
    ] {
        cleaned = cleaned.replace(noise, " ");
    }
    cleaned
        .split_whitespace()
        .filter(|w| {
            !matches!(
                *w,
                "feat" | "ft" | "featuring" | "official" | "video" | "audio" | "lyrics" | "lyric"
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn token_overlap_score(hay: &str, needle: &str) -> i32 {
    if needle.is_empty() {
        return 0;
    }
    let tokens: Vec<&str> = needle
        .split_whitespace()
        .filter(|t| t.len() > 1)
        .collect();
    if tokens.is_empty() {
        return 0;
    }
    let mut hit = 0i32;
    for t in &tokens {
        if hay.contains(t) {
            hit += 1;
        }
    }
    // Require majority of tokens for a strong match signal
    let ratio = hit as f32 / tokens.len() as f32;
    (ratio * 40.0) as i32 + if hit == tokens.len() as i32 { 20 } else { 0 }
}

fn score_youtube_hit(
    hit: &YtSearchHit,
    want_title: &str,
    want_artist: &str,
    want_secs: Option<u64>,
) -> i32 {
    let yt_title = normalize_match_text(&hit.title);
    let yt_channel = normalize_match_text(&hit.channel);
    let combined = format!("{} {}", yt_title, yt_channel);

    let mut score = 0i32;
    score += token_overlap_score(&yt_title, want_title);
    score += token_overlap_score(&combined, want_artist);

    let raw_title_l = hit.title.to_lowercase();
    let raw_ch_l = hit.channel.to_lowercase();

    if raw_ch_l.contains(" - topic") || raw_ch_l.ends_with("topic") {
        score += 35; // YouTube Music auto-official
    }
    if raw_title_l.contains("official audio") {
        score += 25;
    } else if raw_title_l.contains("official music video") || raw_title_l.contains("official video")
    {
        score += 15;
    }

    // Wrong-song traps
    for bad in [
        "karaoke",
        "cover",
        "nightcore",
        "sped up",
        "slowed",
        "8d audio",
        "reaction",
        "mashup",
        "remix",
        "live at",
        "concert",
        "instrumental",
        "piano version",
    ] {
        if raw_title_l.contains(bad) && !want_title.contains(bad) {
            score -= 45;
        }
    }

    if let Some(want) = want_secs {
        if hit.length_secs > 0 {
            let diff = (hit.length_secs as i64 - want as i64).unsigned_abs();
            if diff <= 8 {
                score += 30;
            } else if diff <= 20 {
                score += 15;
            } else if diff <= 45 {
                score += 5;
            } else if diff > 90 {
                score -= 40; // clearly different length = likely wrong track
            }
        }
    }

    score
}

/// Clean Spotify title/artist for YouTube search (drop "From Album", feat. noise).
pub fn clean_spotify_query_part(s: &str) -> String {
    let mut t = s.trim().to_string();
    let lower = t.to_lowercase();
    for marker in ["(from ", "[from "] {
        if let Some(i) = lower.find(marker) {
            t.truncate(i);
            break;
        }
    }
    let lower = t.to_lowercase();
    for sep in [" (feat.", " (ft.", " (with ", " feat.", " ft."] {
        if let Some(j) = lower.find(sep) {
            t.truncate(j);
            break;
        }
    }
    t.split_whitespace().collect::<Vec<_>>().join(" ")
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
            match resolve_youtube_search_matched(
                app,
                &query,
                Some(title.as_str()),
                Some(artist.as_str()),
                None,
            )
            .await
            {
                Ok(yt) => {
                    println!("SoundCloud: YouTube fallback OK");
                    return Ok(yt);
                }
                Err(e) => println!("SoundCloud: YouTube fallback failed: {}", e),
            }
        }
    }

    // Prefer progressive HTTP audio. If we only got HLS, fall back to YouTube by title/artist.
    if stream_url.contains(".m3u8") || stream_url.contains("/playlist/") {
        if let Ok((title, artist)) = crate::aggregator::soundcloud::fetch_title_artist(url).await {
            let query = format!("{} {}", artist, title).trim().to_string();
            return resolve_youtube_search_matched(
                app,
                &query,
                Some(title.as_str()),
                Some(artist.as_str()),
                None,
            )
            .await
            .map_err(|e| {
                format!("SoundCloud: HLS-only and YouTube proxy fallback failed ({e})")
            });
        }
        return Err(
            "SoundCloud: only HLS available and CDN streaming is broken — no title for YouTube fallback"
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
                resolve_youtube_search_matched(
                    app,
                    &query,
                    Some(title.as_str()),
                    Some(artist.as_str()),
                    None,
                )
                .await
                .map_err(|yt_e| {
                    format!("SoundCloud play failed (direct: {e}; YouTube proxy: {yt_e})")
                })
            } else {
                Err(format!(
                    "SoundCloud play failed: {e} (no title/artist for YouTube fallback)"
                ))
            }
        }
    }
}
