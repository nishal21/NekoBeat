//! In-process Spotify search (anonymous web-player token + Web API).
//! Used when spotiflac-cli is missing or cannot exec (common on Android filesDir/noexec).

use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha1 = Hmac<Sha1>;

// Matches SpotiFLAC-upstream/backend/spotify_totp.go (rotate with upstream).
const SPOTIFY_TOTP_SECRET_B32: &str =
    "GM3TMMJTGYZTQNZVGM4DINJZHA4TGOBYGMZTCMRTGEYDSMJRHE4TEOBUG4YTCMRUGQ4DQOJUGQYTAMRRGA2TCMJSHE3TCMBY";
const SPOTIFY_TOTP_VERSION: i32 = 61;

struct CachedToken {
    access: String,
    expires_ms: i64,
}

static TOKEN_CACHE: Mutex<Option<CachedToken>> = Mutex::new(None);

fn base32_decode(input: &str) -> Result<Vec<u8>, String> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let cleaned: String = input
        .chars()
        .filter(|c| *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let mut bits: u32 = 0;
    let mut bit_count: u32 = 0;
    let mut out = Vec::new();
    for ch in cleaned.bytes() {
        let val = alphabet
            .iter()
            .position(|&a| a == ch)
            .ok_or_else(|| format!("invalid base32 char {}", ch as char))?;
        bits = (bits << 5) | (val as u32);
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    Ok(out)
}

fn generate_totp(now_secs: u64) -> Result<String, String> {
    let key = base32_decode(SPOTIFY_TOTP_SECRET_B32)?;
    let counter = now_secs / 30;
    let mut msg = [0u8; 8];
    msg.copy_from_slice(&counter.to_be_bytes());

    let mut mac = HmacSha1::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&msg);
    let hash = mac.finalize().into_bytes();
    let offset = (hash[19] & 0x0f) as usize;
    let code = ((u32::from(hash[offset]) & 0x7f) << 24)
        | ((u32::from(hash[offset + 1]) & 0xff) << 16)
        | ((u32::from(hash[offset + 2]) & 0xff) << 8)
        | (u32::from(hash[offset + 3]) & 0xff);
    Ok(format!("{:06}", code % 1_000_000))
}

async fn fetch_access_token(client: &reqwest::Client) -> Result<String, String> {
    if let Ok(guard) = TOKEN_CACHE.lock() {
        if let Some(cached) = guard.as_ref() {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if cached.expires_ms > now_ms + 30_000 {
                return Ok(cached.access.clone());
            }
        }
    }

    let local_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Prefer Spotify server time (TOTP window drift breaks anonymous search on phones).
    let server_secs = match client
        .get("https://open.spotify.com/api/server-time")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        )
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("serverTime").and_then(|t| t.as_u64()))
            .unwrap_or(local_secs),
        _ => local_secs,
    };

    let totp = generate_totp(server_secs)?;
    let ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

    // Try init + transport reason (Spotify flips which works).
    let urls = [
        format!(
            "https://open.spotify.com/api/token?reason=init&productType=web-player&totp={}&totpServer={}&totpVer={}&ts={}",
            totp, totp, SPOTIFY_TOTP_VERSION, server_secs
        ),
        format!(
            "https://open.spotify.com/api/token?reason=transport&productType=web-player&totp={}&totpServer={}&totpVer={}&ts={}",
            totp, totp, SPOTIFY_TOTP_VERSION, server_secs
        ),
    ];

    let mut last_err = String::new();
    for url in &urls {
        let res = match client
            .get(url)
            .header("User-Agent", ua)
            .header("Accept", "application/json")
            .header("Referer", "https://open.spotify.com/")
            .header("Origin", "https://open.spotify.com")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Spotify token request: {}", e);
                continue;
            }
        };

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            last_err = format!(
                "Spotify token HTTP {}: {}",
                status,
                body.chars().take(160).collect::<String>()
            );
            continue;
        }

        let json: serde_json::Value = match res.json().await {
            Ok(j) => j,
            Err(e) => {
                last_err = format!("Spotify token parse: {}", e);
                continue;
            }
        };

        let access = match json.get("accessToken").and_then(|v| v.as_str()) {
            Some(a) => a.to_string(),
            None => {
                last_err = "Spotify token: missing accessToken".into();
                continue;
            }
        };
        let expires_ms = json
            .get("accessTokenExpirationTimestampMs")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if let Ok(mut guard) = TOKEN_CACHE.lock() {
            *guard = Some(CachedToken {
                access: access.clone(),
                expires_ms,
            });
        }
        return Ok(access);
    }

    Err(if last_err.is_empty() {
        "Spotify token failed".into()
    } else {
        last_err
    })
}

#[derive(Debug, Clone)]
pub struct SpotifySearchHit {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub artwork_url: String,
    pub external_url: String,
}

/// Search Spotify tracks via Web API (in-process — no Go sidecar).
pub async fn search_tracks(
    query: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<SpotifySearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;

    let token = fetch_access_token(&client).await?;

    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type=track&limit={}&offset={}",
        urlencoding::encode(q),
        limit.min(50),
        offset
    );

    let mut last_err = String::new();
    for attempt in 0..4u32 {
        let res = client
            .get(&url)
            .bearer_auth(&token)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            )
            .send()
            .await
            .map_err(|e| format!("Spotify search request: {}", e))?;

        let status = res.status();
        if status.as_u16() == 429 {
            let retry_after = res
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(1u64 + attempt as u64);
            let wait = retry_after.clamp(1, 8);
            last_err = format!("Spotify rate limited (HTTP 429). Retrying in {}s…", wait);
            eprintln!("Spotify web search: {}", last_err);
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            continue;
        }

        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(format!(
                "Spotify search HTTP {}: {}",
                status,
                body.chars().take(120).collect::<String>()
            ));
        }

        let json: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Spotify search parse: {}", e))?;

        let mut out = Vec::new();
        let items = json
            .pointer("/tracks/items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for item in items {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            let title = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let artists = item
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Unknown Artist".into());
            let album = item
                .pointer("/album/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let duration_ms = item
                .get("duration_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let artwork_url = item
                .pointer("/album/images")
                .and_then(|v| v.as_array())
                .and_then(|imgs| {
                    imgs.iter()
                        .max_by_key(|img| img.get("width").and_then(|w| w.as_u64()).unwrap_or(0))
                        .and_then(|img| img.get("url").and_then(|u| u.as_str()))
                })
                .unwrap_or("")
                .to_string();
            let external_url = item
                .pointer("/external_urls/spotify")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("https://open.spotify.com/track/{}", id));

            out.push(SpotifySearchHit {
                id,
                title,
                artist: artists,
                album,
                duration_ms,
                artwork_url,
                external_url,
            });
        }

        println!("Spotify web search: {} tracks for '{}'", out.len(), q);
        return Ok(out);
    }

    Err(if last_err.is_empty() {
        "Spotify search failed after retries".into()
    } else {
        format!(
            "{} — wait a moment, or use YouTube / All search.",
            last_err.replace(" Retrying in", " Tried;")
        )
    })
}
