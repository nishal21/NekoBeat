use rusty_ytdl::{Video, VideoOptions, VideoQuality, VideoSearchOptions, RequestOptions};
use futures::FutureExt;

pub async fn resolve_url(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    println!("Resolver: Resolving URL: {}", url);
    let result = if url.contains("youtube.com") || url.contains("youtu.be") {
        resolve_youtube(url).await
    } else if url.contains("soundcloud.com") || url.contains("api-v2.soundcloud.com") {
        resolve_soundcloud(url).await
    } else if url.contains("spotify.com") {
        crate::aggregator::spotify::resolve_spotify_url(app, url).await
    } else {
        Err(format!("Unsupported external source URL: {}", url))
    };
    match &result {
        Ok(resolved) => println!("Resolver: Successfully resolved to: {}...", &resolved[..std::cmp::min(resolved.len(), 120)]),
        Err(e) => eprintln!("Resolver: Failed: {}", e),
    }
    result
}

/// Resolve a YouTube URL to a direct audio stream URL using rusty_ytdl.
/// No external binaries needed — works on any machine, instant playback.
async fn resolve_youtube(url: &str) -> Result<String, String> {
    println!("YouTube: Resolving direct stream URL for: {}", url);

    // Build a browser-like reqwest client to avoid bot detection
    let custom_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .ok();

    // CONSENT cookie bypasses YouTube's consent wall
    let cookies_str = "CONSENT=YES+cb.20210328-17-p0.en+FX+634".to_string();

    // Only request Audio-only formats — VideoAudio (itag 18/22) gets 403'd by YouTube CDN
    let strategies: Vec<(VideoSearchOptions, &str)> = vec![
        (VideoSearchOptions::Audio, "Audio-only"),
    ];

    let mut last_err = String::from("No strategies attempted");

    for (filter, label) in &strategies {
        // Retry each strategy up to 2 times (rusty_ytdl can be flaky)
        for attempt in 1..=2 {
            let video_options = VideoOptions {
                quality: VideoQuality::HighestAudio,
                filter: filter.clone(),
                request_options: RequestOptions {
                    client: custom_client.clone(),
                    cookies: Some(cookies_str.clone()),
                    ..Default::default()
                },
                ..Default::default()
            };

            let video = match Video::new_with_options(url, video_options.clone()) {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!("YouTube: Failed to create video object: {}", e);
                    continue;
                }
            };

            let video_info = match std::panic::AssertUnwindSafe(video.get_info())
                .catch_unwind()
                .await
            {
                Ok(Ok(info)) => info,
                Ok(Err(e)) => {
                    last_err = format!("YouTube: Failed to get video info (attempt {}): {}", attempt, e);
                    println!("{}", last_err);
                    if attempt < 2 {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    }
                    continue;
                }
                Err(_) => {
                    last_err = format!("YouTube: get_info panicked (attempt {})", attempt);
                    println!("{}", last_err);
                    if attempt < 2 {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    }
                    continue;
                }
            };

            println!("YouTube: [{}] Got info for '{}', {} formats available (attempt {})",
                label,
                video_info.video_details.title,
                video_info.formats.len(),
                attempt
            );

            if video_info.formats.is_empty() {
                last_err = format!("YouTube: [{}] 0 formats on attempt {}", label, attempt);
                if attempt < 2 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                }
                continue;
            }

            // Manual format selection: pick best audio-only format with a non-empty URL
            // choose_format() often fails because many formats have empty URLs
            // that need n-parameter deciphering which rusty_ytdl can't always do
            // IMPORTANT: Only audio/* mimes — video/mp4 (itag 18/22) get 403'd by YouTube CDN
            let mut candidates: Vec<_> = video_info.formats.iter()
                .filter(|f| !f.url.is_empty())
                .filter(|f| f.mime_type.mime.to_string().starts_with("audio/"))
                .collect();

            // Sort by bitrate descending (highest quality first)
            candidates.sort_by(|a, b| b.bitrate.cmp(&a.bitrate));

            println!("YouTube: [{}] {} audio formats with non-empty URL out of {} total (attempt {})",
                label, candidates.len(), video_info.formats.len(), attempt);

            if let Some(best) = candidates.first() {
                let stream_url = best.url.clone();
                println!("YouTube: Resolved via [{}] (mime: {}, bitrate: {:?}, length: {:?})",
                    label,
                    best.mime_type.mime.to_string(),
                    best.bitrate,
                    best.content_length,
                );
                return Ok(stream_url);
            }

            last_err = format!("YouTube: [{}] no audio formats with URL (attempt {})", label, attempt);
            if attempt < 2 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
    }

    // All rusty_ytdl strategies failed — try yt-dlp as final fallback
    println!("YouTube: rusty_ytdl failed, trying yt-dlp fallback...");
    match resolve_youtube_ytdlp(url).await {
        Ok(resolved) => return Ok(resolved),
        Err(e) => {
            eprintln!("YouTube: yt-dlp fallback also failed: {}", e);
            return Err(format!("{} | yt-dlp fallback: {}", last_err, e));
        }
    }
}

/// Fallback: use bundled yt-dlp.exe to get a direct audio stream URL
async fn resolve_youtube_ytdlp(url: &str) -> Result<String, String> {
    // Find yt-dlp binary: check bundled locations
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().unwrap_or_else(|| std::path::Path::new("."));
    
    let candidates = vec![
        exe_dir.join("yt-dlp.exe"),
        exe_dir.join("bin").join("yt-dlp.exe"),
        // Bundled as resource: ends up in <install_dir>/bin/yt-dlp.exe
        exe_dir.join("resources").join("bin").join("yt-dlp.exe"),
        // Dev mode: relative to src-tauri
        std::path::PathBuf::from("bin/yt-dlp.exe"),
        std::path::PathBuf::from("src-tauri/bin/yt-dlp.exe"),
    ];

    let ytdlp_path = candidates.iter().find(|p| p.exists())
        .ok_or_else(|| "yt-dlp binary not found".to_string())?;

    println!("YouTube: Using yt-dlp at: {:?}", ytdlp_path);

    // Build strategies: tv_embedded first (most reliable), cookies as fallback
    let mut strategies: Vec<Vec<String>> = Vec::new();

    // Strategy 1: tv_embedded without cookies — usually works
    strategies.push(vec![
        "-f".into(), "bestaudio".into(), "--get-url".into(), "--no-warnings".into(),
        "--extractor-args".into(), "youtube:player_client=tv_embedded".into(),
        url.into()
    ]);

    // Strategy 2: Default without cookies
    strategies.push(vec![
        "-f".into(), "bestaudio".into(), "--get-url".into(), "--no-warnings".into(),
        url.into()
    ]);

    // Strategy 3+: cookies.txt fallback (if tv_embedded gets blocked)
    // NOTE: Do NOT put cookies.txt inside src-tauri/ — it triggers Tauri hot-reload
    let candidates_cookies = vec![
        exe_dir.join("cookies.txt"),
        std::path::PathBuf::from("../cookies.txt"),
        std::path::PathBuf::from("cookies.txt"),
    ];
    if let Some(cp) = candidates_cookies.iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string()) {
        println!("YouTube: Found cookies.txt at: {}", cp);
        strategies.push(vec![
            "-f".into(), "bestaudio".into(), "--get-url".into(), "--no-warnings".into(),
            "--cookies".into(), cp,
            url.into()
        ]);
    }

    // Strategy 4+: Browser cookies as last resort
    for browser in &["edge", "chrome"] {
        strategies.push(vec![
            "-f".into(), "bestaudio".into(), "--get-url".into(), "--no-warnings".into(),
            "--cookies-from-browser".into(), (*browser).to_string(),
            url.into()
        ]);
    }

    let mut last_stderr = String::new();
    for args in &strategies {
        let label = &args[..std::cmp::min(args.len(), 6)];
        println!("YouTube: yt-dlp trying: {:?}", label);
        
        // Use timeout to avoid hanging on browser cookie extraction
        let child = tokio::process::Command::new(ytdlp_path)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        
        let output = match child {
            Ok(c) => {
                match tokio::time::timeout(std::time::Duration::from_secs(30), c.wait_with_output()).await {
                    Ok(Ok(o)) => o,
                    Ok(Err(e)) => {
                        println!("YouTube: yt-dlp process error: {}", e);
                        continue;
                    }
                    Err(_) => {
                        println!("YouTube: yt-dlp timed out (30s), trying next strategy...");
                        continue;
                    }
                }
            }
            Err(e) => {
                println!("YouTube: yt-dlp spawn failed: {}", e);
                continue;
            }
        };

        if output.status.success() {
            let stream_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let first_url = stream_url.lines().next().unwrap_or("").to_string();
            if !first_url.is_empty() {
                println!("YouTube: yt-dlp resolved to: {}...", &first_url[..std::cmp::min(first_url.len(), 100)]);
                return Ok(first_url);
            }
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // If it's a cookie extraction error, skip silently and try next browser
        if stderr.contains("could not find") || stderr.contains("not available") || stderr.contains("Profile") {
            println!("YouTube: Browser cookie extraction failed, trying next...");
            continue;
        }
        last_stderr = stderr;
        println!("YouTube: yt-dlp strategy failed: {}", &last_stderr[..std::cmp::min(last_stderr.len(), 200)]);
    }

    Err(format!("yt-dlp error: {}", last_stderr))
}

/// Resolve a YouTube search query to a direct audio stream URL.
/// Used as Spotify fallback — searches YouTube and returns a streamable URL.
/// Scrapes YouTube HTML for video ID, then resolves stream via rusty_ytdl.
pub async fn resolve_youtube_search(query: &str) -> Result<String, String> {
    println!("YouTube Search: Resolving stream for query: '{}'", query);

    // Step 1: Find video ID by scraping YouTube search results HTML
    let scrape_result = async {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!(
            "https://www.youtube.com/results?search_query={}&sp=EgIQAQ%3D%3D",
            urlencoding::encode(query)
        );

        let html = client.get(&url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cookie", "CONSENT=YES+cb.20210328-17-p0.en+FX+634")
            .send().await.map_err(|e| format!("YouTube search request failed: {}", e))?
            .text().await.map_err(|e| e.to_string())?;

        let marker = "var ytInitialData = ";
        let start = html.find(marker).ok_or("Could not find ytInitialData")?;
        let json_start = start + marker.len();
        let json_end = html[json_start..].find(";</script>").ok_or("Could not find end of ytInitialData")?;
        let json_str = &html[json_start..json_start + json_end];

        let data: serde_json::Value = serde_json::from_str(json_str).map_err(|e| e.to_string())?;

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
                                item.pointer("/videoRenderer/videoId").and_then(|v| v.as_str()).map(|s| s.to_string())
                            })
                        })
                })
            })
            .ok_or_else(|| format!("YouTube Search: No video results for '{}'", query))?;

        Ok::<String, String>(video_id)
    }.await;

    // Step 2: Resolve stream URL from video ID
    if let Ok(video_id) = scrape_result {
        let video_url = format!("https://www.youtube.com/watch?v={}", video_id);
        println!("YouTube Search: Found video '{}', resolving stream...", video_id);
        match resolve_youtube(&video_url).await {
            Ok(url) => return Ok(url),
            Err(e) => println!("YouTube Search: resolve_youtube failed for '{}': {}", video_id, e),
        }
    } else {
        println!("YouTube Search: Scrape failed: {}", scrape_result.unwrap_err());
    }

    // Final fallback: yt-dlp with ytsearch:
    println!("YouTube Search: Trying yt-dlp fallback...");
    let search_url = format!("ytsearch1:{}", query);
    resolve_youtube_ytdlp(&search_url).await
        .map_err(|e| format!("YouTube Search: all methods failed | yt-dlp: {}", e))
}

async fn resolve_soundcloud(url: &str) -> Result<String, String> {
    crate::aggregator::soundcloud::resolve(url).await
}
