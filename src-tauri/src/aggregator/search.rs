use serde::Serialize;
use serde_json::Value;
use crate::sidecar_util::{self, METADATA_TIMEOUT};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::sidecar_util::SEARCH_TIMEOUT;

#[derive(Serialize)]
pub struct ExternalTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub artwork_url: String,
    pub source: String,
    pub stream_url: Option<String>,
}

#[tauri::command]
pub async fn search_external(app: tauri::AppHandle, query: String, source: String, page: Option<u32>) -> Result<Vec<ExternalTrack>, String> {
    let page = page.unwrap_or(0);
        if query.contains("spotify.com/track/") {
        let mut title = "Play Spotify Track".to_string();
        let mut artist = "Spotify".to_string();
        let mut artwork_url = "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg".to_string();

        if let Ok(output) =
            sidecar_util::run_sidecar(&app, &[&query, "METADATA"], METADATA_TIMEOUT).await
        {
            let out_str = String::from_utf8_lossy(&output.stdout);
            let json_str = sidecar_util::last_json_line(&output.stdout);
            if !json_str.is_empty() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                    if let Some(t) = json["title"].as_str() {
                        title = t.to_string();
                    }
                    if let Some(a) = json["artist"].as_str() {
                        artist = a.to_string();
                    }
                    if let Some(img) = json["cover"].as_str() {
                        artwork_url = img.to_string();
                    }
                }
            } else if let Some(json_start) = out_str.find('{') {
                let json_str = &out_str[json_start..];
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(t) = json["title"].as_str() {
                        title = t.to_string();
                    }
                    if let Some(a) = json["artist"].as_str() {
                        artist = a.to_string();
                    }
                    if let Some(img) = json["cover"].as_str() {
                        artwork_url = img.to_string();
                    }
                }
            }
        }

        let mut tracks = Vec::new();
        tracks.push(ExternalTrack {
            id: format!("sp-{}", query),
            title,
            artist,
            album: "Spotify".to_string(),
            duration_ms: 0,
            artwork_url,
            source: "spotify".to_string(),
            stream_url: Some(query.clone()),
        });
        return Ok(tracks);
    }

    if source == "soundcloud" {
        return crate::aggregator::soundcloud::search(&query, page).await;
    }

    if source == "spotify" {
        return search_spotify(&app, &query, page).await;
    }

    search_youtube(&query, page).await
}

/// Parse a YouTube duration string like "3:45" or "1:02:30" into milliseconds
fn parse_yt_duration(s: &str) -> u64 {
    let parts: Vec<u64> = s.split(':').filter_map(|p| p.parse().ok()).collect();
    match parts.len() {
        1 => parts[0] * 1000,
        2 => (parts[0] * 60 + parts[1]) * 1000,
        3 => (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000,
        _ => 0,
    }
}

/// Search YouTube by scraping the search results page HTML for ytInitialData JSON.
/// This bypasses rusty_ytdl's broken search parser entirely.
async fn search_youtube(query: &str, page: u32) -> Result<Vec<ExternalTrack>, String> {
    let per_page = 25usize;
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
        .text().await.map_err(|e| format!("YouTube search body read failed: {}", e))?;

    // Extract ytInitialData JSON from the HTML
    let marker = "var ytInitialData = ";
    let start = html.find(marker)
        .ok_or_else(|| "YouTube search: could not find ytInitialData in page".to_string())?;
    let json_start = start + marker.len();
    let json_end = html[json_start..].find(";</script>")
        .ok_or_else(|| "YouTube search: could not find end of ytInitialData".to_string())?;
    let json_str = &html[json_start..json_start + json_end];

    let data: Value = serde_json::from_str(json_str)
        .map_err(|e| format!("YouTube search: failed to parse ytInitialData: {}", e))?;

    // Navigate the deeply nested YouTube response structure
    let contents = data
        .pointer("/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents")
        .and_then(|c| c.as_array());

    let items = contents
        .and_then(|sections| {
            sections.iter().find_map(|s| {
                s.pointer("/itemSectionRenderer/contents").and_then(|c| c.as_array())
            })
        });

    let mut tracks = Vec::new();
    let skip = page as usize * per_page;

    if let Some(items) = items {
        for item in items {
            if let Some(renderer) = item.get("videoRenderer") {
                let video_id = renderer["videoId"].as_str().unwrap_or_default();
                if video_id.is_empty() { continue; }

                let title = renderer.pointer("/title/runs/0/text")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string();

                let artist = renderer.pointer("/ownerText/runs/0/text")
                    .and_then(|a| a.as_str())
                    .unwrap_or("Unknown")
                    .replace(" - Topic", "")
                    .replace(" - TOPIC", "")
                    .trim()
                    .to_string();

                let duration_text = renderer.pointer("/lengthText/simpleText")
                    .and_then(|d| d.as_str())
                    .unwrap_or("0:00");
                let duration_ms = parse_yt_duration(duration_text);

                let artwork_url = renderer.pointer("/thumbnail/thumbnails")
                    .and_then(|t| t.as_array())
                    .and_then(|arr| arr.last())
                    .and_then(|t| t["url"].as_str())
                    .map(|u| {
                        if u.starts_with("//") {
                            format!("https:{}", u)
                        } else if u.starts_with("http") {
                            u.to_string()
                        } else {
                            format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id)
                        }
                    })
                    .unwrap_or_else(|| {
                        format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", video_id)
                    });

                tracks.push(ExternalTrack {
                    id: format!("yt-{}", video_id),
                    title,
                    artist,
                    album: "YouTube".to_string(),
                    duration_ms,
                    artwork_url,
                    source: "youtube".to_string(),
                    stream_url: None,
                });
            }
        }
    }

    // Handle pagination by skipping already-seen results
    if skip >= tracks.len() {
        return Ok(Vec::new());
    }
    let paged = tracks.into_iter().skip(skip).take(per_page).collect();
    Ok(paged)
}

async fn search_spotify(app: &tauri::AppHandle, query: &str, page: u32) -> Result<Vec<ExternalTrack>, String> {
    println!("Spotify: Searching for: {}", query);
    let offset = page * 20;

    // In-process web search first on mobile (no Go exec). Desktop tries CLI then web.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        return spotify_web_to_tracks(query, offset).await;
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let search_arg = if offset > 0 {
            format!("SEARCH:{}", offset)
        } else {
            "SEARCH".to_string()
        };

        match sidecar_util::run_sidecar(app, &[query, &search_arg], SEARCH_TIMEOUT).await {
            Ok(output) => {
                let json_str = sidecar_util::last_json_line(&output.stdout);
                if !json_str.is_empty() {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        if parsed["success"].as_bool() == Some(true) {
                            let mut tracks = Vec::new();
                            if let Some(results) = parsed["tracks"].as_array() {
                                for item in results {
                                    let id = item["id"].as_str().unwrap_or("").to_string();
                                    let name = item["name"].as_str().unwrap_or("Unknown").to_string();
                                    let artists =
                                        item["artists"].as_str().unwrap_or("Unknown Artist").to_string();
                                    let album = item["album_name"].as_str().unwrap_or("").to_string();
                                    let cover = item["images"].as_str().unwrap_or("").to_string();
                                    let duration_ms = item["duration_ms"].as_u64().unwrap_or(0);
                                    let external_url =
                                        item["external_urls"].as_str().unwrap_or("").to_string();
                                    if id.is_empty() {
                                        continue;
                                    }
                                    tracks.push(ExternalTrack {
                                        id: format!("sp-{}", id),
                                        title: name,
                                        artist: artists,
                                        album,
                                        duration_ms,
                                        artwork_url: cover,
                                        source: "spotify".to_string(),
                                        stream_url: if external_url.is_empty() {
                                            Some(format!("https://open.spotify.com/track/{}", id))
                                        } else {
                                            Some(external_url)
                                        },
                                    });
                                }
                            }
                            if !tracks.is_empty() {
                                println!(
                                    "Spotify: Found {} tracks via CLI for '{}'",
                                    tracks.len(),
                                    query
                                );
                                return Ok(tracks);
                            }
                        }
                    }
                }
                println!("Spotify: CLI empty — trying in-process web search");
            }
            Err(e) => println!("Spotify: CLI failed ({}) — web search", e),
        }

        spotify_web_to_tracks(query, offset).await
    }
}

async fn spotify_web_to_tracks(query: &str, offset: u32) -> Result<Vec<ExternalTrack>, String> {
    let hits = match crate::aggregator::spotify_web::search_tracks(query, 20, offset).await {
        Ok(h) => h,
        Err(e) => {
            // Soft-skip so Browse "all" still shows YouTube / SoundCloud.
            eprintln!("Spotify web search soft-skip: {}", e);
            return Err(format!("soft-skip: {}", e));
        }
    };
    let tracks: Vec<ExternalTrack> = hits
        .into_iter()
        .map(|h| ExternalTrack {
            id: format!("sp-{}", h.id),
            title: h.title,
            artist: h.artist,
            album: h.album,
            duration_ms: h.duration_ms,
            artwork_url: h.artwork_url,
            source: "spotify".to_string(),
            stream_url: Some(h.external_url),
        })
        .collect();
    if tracks.is_empty() {
        return Err(format!("soft-skip: No Spotify results for '{}'", query));
    }
    println!("Spotify: Found {} tracks via web for '{}'", tracks.len(), query);
    Ok(tracks)
}
