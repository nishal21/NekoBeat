use regex::Regex;
use serde_json::Value;
use lazy_static::lazy_static;
use reqwest::Client;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::aggregator::search::ExternalTrack;

lazy_static! {
    static ref CLIENT_ID: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
}

pub async fn get_client_id() -> Result<String, String> {
    // Check cache first
    let mut guard = CLIENT_ID.lock().await;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }

    let client = Client::new();
    let home_res = client.get("https://soundcloud.com")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;

    // Find all script tags pointing to a-v2.sndcdn.com/assets
    let script_re = Regex::new(r#"src="(https://a-v2\.sndcdn\.com/assets/[^"]+)""#).unwrap();
    let mut script_urls: Vec<String> = script_re.captures_iter(&home_res)
        .map(|cap| cap[1].to_string())
        .collect();
    
    // Reverse to check the most recent scripts first
    script_urls.reverse();

    if script_urls.is_empty() {
        return Err("Could not find any SoundCloud asset script URLs".to_string());
    }

    let client_id_re = Regex::new(r#"client_id[:=]\s*["']([a-zA-Z0-9]{32})["']"#).unwrap();

    for script_url in script_urls {
        println!("SoundCloud: Checking script for client_id: {}", script_url);
        if let Ok(resp) = client.get(&script_url).send().await {
            if let Ok(script_res) = resp.text().await {
                if let Some(cap) = client_id_re.captures(&script_res) {
                    let id = cap[1].to_string();
                    println!("SoundCloud: Found client_id: {}", id);
                    *guard = Some(id.clone());
                    return Ok(id);
                }
            }
        }
    }

    Err("Could not extract client_id from any script".to_string())
}

pub async fn search(query: &str) -> Result<Vec<ExternalTrack>, String> {
    let client_id = get_client_id().await?;
    let url = format!("https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit=15", urlencoding::encode(query), client_id);

    let client = Client::new();
    let res: Value = client.get(&url)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let mut tracks = Vec::new();

    if let Some(collection) = res["collection"].as_array() {
        for item in collection {
            if let Some(id) = item["id"].as_i64() {
                let title = item["title"].as_str().unwrap_or("Unknown Title").to_string();
                let artist = item["user"]["username"].as_str().unwrap_or("Unknown Artist").to_string();
                let duration_ms = item["duration"].as_u64().unwrap_or(0);
                
                let mut artwork_url = item["artwork_url"].as_str()
                    .unwrap_or("").to_string();
                if artwork_url.contains("large.jpg") {
                    artwork_url = artwork_url.replace("large.jpg", "t500x500.jpg");
                }

                tracks.push(ExternalTrack {
                    id: format!("sc-{}", id),
                    title,
                    artist,
                    album: "SoundCloud".to_string(),
                    duration_ms,
                    artwork_url,
                    source: "soundcloud".to_string(),
                    stream_url: None,
                });
            }
        }
    }

    Ok(tracks)
}

pub async fn resolve(url: &str) -> Result<String, String> {
    let client_id = get_client_id().await?;
    let client = Client::new();

    // Extract the track ID from different URL formats
    let track_id = if url.contains("/tracks/") {
        url.split("/tracks/").last()
            .and_then(|s| s.split('?').next())
            .unwrap_or("")
            .to_string()
    } else if url.contains("soundcloud.com") {
        // Resolve the permalink to get the track ID
        let resolve_url = format!(
            "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
            urlencoding::encode(url), client_id
        );
        let track_data: Value = client.get(&resolve_url)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        track_data["id"].as_i64()
            .map(|id| id.to_string())
            .ok_or("Could not resolve track ID from permalink")?
    } else {
        return Err("Invalid SoundCloud URL".to_string());
    };

    println!("SoundCloud: Resolving track ID: {}", track_id);

    // Strategy 1: Use /tracks/{id}/streams (like Muffon) — returns direct MP3
    let streams_url = format!(
        "https://api-v2.soundcloud.com/tracks/{}/streams?client_id={}",
        track_id, client_id
    );
    
    let streams_resp = client.get(&streams_url)
        .send().await.map_err(|e| e.to_string())?;

    if streams_resp.status().is_success() {
        let streams_data: Value = streams_resp.json().await.map_err(|e| e.to_string())?;
        
        // Try http_mp3_128_url first (direct MP3 — what Muffon uses)
        if let Some(mp3_url) = streams_data["http_mp3_128_url"].as_str() {
            println!("SoundCloud: Found Strategy 1 (direct MP3): {}", &mp3_url[..std::cmp::min(mp3_url.len(), 50)]);
            return Ok(mp3_url.to_string());
        }
        // Try hls_mp3_128_url as second option
        if let Some(hls_url) = streams_data["hls_mp3_128_url"].as_str() {
            println!("SoundCloud: Found HLS option in /streams: {}", &hls_url[..std::cmp::min(hls_url.len(), 50)]);
            // We don't want HLS, fall through to Strategy 2
            let _ = hls_url;
        }
    } else {
        println!("SoundCloud: /streams endpoint returned {}, trying transcodings fallback", streams_resp.status());
    }

    // Strategy 2: Fallback to /media/transcodings — filter for progressive MP3 only
    let track_url = format!(
        "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
        track_id, client_id
    );
    let track_data: Value = client.get(&track_url)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let transcodings = track_data["media"]["transcodings"].as_array()
        .ok_or("No media transcodings found")?;

    // Only accept progressive protocol with audio/mpeg mime type
    let mut progressive_url = None;
    let mut hls_mpeg_url = None;
    for tc in transcodings {
        let protocol = tc["format"]["protocol"].as_str().unwrap_or("");
        let mime = tc["format"]["mime_type"].as_str().unwrap_or("");
        println!("SoundCloud transcoding: protocol={}, mime={}", protocol, mime);
        
        if protocol == "progressive" && mime.contains("mpeg") {
            if let Some(url) = tc["url"].as_str() {
                progressive_url = Some(url.to_string());
                break;
            }
        }
        // Collect HLS with audio/mpeg as fallback
        if protocol == "hls" && mime == "audio/mpeg" && hls_mpeg_url.is_none() {
            if let Some(url) = tc["url"].as_str() {
                hls_mpeg_url = Some(url.to_string());
            }
        }
    }

    // Try progressive first
    if let Some(prog_url) = progressive_url {
        let stream_auth_url = format!("{}?client_id={}", prog_url, client_id);
        let stream_response: Value = client.get(&stream_auth_url)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if let Some(actual_url) = stream_response["url"].as_str() {
            println!("SoundCloud: Found Strategy 2 (progressive): {}", &actual_url[..std::cmp::min(actual_url.len(), 50)]);
            return Ok(actual_url.to_string());
        }
    }

    // Fallback: HLS audio/mpeg — download the .m3u8 playlist and concatenate MP3 segments
    if let Some(hls_url) = hls_mpeg_url {
        println!("SoundCloud: Using Strategy 3 (HLS assembly)...");
        let stream_auth_url = format!("{}?client_id={}", hls_url, client_id);
        let stream_response: Value = client.get(&stream_auth_url)
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;

        if let Some(m3u8_url) = stream_response["url"].as_str() {
            let m3u8_text = client.get(m3u8_url)
                .send().await.map_err(|e| e.to_string())?
                .text().await.map_err(|e| e.to_string())?;

            // Parse segment URLs from the .m3u8 playlist
            let segment_urls: Vec<&str> = m3u8_text
                .lines()
                .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
                .collect();

            println!("SoundCloud: Found {} HLS segments to download for assembly", segment_urls.len());
            
            if segment_urls.is_empty() {
                return Err("SoundCloud: HLS playlist is empty".to_string());
            }

            // Download all segments and concatenate into one MP3 buffer
            let mut full_mp3 = Vec::new();
            for (i, seg_url) in segment_urls.iter().enumerate() {
                match client.get(*seg_url).send().await {
                    Ok(resp) => {
                        if resp.status().is_success() {
                            if let Ok(bytes) = resp.bytes().await {
                                full_mp3.extend_from_slice(&bytes);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("SoundCloud: Failed to download segment {}: {}", i, e);
                    }
                }
            }

            if !full_mp3.is_empty() {
                // Write to a temp file that the audio engine can stream from
                let temp_dir = std::env::temp_dir();
                let temp_path = temp_dir.join(format!("nekobeat_sc_{}.mp3", track_id));
                std::fs::write(&temp_path, &full_mp3)
                    .map_err(|e| format!("Failed to write temp MP3: {}", e))?;
                
                println!("SoundCloud: Successfully assembled {} bytes -> {:?}", full_mp3.len(), temp_path);
                return Ok(format!("file://{}", temp_path.to_string_lossy()));
            }
        }
    }

    Err("No playable stream format found (tried /streams, progressive, and HLS fallback)".to_string())
}
