//! Unified lyrics resolver — Harmonoid *method*, NekoBeat *sources*.
//!
//! Same cascade as Harmonoid (`lyrics_notifier.dart`):
//!   1) app Lyrics cache (`<sha256>.lrc`)
//!   2) sidecar `.lrc` next to the file
//!   3) online (prefer synced LRC)
//!   4) write-back to cache
//!
//! IMPORTANT — we do **NOT** call Harmonoid’s private
//! `/functions/v1/lyrics-get` (CI secrets `API_BASE_URL` / `API_KEY`).
//! That endpoint would break whenever their key/host changes and is not ours to use.
//! Online synced lyrics come from public LRCLib (+ Musixmatch / optional Spotify / Genius).

use std::time::Duration;

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::genius;
use super::musixmatch;
use super::spotify_lyrics;
use crate::lyrics_cache;

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
        .replace("VEVO", "")
        .split(',')
        .next()
        .unwrap_or(artist)
        .split('&')
        .next()
        .unwrap_or(artist)
        .split(" feat")
        .next()
        .unwrap_or(artist)
        .split(" ft.")
        .next()
        .unwrap_or(artist)
        .trim()
        .to_string()
}

fn skip_album(album: &str) -> bool {
    matches!(
        album.to_lowercase().as_str(),
        "youtube" | "soundcloud" | "bandcamp" | "vk" | "yandex" | "spotify" | "local" | ""
    )
}

fn from_text(text: &str, source: &str) -> LyricsResult {
    if lyrics_cache::looks_synced(text) {
        LyricsResult {
            synced_lyrics: Some(text.to_string()),
            plain_lyrics: None,
            source: Some(source.into()),
        }
    } else {
        LyricsResult {
            synced_lyrics: None,
            plain_lyrics: Some(text.to_string()),
            source: Some(source.into()),
        }
    }
}

fn persist_result(
    app: &AppHandle,
    cache_key: Option<&str>,
    filepath: Option<&str>,
    result: &LyricsResult,
) {
    let text = result
        .synced_lyrics
        .as_deref()
        .or(result.plain_lyrics.as_deref());
    let Some(text) = text else { return };

    let write_key = |key: &str| {
        let existing = lyrics_cache::read_cached(app, key);
        let should_write = match &existing {
            Some(old) if lyrics_cache::looks_synced(old) && !lyrics_cache::looks_synced(text) => {
                false
            }
            _ => true,
        };
        if should_write {
            let _ = lyrics_cache::write_cached(app, key, text);
        }
    };

    if let Some(key) = cache_key.filter(|k| !k.trim().is_empty()) {
        write_key(key);
    }

    if let Some(fp) = filepath.filter(|p| !p.trim().is_empty()) {
        if cache_key.map(|k| k != fp).unwrap_or(true) {
            write_key(fp);
        }
        if let Ok(conn) = crate::library::init_db(app) {
            if lyrics_cache::looks_synced(text) {
                let _ = conn.execute(
                    "UPDATE tracks SET local_lyrics = ?1 WHERE filepath = ?2",
                    rusqlite::params![text, fp],
                );
            } else {
                let _ = conn.execute(
                    "UPDATE tracks SET local_lyrics = COALESCE(local_lyrics, ?1) WHERE filepath = ?2",
                    rusqlite::params![text, fp],
                );
            }
        }
    }
}

fn pick_lrclib_search(results: &[Value], duration_ms: u64) -> Option<&Value> {
    let want = if duration_ms > 0 {
        duration_ms as f64 / 1000.0
    } else {
        -1.0
    };

    let mut best_synced: Option<(&Value, f64)> = None;
    let mut first_synced: Option<&Value> = None;
    let mut first_any: Option<&Value> = None;

    for r in results {
        let has_synced = r["syncedLyrics"]
            .as_str()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let has_plain = r["plainLyrics"]
            .as_str()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_synced && !has_plain {
            continue;
        }
        if first_any.is_none() {
            first_any = Some(r);
        }
        if has_synced && first_synced.is_none() {
            first_synced = Some(r);
        }
        if has_synced && want > 0.0 {
            let dur = r["duration"]
                .as_f64()
                .or_else(|| r["duration"].as_u64().map(|u| u as f64));
            if let Some(d) = dur {
                let delta = (d - want).abs();
                if delta <= 8.0 {
                    match best_synced {
                        Some((_, best_d)) if delta >= best_d => {}
                        _ => best_synced = Some((r, delta)),
                    }
                }
            }
        }
    }

    best_synced
        .map(|(r, _)| r)
        .or(first_synced)
        .or(first_any)
}

fn parse_lrclib_row(r: &Value) -> Option<LyricsResult> {
    let synced = r["syncedLyrics"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .filter(|s| lyrics_cache::looks_synced(s));
    let plain = r["plainLyrics"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    if synced.is_none() && plain.is_none() {
        return None;
    }
    Some(LyricsResult {
        synced_lyrics: synced,
        plain_lyrics: plain,
        source: Some("lrclib".into()),
    })
}

fn lrclib_client() -> Option<Client> {
    Client::builder()
        .user_agent("NekoBeat/0.3 (https://github.com/nishal21/nekobeat)")
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .build()
        .ok()
}

async fn lrclib_get(
    client: &Client,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_secs: Option<u64>,
) -> Option<LyricsResult> {
    let mut url = reqwest::Url::parse("https://lrclib.net/api/get").ok()?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("track_name", title);
        q.append_pair("artist_name", artist);
        if let Some(a) = album {
            q.append_pair("album_name", a);
        }
        if let Some(d) = duration_secs {
            q.append_pair("duration", &d.to_string());
        }
    }
    let res = client
        .get(url)
        .header("Lrclib-Client", "NekoBeat/0.3")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let data = res.json::<Value>().await.ok()?;
    parse_lrclib_row(&data)
}

async fn lrclib_search(client: &Client, url: &str, duration_ms: u64) -> Option<LyricsResult> {
    let res = client
        .get(url)
        .header("Lrclib-Client", "NekoBeat/0.3")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let results = res.json::<Vec<Value>>().await.ok()?;
    let row = pick_lrclib_search(&results, duration_ms)?;
    parse_lrclib_row(row)
}

async fn fetch_lrclib(
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: u64,
) -> Option<LyricsResult> {
    let client = lrclib_client()?;
    let clean_t = clean_title(title);
    let clean_a = clean_artist(artist);
    if clean_t.is_empty() {
        return None;
    }
    let dur_secs = if duration_ms > 0 {
        Some(duration_ms / 1000)
    } else {
        None
    };
    let album_opt = if skip_album(album) {
        None
    } else {
        Some(album)
    };

    let mut plain_hit: Option<LyricsResult> = None;

    // Exact /api/get — try album/duration combinations (LRCLib is picky)
    for a in [album_opt, None] {
        for d in [dur_secs, None] {
            if let Some(r) = lrclib_get(&client, &clean_t, &clean_a, a, d).await {
                if r.synced_lyrics.is_some() {
                    return Some(r);
                }
                if plain_hit.is_none() && r.plain_lyrics.is_some() {
                    plain_hit = Some(r);
                }
            }
        }
    }

    // Search with duration-aware pick
    let search_url = format!(
        "https://lrclib.net/api/search?track_name={}&artist_name={}",
        urlencoding::encode(&clean_t),
        urlencoding::encode(&clean_a)
    );
    if let Some(r) = lrclib_search(&client, &search_url, duration_ms).await {
        if r.synced_lyrics.is_some() {
            return Some(r);
        }
        if plain_hit.is_none() {
            plain_hit = Some(r);
        }
    }

    let q = format!("{} {}", clean_t, clean_a);
    let q_url = format!(
        "https://lrclib.net/api/search?q={}",
        urlencoding::encode(&q)
    );
    if let Some(r) = lrclib_search(&client, &q_url, duration_ms).await {
        if r.synced_lyrics.is_some() {
            return Some(r);
        }
        if plain_hit.is_none() {
            plain_hit = Some(r);
        }
    }

    if let Some(r) = plain_hit {
        return Some(r);
    }
    lrclib_get(&client, &clean_t, &clean_a, None, None).await
}

async fn fetch_online(
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: u64,
    spotify_id: Option<&str>,
) -> Option<LyricsResult> {
    let clean_t = clean_title(title);
    let clean_a = clean_artist(artist);

    // Optional Spotify — short budget, never blocks the rest
    if let Some(id) = spotify_id {
        let raw = id.trim_start_matches("sp-").to_string();
        if !raw.is_empty() {
            let spotify_fut = spotify_lyrics::get_spotify_lyrics(raw);
            if let Ok(Ok(sp)) =
                tokio::time::timeout(Duration::from_millis(800), spotify_fut).await
            {
                if sp.synced_lyrics.as_ref().is_some_and(|s| lyrics_cache::looks_synced(s)) {
                    return Some(LyricsResult {
                        synced_lyrics: sp.synced_lyrics,
                        plain_lyrics: sp.plain_lyrics,
                        source: Some("spotify".into()),
                    });
                }
            }
        }
    }

    // Race public sources — each timed so one hang can't break lyrics
    let lrc_fut = async {
        tokio::time::timeout(Duration::from_secs(10), fetch_lrclib(&clean_t, &clean_a, album, duration_ms))
            .await
            .ok()
            .flatten()
    };
    let mxm_fut = async {
        tokio::time::timeout(
            Duration::from_secs(8),
            musixmatch::get_musixmatch_lyrics(clean_t.clone(), clean_a.clone()),
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .and_then(|m| {
            if m.synced_lyrics.is_some() || m.plain_lyrics.is_some() {
                Some(LyricsResult {
                    synced_lyrics: m.synced_lyrics.filter(|s| lyrics_cache::looks_synced(s)),
                    plain_lyrics: m.plain_lyrics,
                    source: Some("musixmatch".into()),
                })
            } else {
                None
            }
        })
    };
    let (lrc, mxm_result) = tokio::join!(lrc_fut, mxm_fut);

    if let Some(r) = lrc.as_ref().filter(|r| r.synced_lyrics.is_some()) {
        return Some(r.clone());
    }
    if let Some(r) = mxm_result.as_ref().filter(|r| r.synced_lyrics.is_some()) {
        return Some(r.clone());
    }
    if let Some(r) = lrc {
        return Some(r);
    }
    if let Some(r) = mxm_result {
        return Some(r);
    }

    // Genius plain — last resort, timed
    if let Ok(Ok(plain)) = tokio::time::timeout(
        Duration::from_secs(8),
        genius::get_genius_lyrics(clean_t, clean_a),
    )
    .await
    {
        if !plain.is_empty() {
            return Some(LyricsResult {
                synced_lyrics: None,
                plain_lyrics: Some(plain),
                source: Some("genius".into()),
            });
        }
    }

    None
}

#[tauri::command]
pub async fn get_lyrics(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    spotify_id: Option<String>,
    cache_key: Option<String>,
    filepath: Option<String>,
    read_sidecar: Option<bool>,
) -> Result<LyricsResult, String> {
    let key = cache_key
        .as_deref()
        .or(filepath.as_deref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 1. Disk cache (works offline; never depends on Harmonoid servers)
    if let Some(ref k) = key {
        if let Some(text) = lyrics_cache::read_cached(&app, k) {
            if lyrics_cache::looks_synced(&text) {
                return Ok(from_text(&text, "cache"));
            }
            let plain_cache = text;
            if let Some(online) = fetch_online(
                &title,
                &artist,
                &album,
                duration_ms,
                spotify_id.as_deref(),
            )
            .await
            {
                persist_result(&app, key.as_deref(), filepath.as_deref(), &online);
                return Ok(online);
            }
            return Ok(from_text(&plain_cache, "cache"));
        }
    }

    if let Some(ref fp) = filepath {
        if key.as_deref() != Some(fp.as_str()) {
            if let Some(text) = lyrics_cache::read_cached(&app, fp) {
                if lyrics_cache::looks_synced(&text) {
                    return Ok(from_text(&text, "cache"));
                }
            }
        }
    }

    // 2. Sidecar beside local file
    if read_sidecar.unwrap_or(true) {
        if let Some(ref fp) = filepath {
            if let Some(text) = lyrics_cache::read_sidecar(fp) {
                let result = from_text(&text, "sidecar");
                if result.synced_lyrics.is_some() {
                    persist_result(&app, key.as_deref(), Some(fp), &result);
                    return Ok(result);
                }
                if let Some(online) = fetch_online(
                    &title,
                    &artist,
                    &album,
                    duration_ms,
                    spotify_id.as_deref(),
                )
                .await
                {
                    if online.synced_lyrics.is_some() {
                        persist_result(&app, key.as_deref(), Some(fp), &online);
                        return Ok(online);
                    }
                }
                persist_result(&app, key.as_deref(), Some(fp), &result);
                return Ok(result);
            }
        }
    }

    // 3. Online (public APIs only)
    if let Some(online) =
        fetch_online(&title, &artist, &album, duration_ms, spotify_id.as_deref()).await
    {
        persist_result(&app, key.as_deref(), filepath.as_deref(), &online);
        return Ok(online);
    }

    Err("No lyrics found from any source".into())
}
