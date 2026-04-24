use serde::Serialize;
use serde_json::Value;

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

        use tauri_plugin_shell::ShellExt;
        if let Ok(cmd) = app.shell().sidecar("spotiflac-cli") {
            if let Ok(output) = cmd.args([&query, "METADATA"]).output().await {
                if let Ok(out_str) = String::from_utf8(output.stdout) {
                    if let Some(json_start) = out_str.find('{') {
                        let json_str = &out_str[json_start..];
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if let Some(t) = json["title"].as_str() { title = t.to_string(); }
                            if let Some(a) = json["artist"].as_str() { artist = a.to_string(); }
                            if let Some(img) = json["cover"].as_str() { artwork_url = img.to_string(); }
                        }
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
                    .unwrap_or_default()
                    .to_string();

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
    use tauri_plugin_shell::ShellExt;

    println!("Spotify: Searching for: {}", query);

    let cmd = app.shell().sidecar("spotiflac-cli")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?;

    let offset = page * 20;
    let search_arg = if offset > 0 {
        format!("SEARCH:{}", offset)
    } else {
        "SEARCH".to_string()
    };
    let output = cmd.args([query, &search_arg]).output().await
        .map_err(|e| format!("Spotify search failed: {}", e))?;

    let out_str = String::from_utf8_lossy(&output.stdout);

    // Find JSON in output (skip any debug lines)
    let json_str = out_str.lines()
        .filter(|l| l.trim().starts_with('{'))
        .last()
        .unwrap_or("");

    if json_str.is_empty() {
        return Err("No JSON output from Spotify search".to_string());
    }

    let parsed: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Failed to parse Spotify search JSON: {}", e))?;

    if parsed["success"].as_bool() != Some(true) {
        let err_msg = parsed["error"].as_str().unwrap_or("Unknown error");
        return Err(format!("Spotify search error: {}", err_msg));
    }

    let mut tracks = Vec::new();
    if let Some(results) = parsed["tracks"].as_array() {
        for item in results {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let name = item["name"].as_str().unwrap_or("Unknown").to_string();
            let artists = item["artists"].as_str().unwrap_or("Unknown Artist").to_string();
            let album = item["album_name"].as_str().unwrap_or("").to_string();
            let cover = item["images"].as_str().unwrap_or("").to_string();
            let duration_ms = item["duration_ms"].as_u64().unwrap_or(0);
            let external_url = item["external_urls"].as_str().unwrap_or("").to_string();

            if id.is_empty() { continue; }

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

    println!("Spotify: Found {} tracks for '{}'", tracks.len(), query);
    Ok(tracks)
}
