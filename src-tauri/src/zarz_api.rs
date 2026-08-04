//! SpotiFLAC cloud API (https://api.zarz.moe) — resolve + remote config.
//! Docs: https://spotiflac.zarz.moe/docs (extension authoring).
//! Resolve mirrors SpotiFLAC Mobile `go_backend/songlink.go`: POST /v1/resolve,
//! Song.link fallback when the proxy returns non-200 / empty links.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

pub const DEFAULT_API_BASE: &str = "https://api.zarz.moe";
pub const DOCS_URL: &str = "https://spotiflac.zarz.moe/docs";
const SONGLINK_BASE: &str = "https://api.song.link/v1-alpha.1/links";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLinks {
    pub success: bool,
    pub isrc: Option<String>,
    pub song_urls: HashMap<String, String>,
    pub spotify_id: Option<String>,
    pub tidal_id: Option<String>,
    pub qobuz_id: Option<String>,
    pub deezer_id: Option<String>,
    pub amazon_url: Option<String>,
    pub tidal_url: Option<String>,
    pub qobuz_url: Option<String>,
    /// `zarz` | `songlink`
    pub via: Option<String>,
}

fn http_client(secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .user_agent("NekoBeat/0.3 (api.zarz.moe client)")
        .build()
        .map_err(|e| e.to_string())
}

fn extract_url(v: &serde_json::Value) -> Option<String> {
    if v.is_null() {
        return None;
    }
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(u) = extract_url(item) {
                return Some(u);
            }
        }
    }
    if let Some(o) = v.as_object() {
        for key in ["url", "URL", "link", "href"] {
            if let Some(s) = o.get(key).and_then(|x| x.as_str()) {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn id_from_url(url: &str, platform: &str) -> Option<String> {
    let lower = url.to_lowercase();
    match platform {
        "spotify" => {
            let re = regex::Regex::new(r"(?:track/|spotify:track:)([a-zA-Z0-9]+)").ok()?;
            re.captures(url).map(|c| c[1].to_string())
        }
        "tidal" => {
            let re = regex::Regex::new(r"track/(\d+)").ok()?;
            re.captures(&lower).map(|c| c[1].to_string())
        }
        "qobuz" => {
            let re = regex::Regex::new(r"/(\d+)(?:\?|$)").ok()?;
            re.captures(url).map(|c| c[1].to_string())
        }
        "deezer" => {
            let re = regex::Regex::new(r"track/(\d+)").ok()?;
            re.captures(&lower).map(|c| c[1].to_string())
        }
        _ => None,
    }
}

fn finalize(mut song_urls: HashMap<String, String>, isrc: Option<String>, via: &str) -> ResolvedLinks {
    // Normalize Song.link camelCase keys → SpotiFLAC Mobile PascalCase when needed
    let aliases = [
        ("spotify", "Spotify"),
        ("tidal", "Tidal"),
        ("qobuz", "Qobuz"),
        ("deezer", "Deezer"),
        ("amazonMusic", "AmazonMusic"),
        ("youtubeMusic", "YouTubeMusic"),
        ("youtube", "YouTube"),
        ("appleMusic", "AppleMusic"),
    ];
    for (from, to) in aliases {
        if let Some(u) = song_urls.get(from).cloned() {
            song_urls.entry(to.into()).or_insert(u);
        }
    }

    let spotify_url = song_urls.get("Spotify").cloned();
    let tidal_url = song_urls.get("Tidal").cloned();
    let qobuz_url = song_urls.get("Qobuz").cloned();
    let deezer_url = song_urls.get("Deezer").cloned();
    let amazon_url = song_urls
        .get("AmazonMusic")
        .or_else(|| song_urls.get("Amazon"))
        .cloned();

    ResolvedLinks {
        success: !song_urls.is_empty(),
        isrc,
        spotify_id: spotify_url
            .as_deref()
            .and_then(|u| id_from_url(u, "spotify")),
        tidal_id: tidal_url.as_deref().and_then(|u| id_from_url(u, "tidal")),
        qobuz_id: qobuz_url.as_deref().and_then(|u| id_from_url(u, "qobuz")),
        deezer_id: deezer_url.as_deref().and_then(|u| id_from_url(u, "deezer")),
        amazon_url,
        tidal_url,
        qobuz_url,
        song_urls,
        via: Some(via.into()),
    }
}

pub fn resolve_spotify_track(api_base: &str, spotify_id: &str) -> Result<ResolvedLinks, String> {
    resolve_spotify_track_region(api_base, spotify_id, "US")
}

pub fn resolve_spotify_track_region(
    api_base: &str,
    spotify_id: &str,
    region: &str,
) -> Result<ResolvedLinks, String> {
    let url = format!("{}/v1/resolve", api_base.trim_end_matches('/'));
    let payload = json!({
        "platform": "spotify",
        "type": "track",
        "id": spotify_id,
    });
    match do_resolve(&url, payload) {
        Ok(r) if r.success && !r.song_urls.is_empty() => Ok(r),
        Ok(_) | Err(_) => songlink_by_platform("spotify", "track", spotify_id, region),
    }
}

pub fn resolve_url(api_base: &str, track_url: &str) -> Result<ResolvedLinks, String> {
    resolve_url_region(api_base, track_url, "US")
}

pub fn resolve_url_region(
    api_base: &str,
    track_url: &str,
    region: &str,
) -> Result<ResolvedLinks, String> {
    let lower = track_url.to_lowercase();
    let is_spotify = lower.contains("spotify.com/") || lower.starts_with("spotify:");
    if is_spotify {
        let url = format!("{}/v1/resolve", api_base.trim_end_matches('/'));
        let payload = json!({ "url": track_url });
        match do_resolve(&url, payload) {
            Ok(r) if r.success && !r.song_urls.is_empty() => return Ok(r),
            _ => {}
        }
    }
    songlink_by_url(track_url, region)
}

fn do_resolve(url: &str, payload: serde_json::Value) -> Result<ResolvedLinks, String> {
    let client = http_client(45)?;
    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .map_err(|e| format!("api.zarz.moe resolve: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("api.zarz.moe resolve status {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let success = body.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        return Err("api.zarz.moe resolve success=false".into());
    }
    let isrc = body
        .get("isrc")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let mut song_urls = HashMap::new();
    if let Some(obj) = body.get("songUrls").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(u) = extract_url(v) {
                song_urls.insert(k.clone(), u);
            }
        }
    }
    if song_urls.is_empty() {
        return Err("api.zarz.moe resolve returned no platform links".into());
    }
    Ok(finalize(song_urls, isrc, "zarz"))
}

fn songlink_by_url(track_url: &str, region: &str) -> Result<ResolvedLinks, String> {
    let region = normalize_region(region);
    let q = format!(
        "{}?url={}&userCountry={}",
        SONGLINK_BASE,
        urlencoding::encode(track_url),
        urlencoding::encode(&region)
    );
    songlink_get(&q)
}

fn songlink_by_platform(
    platform: &str,
    entity_type: &str,
    id: &str,
    region: &str,
) -> Result<ResolvedLinks, String> {
    let region = normalize_region(region);
    let q = format!(
        "{}?platform={}&type={}&id={}&userCountry={}",
        SONGLINK_BASE,
        urlencoding::encode(platform),
        urlencoding::encode(entity_type),
        urlencoding::encode(id),
        urlencoding::encode(&region)
    );
    songlink_get(&q)
}

fn songlink_get(api_url: &str) -> Result<ResolvedLinks, String> {
    let client = http_client(30)?;
    let resp = client
        .get(api_url)
        .send()
        .map_err(|e| format!("Song.link: {e}"))?;
    if resp.status().as_u16() == 429 {
        return Err("Song.link rate limit exceeded".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Song.link status {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    let mut song_urls = HashMap::new();
    if let Some(obj) = body
        .get("linksByPlatform")
        .and_then(|v| v.as_object())
    {
        for (k, v) in obj {
            if let Some(u) = extract_url(v) {
                song_urls.insert(k.clone(), u);
            }
        }
    }
    if song_urls.is_empty() {
        return Err("Song.link returned no platform links".into());
    }
    let isrc = body
        .get("entitiesByUniqueId")
        .and_then(|v| v.as_object())
        .and_then(|m| {
            m.values().find_map(|ent| {
                ent.get("isrc")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
        });
    Ok(finalize(song_urls, isrc, "songlink"))
}

fn normalize_region(region: &str) -> String {
    let r: String = region
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    if r.len() == 2 {
        r
    } else {
        "US".into()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub raw: serde_json::Value,
    pub announcement_title: Option<String>,
    pub announcement_message: Option<String>,
    pub cta_url: Option<String>,
    pub cta_label: Option<String>,
    pub announcement_enabled: Option<bool>,
    pub donate_enabled: Option<bool>,
    pub donate_title: Option<String>,
    pub donate_message: Option<String>,
}

pub fn fetch_config(api_base: &str) -> Result<RemoteConfig, String> {
    let url = format!(
        "{}/v1/spotiflac-mobile/config",
        api_base.trim_end_matches('/')
    );
    let client = http_client(20)?;
    let body: serde_json::Value = client
        .get(&url)
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let ann = body.get("announcement");
    let donate = body.get("donate");
    Ok(RemoteConfig {
        announcement_title: ann
            .and_then(|a| a.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        announcement_message: ann
            .and_then(|a| a.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        cta_url: ann
            .and_then(|a| a.get("cta_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        cta_label: ann
            .and_then(|a| a.get("cta_label"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        announcement_enabled: ann.and_then(|a| a.get("enabled")).and_then(|v| v.as_bool()),
        donate_enabled: donate
            .and_then(|d| d.get("enabled"))
            .and_then(|v| v.as_bool()),
        donate_title: donate
            .and_then(|d| d.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        donate_message: donate
            .and_then(|d| d.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        raw: body,
    })
}

#[tauri::command]
pub fn zarz_resolve(
    settings: tauri::State<'_, std::sync::Arc<parking_lot::Mutex<crate::settings::AppSettings>>>,
    spotify_id: Option<String>,
    url: Option<String>,
) -> Result<ResolvedLinks, String> {
    let (base, region) = {
        let s = settings.lock();
        (s.zarz_api_base.clone(), s.songlink_region.clone())
    };
    if let Some(id) = spotify_id.filter(|s| !s.is_empty()) {
        return resolve_spotify_track_region(&base, &id, &region);
    }
    if let Some(u) = url.filter(|s| !s.is_empty()) {
        return resolve_url_region(&base, &u, &region);
    }
    Err("Provide spotifyId or url".into())
}

#[tauri::command]
pub fn zarz_config(
    settings: tauri::State<'_, std::sync::Arc<parking_lot::Mutex<crate::settings::AppSettings>>>,
) -> Result<RemoteConfig, String> {
    let base = settings.lock().zarz_api_base.clone();
    fetch_config(&base)
}

#[tauri::command]
pub fn zarz_docs_url() -> String {
    DOCS_URL.to_string()
}

#[tauri::command]
pub fn zarz_health(
    settings: tauri::State<'_, std::sync::Arc<parking_lot::Mutex<crate::settings::AppSettings>>>,
) -> Result<serde_json::Value, String> {
    let base = settings.lock().zarz_api_base.clone();
    let url = format!("{}/health", base.trim_end_matches('/'));
    reqwest::blocking::get(&url)
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())
}
