use reqwest::Client;
use serde_json::Value;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use lazy_static::lazy_static;
use urlencoding::encode as url_encode;
use crate::aggregator::musixmatch::MusixmatchResponse;

lazy_static! {
    static ref SPOTIFY_TOKEN: Mutex<Option<(String, u64)>> = Mutex::new(None);
}

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SP_DC: &str = "AQBdJvCjiKQAHusS1xKNSm-6isYhIPCLgf2VO1oX_Q_EtI7KxSlshVcE22sswXTDr3F4zLN6o0PPxR-iGPj1DXoPoXpupESUeq_eYBlsSu_rYEXCJRSvT96az_vrWduEmd6Gz9zV9HjVZjMrVYa6oNxZmtd18NOyW5JuXrdIBMSuAE73tow8HrM2sEfajJZDC2Dw2Jv83Wap1_0WDYBYU-p47Y3lmj8S8yNlX28FCrWSrrX_aMe8VYtFsm3gpo0H0kMRNChgNDYZgcA";
const SECRET_URL: &str = "https://github.com/xyloflake/spot-secrets-go/blob/main/secrets/secretDict.json?raw=true";

type HmacSha1 = Hmac<Sha1>;

async fn get_latest_secret_key_version(client: &Client) -> Result<(Vec<u8>, String), String> {
    let res = client.get(SECRET_URL).send().await.map_err(|e| e.to_string())?;
    let secrets_data: Value = res.json().await.map_err(|e| e.to_string())?;
    
    let map = secrets_data.as_object().ok_or("Invalid secrets JSON format")?;
    let version = map.keys().last().ok_or("No version found")?.clone();
    let original_secret = map[&version].as_array().ok_or("Invalid secret format")?;
    
    let mut transformed_str = String::new();
    for (i, val) in original_secret.iter().enumerate() {
        let char_val = val.as_u64().ok_or("Non-integer in secret array")? as u8;
        let t = char_val ^ (((i % 33) + 9) as u8);
        transformed_str.push_str(&t.to_string());
    }
    let transformed = transformed_str.into_bytes();
    
    Ok((transformed, version))
}

fn generate_totp(server_time_seconds: u64, secret: &[u8]) -> String {
    let period = 30;
    let digits = 6;
    let counter = server_time_seconds / period;
    let counter_bytes = counter.to_be_bytes();
    
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC can take key of any size");
    mac.update(&counter_bytes);
    let hmac_result = mac.finalize().into_bytes();
    
    let offset = (hmac_result[19] & 0x0f) as usize;
    let binary = ((hmac_result[offset] & 0x7f) as u32) << 24
        | ((hmac_result[offset + 1] & 0xff) as u32) << 16
        | ((hmac_result[offset + 2] & 0xff) as u32) << 8
        | ((hmac_result[offset + 3] & 0xff) as u32);
        
    let code = binary % 10_u32.pow(digits);
    format!("{:06}", code)
}

async fn get_server_time_params(client: &Client) -> Result<(String, String, String), String> {
    let url = "https://open.spotify.com/api/server-time";
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    
    let server_time_seconds = data["serverTime"].as_u64().ok_or("Invalid server timestamp")?;
    
    let (secret, version) = get_latest_secret_key_version(client).await?;
    let totp = generate_totp(server_time_seconds, &secret);
    
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs().to_string();
    
    Ok((totp, version, ts))
}

async fn get_token(client: &Client) -> Result<String, String> {
    {
        let token_guard = SPOTIFY_TOKEN.lock().unwrap();
        if let Some((token, expiry)) = &*token_guard {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
            if *expiry > now {
                return Ok(token.clone());
            }
        }
    }
    
    let (totp, version, ts) = get_server_time_params(client).await?;
    
    let url = format!(
        "https://open.spotify.com/api/token?reason=transport&productType=web-player&totp={}&totpVer={}&ts={}",
        totp, version, ts
    );
    
    println!("Fetching token with URL: {}", url);
    let res = client.get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Cookie", format!("sp_dc={}", SP_DC))
        .send().await.map_err(|e| {
            println!("Get Token HTTP Error: {}", e);
            e.to_string()
        })?;
        
    let res_text = res.text().await.map_err(|e| e.to_string())?;
    println!("Token API Body: {}", res_text);
    
    let token_json: Value = serde_json::from_str(&res_text).map_err(|e| e.to_string())?;
    
    if token_json["isAnonymous"].as_bool().unwrap_or(false) {
        println!("Error: Token API returned isAnonymous=true (SP_DC invalid)");
        return Err("SP_DC cookie seems to be invalid or expired. Spotify token API returned anonymous session.".to_string());
    }
    
    let access_token = token_json["accessToken"].as_str().ok_or("No accessToken in response")?.to_string();
    let expiration = token_json["accessTokenExpirationTimestampMs"].as_u64().ok_or("No expiration found")?;
    
    let mut token_guard = SPOTIFY_TOKEN.lock().unwrap();
    *token_guard = Some((access_token.clone(), expiration));
    
    Ok(access_token)
}

fn format_ms(milliseconds: u64) -> String {
    let th_secs = milliseconds / 1000;
    let mins = th_secs / 60;
    let secs = th_secs % 60;
    let cs = (milliseconds % 1000) / 10;
    format!("{:02}:{:02}.{:02}", mins, secs, cs)
}

#[tauri::command]
pub async fn get_spotify_lyrics(track_id: String) -> Result<MusixmatchResponse, String> {
    println!("get_spotify_lyrics invoked with track_id: {}", track_id);
    match get_spotify_lyrics_impl(&track_id).await {
        Ok(lyrics) => {
            println!("Successfully fetched Spotify lyrics for track_id: {}", track_id);
            Ok(lyrics)
        }
        Err(e) => {
            eprintln!("Failed to fetch Spotify lyrics for track_id: {}: {}", track_id, e);
            Err(e)
        }
    }
}

async fn get_spotify_lyrics_impl(track_id: &str) -> Result<MusixmatchResponse, String> {
    let client = Client::new();
    let token = get_token(&client).await?;
    
    let url = format!("https://spclient.wg.spotify.com/color-lyrics/v2/track/{}?format=json&market=from_token", track_id);
    
    let res = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .header("App-platform", "WebPlayer")
        .header("authorization", format!("Bearer {}", token))
        .send().await.map_err(|e| {
            println!("Spotify Lyrics API request error: {}", e);
            e.to_string()
        })?;
        
    let status = res.status();
    println!("Spotify Lyrics API response status: {}", status);
    
    if status.as_u16() == 429 {
        return Err("Rate limited by Spotify.".to_string());
    } else if status.as_u16() == 404 {
        return Err("Lyrics for this track were not found on Spotify.".to_string());
    } else if !status.is_success() {
        return Err(format!("Spotify API error: {}", status));
    }
    
    let text = res.text().await.map_err(|e| e.to_string())?;
    // println!("Spotify Lyrics HTML API Body: {}", text); // Too much noise on success
    let data: Value = serde_json::from_str(&text).map_err(|e| format!("Failed to parse lyrics json: {}, body: {}", e, text))?;
    
    let lyrics_lines = data["lyrics"]["lines"].as_array().ok_or("Invalid lyrics format")?;
    let sync_type = data["lyrics"]["syncType"].as_str().unwrap_or("UNSYNCED");
    
    if lyrics_lines.is_empty() {
        return Err("No lyrics returned".to_string());
    }
    
    if sync_type == "LINE_SYNCED" {
        let mut lrc = String::new();
        for line in lyrics_lines {
            if let Some(start_ms_str) = line["startTimeMs"].as_str() {
                if let Ok(ms) = start_ms_str.parse::<u64>() {
                    let words = line["words"].as_str().unwrap_or("");
                    lrc.push_str(&format!("[{}] {}\n", format_ms(ms), words));
                }
            }
        }
        return Ok(MusixmatchResponse {
            synced_lyrics: Some(lrc),
            plain_lyrics: None,
        });
    } else {
        let mut plain = String::new();
        for line in lyrics_lines {
            plain.push_str(line["words"].as_str().unwrap_or(""));
            plain.push('\n');
        }
        return Ok(MusixmatchResponse {
            synced_lyrics: None,
            plain_lyrics: Some(plain),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_spotify_lyrics() {
        let result = get_spotify_lyrics_impl("6WfVu4OjY9zES8pecNrcVR").await;
        match result {
            Ok(r) => println!("Success! Lyrics length: {}", r.synced_lyrics.unwrap_or_default().len()),
            Err(e) => panic!("Test failed: {}", e),
        }
    }
}
