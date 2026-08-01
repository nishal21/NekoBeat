//! Unified lyrics resolver — one IPC call chains Spotify → LRCLib → Musixmatch → Genius.

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use super::genius;
use super::musixmatch;
use super::spotify_lyrics;

#[derive(Serialize, Clone)]
pub struct LyricsResult {
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    pub source: Option<String>,
}

fn clean_title(title: &str) -> String {
    title
        .split(&['(', '['][..])
        .next()
        .unwrap_or(title)
        .split(" - ")
        .next()
        .unwrap_or(title)
        .trim()
        .to_string()
}

fn clean_artist(artist: &str) -> String {
    artist
        .replace(" - Topic", "")
        .replace(" - TOPIC", "")
        .trim()
        .to_string()
}

fn skip_album(album: &str) -> bool {
    matches!(
        album.to_lowercase().as_str(),
        "youtube" | "soundcloud" | "bandcamp" | "vk" | "yandex" | "spotify" | ""
    )
}

async fn fetch_lrclib(
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: u64,
) -> Option<LyricsResult> {
    let client = Client::builder()
        .user_agent("NekoBeat/1.0")
        .build()
        .ok()?;
    let clean_t = clean_title(title);
    let clean_a = clean_artist(artist);

    // Exact match
    let mut url = reqwest::Url::parse("https://lrclib.net/api/get").ok()?;
    url.query_pairs_mut()
        .append_pair("track_name", &clean_t)
        .append_pair("artist_name", &clean_a);
    if !skip_album(album) {
        url.query_pairs_mut().append_pair("album_name", album);
    }
    if duration_ms > 0 {
        url.query_pairs_mut()
            .append_pair("duration", &(duration_ms / 1000).to_string());
    }

    if let Ok(res) = client.get(url).send().await {
        if res.status().is_success() {
            if let Ok(data) = res.json::<Value>().await {
                let synced = data["syncedLyrics"].as_str().map(|s| s.to_string());
                let plain = data["plainLyrics"].as_str().map(|s| s.to_string());
                if synced.is_some() || plain.is_some() {
                    return Some(LyricsResult {
                        synced_lyrics: synced,
                        plain_lyrics: plain,
                        source: Some("lrclib".into()),
                    });
                }
            }
        }
    }

    // Search fallback
    let search_url = format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        urlencoding::encode(&clean_t),
        urlencoding::encode(&clean_a)
    );
    if let Ok(res) = client.get(&search_url).send().await {
        if res.status().is_success() {
            if let Ok(results) = res.json::<Vec<Value>>().await {
                let best = results
                    .iter()
                    .find(|r| r["syncedLyrics"].as_str().is_some())
                    .or_else(|| results.first());
                if let Some(r) = best {
                    let synced = r["syncedLyrics"].as_str().map(|s| s.to_string());
                    let plain = r["plainLyrics"].as_str().map(|s| s.to_string());
                    if synced.is_some() || plain.is_some() {
                        return Some(LyricsResult {
                            synced_lyrics: synced,
                            plain_lyrics: plain,
                            source: Some("lrclib".into()),
                        });
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn get_lyrics(
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    spotify_id: Option<String>,
) -> Result<LyricsResult, String> {
    let clean_t = clean_title(&title);
    let clean_a = clean_artist(&artist);

    // 1. Spotify synced lyrics with ~800ms budget when track ID known
    if let Some(ref id) = spotify_id {
        let raw = id.trim_start_matches("sp-").to_string();
        let spotify_fut = spotify_lyrics::get_spotify_lyrics(raw);
        match tokio::time::timeout(std::time::Duration::from_millis(800), spotify_fut).await {
            Ok(Ok(sp)) if sp.synced_lyrics.is_some() || sp.plain_lyrics.is_some() => {
                return Ok(LyricsResult {
                    synced_lyrics: sp.synced_lyrics,
                    plain_lyrics: sp.plain_lyrics,
                    source: Some("spotify".into()),
                });
            }
            Ok(Ok(_)) | Ok(Err(_)) | Err(_) => {
                // Budget exceeded or miss — race community sources below
            }
        }
    }

    // 2+3. Race LRCLib + Musixmatch — prefer first synced, else first plain
    let lrc_fut = fetch_lrclib(&clean_t, &clean_a, &album, duration_ms);
    let mxm_fut = musixmatch::get_musixmatch_lyrics(clean_t.clone(), clean_a.clone());
    let (lrc, mxm) = tokio::join!(lrc_fut, mxm_fut);

    let mxm_result = mxm.ok().and_then(|m| {
        if m.synced_lyrics.is_some() || m.plain_lyrics.is_some() {
            Some(LyricsResult {
                synced_lyrics: m.synced_lyrics,
                plain_lyrics: m.plain_lyrics,
                source: Some("musixmatch".into()),
            })
        } else {
            None
        }
    });

    if let Some(r) = lrc.as_ref().filter(|r| r.synced_lyrics.is_some()) {
        return Ok(r.clone());
    }
    if let Some(r) = mxm_result.as_ref().filter(|r| r.synced_lyrics.is_some()) {
        return Ok(r.clone());
    }
    if let Some(r) = lrc {
        return Ok(r);
    }
    if let Some(r) = mxm_result {
        return Ok(r);
    }

    // 4. Genius (plain text) last fallback
    if let Ok(plain) = genius::get_genius_lyrics(clean_t, clean_a).await {
        if !plain.is_empty() {
            return Ok(LyricsResult {
                synced_lyrics: None,
                plain_lyrics: Some(plain),
                source: Some("genius".into()),
            });
        }
    }

    Err("No lyrics found from any source".into())
}
