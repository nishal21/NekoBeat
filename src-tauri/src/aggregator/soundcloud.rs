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

fn append_query(base: &str, pairs: &[(&str, &str)]) -> String {
    let mut out = base.to_string();
    for (i, (k, v)) in pairs.iter().enumerate() {
        let sep = if i == 0 && !out.contains('?') { "?" } else { "&" };
        out.push_str(sep);
        out.push_str(k);
        out.push('=');
        out.push_str(v);
    }
    out
}

async fn invalidate_client_id() {
    *CLIENT_ID.lock().await = None;
}

pub async fn get_client_id() -> Result<String, String> {
    let mut guard = CLIENT_ID.lock().await;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }

    let client = Client::new();
    let home_res = client.get("https://soundcloud.com")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;

    let script_re = Regex::new(r#"src="(https://a-v2\.sndcdn\.com/assets/[^"]+)""#).unwrap();
    let mut script_urls: Vec<String> = script_re.captures_iter(&home_res)
        .map(|cap| cap[1].to_string())
        .collect();

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

async fn api_get_json(client: &Client, url: &str) -> Result<(u16, Value), String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if status == 401 || status == 403 {
        return Err(format!("AUTH:{}", status));
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", status));
    }
    let data = resp.json().await.map_err(|e| e.to_string())?;
    Ok((status, data))
}

/// Fetch JSON; on 401/403 refresh client_id once and retry with `rebuild_url`.
async fn api_get_json_fresh(
    client: &Client,
    rebuild_url: impl Fn(&str) -> String,
) -> Result<Value, String> {
    let client_id = get_client_id().await?;
    let url = rebuild_url(&client_id);
    match api_get_json(client, &url).await {
        Ok((_, data)) => Ok(data),
        Err(e) if e.starts_with("AUTH:") => {
            println!("SoundCloud: {} — refreshing client_id", e);
            invalidate_client_id().await;
            let client_id = get_client_id().await?;
            let url = rebuild_url(&client_id);
            let (_, data) = api_get_json(client, &url).await?;
            Ok(data)
        }
        Err(e) => Err(e),
    }
}

pub async fn search(query: &str, page: u32) -> Result<Vec<ExternalTrack>, String> {
    let offset = page * 25;
    let client = Client::new();
    let res = api_get_json_fresh(&client, |client_id| {
        format!(
            "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit=25&offset={}",
            urlencoding::encode(query),
            client_id,
            offset
        )
    })
    .await?;

    let mut tracks = Vec::new();
    let mut snipped = Vec::new();

    if let Some(collection) = res["collection"].as_array() {
        for item in collection {
            if let Some(id) = item["id"].as_i64() {
                let title = item["title"].as_str().unwrap_or("Unknown Title").to_string();
                let artist = item["user"]["username"].as_str().unwrap_or("Unknown Artist").to_string();
                let duration_ms = item["duration"].as_u64().unwrap_or(0);
                let policy = item["policy"].as_str().unwrap_or("ALLOW");

                let mut artwork_url = item["artwork_url"].as_str()
                    .unwrap_or("").to_string();
                if artwork_url.contains("large.jpg") {
                    artwork_url = artwork_url.replace("large.jpg", "t500x500.jpg");
                }

                let track = ExternalTrack {
                    id: format!("sc-{}", id),
                    title,
                    artist,
                    album: if policy == "SNIP" || policy == "BLOCK" {
                        format!("SoundCloud ({})", policy)
                    } else {
                        "SoundCloud".to_string()
                    },
                    duration_ms,
                    artwork_url,
                    source: "soundcloud".to_string(),
                    stream_url: None,
                };
                // Prefer fully streamable tracks ahead of geo-snipped ones.
                if policy == "SNIP" || policy == "BLOCK" {
                    snipped.push(track);
                } else {
                    tracks.push(track);
                }
            }
        }
    }

    tracks.extend(snipped);
    Ok(tracks)
}

pub async fn resolve(url: &str) -> Result<String, String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let client_id = get_client_id().await?;

    // Step 1: Get full track metadata (includes track_authorization needed for full streams)
    let track_id = if url.contains("/tracks/") {
        url.split("/tracks/").last()
            .and_then(|s| s.split('?').next())
            .and_then(|s| s.split('&').next())
            .unwrap_or("")
            .to_string()
    } else if url.contains("soundcloud.com") && !url.contains("api-v2") {
        let track_data = api_get_json_fresh(&client, |cid| {
            format!(
                "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
                urlencoding::encode(url),
                cid
            )
        })
        .await?;
        track_data["id"].as_i64()
            .map(|id| id.to_string())
            .ok_or("Could not resolve track ID from permalink".to_string())?
    } else {
        url.trim_end_matches('/').rsplit('/').next()
            .and_then(|s| s.split('?').next())
            .unwrap_or("")
            .to_string()
    };

    if track_id.is_empty() {
        return Err("SoundCloud: Could not extract track ID".to_string());
    }

    println!("SoundCloud: Resolving track ID: {}", track_id);

    let track_data = api_get_json_fresh(&client, |cid| {
        format!(
            "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
            track_id, cid
        )
    })
    .await
    .map_err(|e| format!("SoundCloud: Failed to fetch track: {}", e))?;

    // Refresh client_id after possible auth retry so stream URLs match.
    let client_id = get_client_id().await.unwrap_or(client_id);

    let track_auth = track_data["track_authorization"].as_str().unwrap_or("");

    if track_auth.is_empty() {
        println!("SoundCloud: WARNING - No track_authorization found, streams may be previews");
    } else {
        println!("SoundCloud: Got track_authorization ({}...)", &track_auth[..std::cmp::min(track_auth.len(), 20)]);
    }

    let policy = track_data["policy"].as_str().unwrap_or("ALLOW");
    let access = track_data["access"].as_str().unwrap_or("unknown");
    let monetization = track_data["monetization_model"].as_str().unwrap_or("unknown");
    let full_duration = track_data["full_duration"].as_u64().unwrap_or(0);
    let duration = track_data["duration"].as_u64().unwrap_or(0);
    println!("SoundCloud: policy={}, access={}, monetization={}, duration={}ms, full_duration={}ms",
        policy, access, monetization, duration, full_duration);

    if policy == "BLOCK" {
        return Err("SoundCloud: This track is not available for streaming in your region".to_string());
    }

    let is_snipped = policy == "SNIP";
    if is_snipped {
        println!("SoundCloud: Track is geo-blocked (SNIP). Trying proxy bypass first...");
        match resolve_via_proxy(&track_id, &client_id).await {
            Ok(url) => return Ok(url),
            Err(e) => {
                println!("SoundCloud: Proxy bypass failed: {}. Falling back to preview...", e);
            }
        }
    }

    let transcodings = track_data["media"]["transcodings"].as_array()
        .ok_or("SoundCloud: No media transcodings found")?;

    let mut progressive_url: Option<String> = None;
    let mut hls_url: Option<String> = None;
    let mut preview_fallback: Option<String> = None;

    for tc in transcodings {
        let protocol = tc["format"]["protocol"].as_str().unwrap_or("");
        let mime = tc["format"]["mime_type"].as_str().unwrap_or("");
        let tc_url = tc["url"].as_str().unwrap_or("");
        let snipped = tc["snipped"].as_bool().unwrap_or(false);
        let preset = tc["preset"].as_str().unwrap_or("unknown");
        println!("SoundCloud: transcoding: protocol={}, mime={}, snipped={}, preset={}, url_len={}",
            protocol, mime, snipped, preset, tc_url.len());

        if protocol == "progressive" && mime.contains("mpeg") && progressive_url.is_none() {
            progressive_url = Some(tc_url.to_string());
        }
        if protocol == "hls" && hls_url.is_none() {
            hls_url = Some(tc_url.to_string());
        }
    }

    let widget_url = format!(
        "https://api-widget.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/{}&format=json&client_id={}",
        track_id, client_id
    );
    println!("SoundCloud: Trying widget API...");
    if let Ok(resp) = client.get(&widget_url).send().await {
        if resp.status().is_success() {
            if let Ok(widget_data) = resp.json::<Value>().await {
                if let Some(w_transcodings) = widget_data["media"]["transcodings"].as_array() {
                    let w_track_auth = widget_data["track_authorization"].as_str().unwrap_or(track_auth);

                    for tc in w_transcodings {
                        let protocol = tc["format"]["protocol"].as_str().unwrap_or("");
                        let tc_url = tc["url"].as_str().unwrap_or("");
                        if !tc_url.is_empty() && (protocol == "progressive" || protocol == "hls") {
                            let auth_url = append_query(tc_url, &[
                                ("client_id", &client_id),
                                ("track_authorization", w_track_auth),
                            ]);
                            if let Ok(stream_resp) = client.get(&auth_url).send().await {
                                if stream_resp.status().is_success() {
                                    if let Ok(stream_data) = stream_resp.json::<Value>().await {
                                        if let Some(url) = stream_data["url"].as_str() {
                                            if !url.is_empty() && !is_preview_url(url) {
                                                println!("SoundCloud: Widget API got full {} stream!", protocol);
                                                return Ok(url.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(prog_url) = &progressive_url {
        let auth_url = append_query(prog_url, &[
            ("client_id", &client_id),
            ("track_authorization", track_auth),
        ]);
        println!("SoundCloud: Trying progressive stream...");

        match client.get(&auth_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Value>().await {
                    Ok(data) => {
                        if let Some(stream_url) = data["url"].as_str() {
                            if !stream_url.is_empty() {
                                if is_preview_url(stream_url) {
                                    println!("SoundCloud: Progressive returned PREVIEW URL, saving as fallback...");
                                    if preview_fallback.is_none() {
                                        preview_fallback = Some(stream_url.to_string());
                                    }
                                } else {
                                    println!("SoundCloud: Got progressive stream URL ({}...)", &stream_url[..std::cmp::min(stream_url.len(), 80)]);
                                    return Ok(stream_url.to_string());
                                }
                            }
                        }
                    }
                    Err(e) => println!("SoundCloud: Progressive JSON parse failed: {}", e),
                }
            }
            Ok(resp) => println!("SoundCloud: Progressive request returned status {}", resp.status()),
            Err(e) => println!("SoundCloud: Progressive request failed: {}", e),
        }
    }

    if let Some(hls_tc_url) = &hls_url {
        let auth_url = append_query(hls_tc_url, &[
            ("client_id", &client_id),
            ("track_authorization", track_auth),
        ]);
        println!("SoundCloud: Trying HLS stream...");

        match client.get(&auth_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Value>().await {
                    Ok(data) => {
                        if let Some(m3u8_url) = data["url"].as_str() {
                            if !m3u8_url.is_empty() {
                                if is_preview_url(m3u8_url) {
                                    println!("SoundCloud: HLS returned PREVIEW URL, saving as fallback...");
                                    if preview_fallback.is_none() {
                                        preview_fallback = Some(m3u8_url.to_string());
                                    }
                                } else {
                                    println!("SoundCloud: Got HLS m3u8 URL ({}...)", &m3u8_url[..std::cmp::min(m3u8_url.len(), 80)]);
                                    return Ok(m3u8_url.to_string());
                                }
                            }
                        }
                    }
                    Err(e) => println!("SoundCloud: HLS JSON parse failed: {}", e),
                }
            }
            Ok(resp) => println!("SoundCloud: HLS request returned status {}", resp.status()),
            Err(e) => println!("SoundCloud: HLS request failed: {}", e),
        }
    }

    let streams_url = format!(
        "https://api-v2.soundcloud.com/tracks/{}/streams?client_id={}",
        track_id, client_id
    );
    println!("SoundCloud: Trying legacy /streams endpoint as last resort...");

    if let Ok(resp) = client.get(&streams_url).send().await {
        if resp.status().is_success() {
            if let Ok(streams_data) = resp.json::<Value>().await {
                if let Some(mp3_url) = streams_data["http_mp3_128_url"].as_str() {
                    println!("SoundCloud: Found /streams MP3 URL (may be preview): {}...", &mp3_url[..std::cmp::min(mp3_url.len(), 60)]);
                    return Ok(mp3_url.to_string());
                }
                if let Some(hls_mp3) = streams_data["hls_mp3_128_url"].as_str() {
                    println!("SoundCloud: Found /streams HLS URL: {}...", &hls_mp3[..std::cmp::min(hls_mp3.len(), 60)]);
                    return Ok(hls_mp3.to_string());
                }
                if let Some(hls_opus) = streams_data["hls_opus_64_url"].as_str() {
                    println!("SoundCloud: Found /streams HLS Opus URL: {}...", &hls_opus[..std::cmp::min(hls_opus.len(), 60)]);
                    return Ok(hls_opus.to_string());
                }
            }
        }
    }

    if is_snipped {
        if let Some(preview_url) = preview_fallback {
            println!("SoundCloud: Track is restricted. Returning preview URL for user choice.");
            return Ok(format!("PREVIEW:{}", preview_url));
        }
    }

    Err("SoundCloud: No playable stream found (tried progressive, HLS, and /streams)".to_string())
}

/// Best-effort title/artist for YouTube fallback when SoundCloud is SNIP/geo-blocked.
pub async fn fetch_title_artist(url: &str) -> Result<(String, String), String> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let track_id = if url.contains("/tracks/") {
        url.split("/tracks/")
            .last()
            .and_then(|s| s.split('?').next())
            .and_then(|s| s.split('&').next())
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    if track_id.is_empty() {
        return Err("no track id".into());
    }

    let track_data = api_get_json_fresh(&client, |cid| {
        format!(
            "https://api-v2.soundcloud.com/tracks/{}?client_id={}",
            track_id, cid
        )
    })
    .await?;

    let title = track_data["title"].as_str().unwrap_or("").trim().to_string();
    let artist = track_data["user"]["username"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("empty title".into());
    }
    Ok((title, artist))
}

fn is_preview_url(url: &str) -> bool {
    url.contains("/preview/")
        || url.contains("preview-media")
        || url.contains("/playlist/0/30/")
}

async fn resolve_via_proxy(track_id: &str, client_id: &str) -> Result<String, String> {
    let worker_url = format!(
        "https://nekobeat-sc-proxy.nishalk.workers.dev/?track_id={}&client_id={}",
        track_id, client_id
    );

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;

    println!("SoundCloud: Trying Cloudflare Worker resolver...");

    let resp = client.get(&worker_url).send().await
        .map_err(|e| format!("Worker request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Worker returned status {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await
        .map_err(|e| format!("Worker JSON parse failed: {}", e))?;

    if let Some(err) = data["error"].as_str() {
        println!("SoundCloud: Worker reported: {}", err);
        if data["snipped"].as_bool().unwrap_or(false) {
            return Err(format!("Track is globally restricted by rights holder (snipped). {}", err));
        }
        return Err(err.to_string());
    }

    if let Some(url) = data["url"].as_str() {
        if !url.is_empty() && !is_preview_url(url) {
            let protocol = data["protocol"].as_str().unwrap_or("unknown");
            println!("SoundCloud: Worker resolved full {} stream!", protocol);
            return Ok(url.to_string());
        }
        println!("SoundCloud: Worker returned preview URL: {}...", &url[..std::cmp::min(url.len(), 80)]);
        return Err("Worker returned a preview URL — track is globally restricted".to_string());
    }

    Err("Worker returned no stream URL".to_string())
}
