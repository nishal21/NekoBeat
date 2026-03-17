use serde::Serialize;
use rusty_ytdl::search::{YouTube, SearchOptions, SearchResult};

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
pub async fn search_external(app: tauri::AppHandle, query: String, source: String) -> Result<Vec<ExternalTrack>, String> {
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
        return crate::aggregator::soundcloud::search(&query).await;
    }

    let youtube = YouTube::new().map_err(|e| e.to_string())?;
    
    let options = SearchOptions {
        limit: 10,
        ..Default::default()
    };

    let results = youtube.search(query, Some(&options)).await.map_err(|e| e.to_string())?;
    
    let mut tracks = Vec::new();

    for result in results {
        if let SearchResult::Video(video) = result {
            // Sanitize artist name: Remove " - Topic" which is common for YouTube music channels
            let artist = video.channel.name.replace(" - Topic", "")
                .replace(" - TOPIC", "")
                .trim()
                .to_string();

            tracks.push(ExternalTrack {
                id: format!("yt-{}", video.id),
                title: video.title,
                artist,
                album: "YouTube".to_string(),
                duration_ms: video.duration as u64, // rusty_ytdl returns ms
                artwork_url: video.thumbnails.first().map(|t| t.url.clone()).unwrap_or_default(),
                source: "youtube".to_string(),
                stream_url: None,
            });
        }
    }

    Ok(tracks)
}
