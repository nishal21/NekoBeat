use reqwest::Client;
use serde_json::Value;
use regex::Regex;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::Datelike;
use lazy_static::lazy_static;
use std::sync::Mutex;

lazy_static! {
    static ref MXM_SECRET: Mutex<Option<String>> = Mutex::new(None);
}

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36";

type HmacSha256 = Hmac<Sha256>;

async fn get_latest_app(client: &Client) -> Result<String, String> {
    let url = "https://www.musixmatch.com/search";
    let res = client.get(url)
        .header("User-Agent", USER_AGENT)
        .header("Cookie", "mxm_bab=AB")
        .send().await.map_err(|e| e.to_string())?;
        
    let html = res.text().await.map_err(|e| e.to_string())?;

    let re = Regex::new(r#"src="([^"]*/_next/static/chunks/pages/_app-[^"]+\.js)""#).unwrap();
    if let Some(caps) = re.captures(&html) {
        if let Some(m) = caps.get(1) {
            let mut url = m.as_str().to_string();
            if url.starts_with("/") {
                url = format!("https://www.musixmatch.com{}", url);
            }
            return Ok(url);
        }
    }
    
    Err("Could not extract _app JS file URL".to_string())
}

async fn get_secret(client: &Client) -> Result<String, String> {
    {
        let secret_guard = MXM_SECRET.lock().unwrap();
        if let Some(secret) = &*secret_guard {
            return Ok(secret.clone());
        }
    }

    let app_url = get_latest_app(client).await?;
    let res = client.get(&app_url)
        .header("User-Agent", USER_AGENT)
        .send().await.map_err(|e| e.to_string())?;
        
    let js = res.text().await.map_err(|e| e.to_string())?;
    
    let re = Regex::new(r#"from\(\s*"(.*?)"\s*\.split"#).unwrap();
    if let Some(caps) = re.captures(&js) {
        if let Some(m) = caps.get(1) {
            let reversed: String = m.as_str().chars().rev().collect();
            let decoded_bytes = BASE64.decode(reversed).map_err(|e| format!("Base64 Error: {}", e))?;
            let decoded_string = String::from_utf8(decoded_bytes).map_err(|e| format!("UTF8 Error: {}", e))?;
            
            let mut secret_guard = MXM_SECRET.lock().unwrap();
            *secret_guard = Some(decoded_string.clone());
            return Ok(decoded_string);
        }
    }
    
    Err("Secret token could not be extracted from JS".to_string())
}

async fn generate_signature(secret: &str, url: &str) -> Result<String, String> {
    let date = chrono::Utc::now();
    let l = date.year().to_string();
    let s = format!("{:02}", date.month());
    let r = format!("{:02}", date.day());
    
    let message_str = format!("{}{}{}{}", url, l, s, r);
    
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| "HMAC Error")?;
        
    mac.update(message_str.as_bytes());
    let hash_bytes = mac.finalize().into_bytes();
    
    let hash_base64 = BASE64.encode(hash_bytes);
    let signature = urlencoding::encode(&hash_base64).into_owned();
    
    Ok(format!("&signature={}&signature_protocol=sha256", signature))
}

async fn make_request(client: &Client, endpoint: &str) -> Result<Value, String> {
    let secret = get_secret(client).await?;
    
    let base_url = "https://www.musixmatch.com/ws/1.1/";
    let full_url = format!("{}{}", base_url, endpoint);
    let sig_params = generate_signature(&secret, &full_url).await?;
    
    let signed_url = format!("{}{}", full_url, sig_params);
    let res = client.get(&signed_url)
        .header("User-Agent", USER_AGENT)
        .send().await.map_err(|e| e.to_string())?;
        
    if !res.status().is_success() {
        return Err(format!("Musixmatch error: {}", res.status()));
    }
    
    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[derive(serde::Serialize)]
pub struct MusixmatchResponse {
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
}

#[tauri::command]
pub async fn get_musixmatch_lyrics(title: String, artist: String) -> Result<MusixmatchResponse, String> {
    let client = Client::new();
    
    // 1. Search for the track
    let query_artist = artist.trim().replace(" ", "+");
    let query_track = title.trim().replace(" ", "+");
    
    let search_endpoint = format!(
        "track.search?app_id=community-app-v1.0&format=json&q_track={}&q_artist={}&f_has_lyrics=true&page_size=5&page=1",
        query_track, query_artist
    );
    
    let search_res = make_request(&client, &search_endpoint).await?;
    
    // Extract Track ID
    let mut track_id = None;
    if let Some(track_list) = search_res["message"]["body"]["track_list"].as_array() {
        if let Some(first) = track_list.first() {
            if let Some(id) = first["track"]["track_id"].as_i64() {
                track_id = Some(id);
            }
        }
    }
    
    let track_id = match track_id {
        Some(id) => id,
        None => return Err(format!("No results for '{} - {}' on Musixmatch", title, artist))
    };

    println!("Musixmatch: Found Track ID {} for '{} - {}'", track_id, title, artist);

    // 2. Fetch Subtitles! (Synced Lyrics)
    let sub_endpoint = format!("track.subtitle.get?app_id=community-app-v1.0&format=json&track_id={}", track_id);
    let sub_res = make_request(&client, &sub_endpoint).await;
    
    let mut synced_lrc = None;
    
    // The subtitles endpoint might return 404/Error if no synced lyrics exist.
    if let Ok(res) = sub_res {
        if let Some(sub_body) = res["message"]["body"]["subtitle"]["subtitle_body"].as_str() {
            // It's usually a JSON string encoded inside the string
            if let Ok(parsed_subs) = serde_json::from_str::<Value>(sub_body) {
                if let Some(arr) = parsed_subs.as_array() {
                    let mut lrc_lines = String::new();
                    for item in arr {
                        if let (Some(text), Some(time_tot)) = (item["text"].as_str(), item["time"]["total"].as_f64()) {
                            // Convert seconds to [MM:SS.xx]
                            let mins = (time_tot / 60.0).floor() as i32;
                            let secs = time_tot % 60.0;
                            lrc_lines.push_str(&format!("[{:02}:{:05.2}] {}\n", mins, secs, text));
                        }
                    }
                    if !lrc_lines.is_empty() {
                        synced_lrc = Some(lrc_lines);
                    }
                }
            }
        }
    }
    
    // 3. Fetch Plain Lyrics
    let mut plain_lyrics = None;
    let lyr_endpoint = format!("track.lyrics.get?app_id=community-app-v1.0&format=json&track_id={}", track_id);
    if let Ok(res) = make_request(&client, &lyr_endpoint).await {
        if let Some(lyr_body) = res["message"]["body"]["lyrics"]["lyrics_body"].as_str() {
            // Trim the standard musixmatch commercial suffix
            let mut clean_lyrics = lyr_body.to_string();
            if let Some(idx) = clean_lyrics.find("******* This Lyrics is NOT for Commercial use *******") {
                clean_lyrics.truncate(idx);
            }
            if !clean_lyrics.trim().is_empty() {
                plain_lyrics = Some(clean_lyrics.trim().to_string());
            }
        }
    }
    
    if synced_lrc.is_none() && plain_lyrics.is_none() {
         return Err("Found track on Musixmatch, but it has no lyrics.".to_string());
    }

    Ok(MusixmatchResponse {
        synced_lyrics: synced_lrc,
        plain_lyrics,
    })
}
