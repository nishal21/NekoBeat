use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use reqwest;
use futures::future::join_all;
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NewsTrack {
    pub title: String,
    pub artist: String,
    pub artwork_url: String,
    pub url: String,
    pub release_date: String,
    /// "apple" | "lastfm" | "jiosaavn"
    pub source: String,
    /// ISO country for regional rows (e.g. "in"); empty for Last.fm
    #[serde(default)]
    pub country: String,
}

fn sanitize_country(country: Option<String>) -> String {
    let raw = country.unwrap_or_else(|| "us".into());
    let cc = raw.trim().to_lowercase();
    if cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic()) {
        cc
    } else {
        "us".into()
    }
}

fn dedupe_key(artist: &str, title: &str) -> String {
    format!(
        "{}|{}",
        artist.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" "),
        title.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn decode_basic_entities(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#039;", "'")
        .replace("&apos;", "'")
}

fn push_unique(seen: &mut HashSet<String>, out: &mut Vec<NewsTrack>, tracks: Vec<NewsTrack>) {
    for t in tracks {
        let key = dedupe_key(&t.artist, &t.title);
        if seen.insert(key) {
            out.push(t);
        }
    }
}

#[tauri::command]
pub async fn get_music_news(country: Option<String>) -> Result<Vec<NewsTrack>, String> {
    let country = sanitize_country(country);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let apple_client = client.clone();
    let apple_cc = country.clone();
    let apple_task = tokio::spawn(async move { fetch_apple_regional(apple_client, apple_cc).await });

    // JioSaavn is India-only: never fetched for US/GB/JP/etc.
    // Foreign users can opt in via Settings → region → India.
    let jio_task = if country == "in" {
        let c = client.clone();
        Some(tokio::spawn(async move { fetch_jiosaavn_new(c).await }))
    } else {
        None
    };

    let page_count = 5;
    let mut lfm_tasks = Vec::new();
    for page in 1..=page_count {
        let url = format!("https://www.last.fm/music/+releases/out-now/popular?page={}", page);
        let client_clone = client.clone();
        lfm_tasks.push(tokio::spawn(async move { fetch_news_page(client_clone, url).await }));
    }

    let apple_join = apple_task;
    let lfm_joins_fut = join_all(lfm_tasks);

    let (apple_join, lfm_joins, jio_join) = if let Some(jio) = jio_task {
        let (a, l, j) = tokio::join!(apple_join, lfm_joins_fut, jio);
        (a, l, Some(j))
    } else {
        let (a, l) = tokio::join!(apple_join, lfm_joins_fut);
        (a, l, None)
    };

    let mut jio_tracks = Vec::new();
    if let Some(j) = jio_join {
        match j {
            Ok(Ok(tracks)) => jio_tracks = tracks,
            Ok(Err(e)) => println!("JioSaavn news error: {}", e),
            Err(e) => println!("JioSaavn news task panicked: {}", e),
        }
    }

    let mut apple_tracks = Vec::new();
    match apple_join {
        Ok(Ok(tracks)) => apple_tracks = tracks,
        Ok(Err(e)) => println!("Apple regional news error: {}", e),
        Err(e) => println!("Apple regional task panicked: {}", e),
    }

    let mut lastfm_tracks = Vec::new();
    for res in lfm_joins {
        match res {
            Ok(Ok(mut tracks)) => lastfm_tracks.append(&mut tracks),
            Ok(Err(e)) => println!("Last.fm news page error: {}", e),
            Err(e) => println!("Last.fm news task panicked: {}", e),
        }
    }

    // Merge order: regional-first, then global Last.fm.
    // JioSaavn tracks only exist in `jio_tracks` when country == "in".
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged = Vec::new();
    if country == "in" {
        push_unique(&mut seen, &mut merged, jio_tracks);
    }
    push_unique(&mut seen, &mut merged, apple_tracks);
    push_unique(&mut seen, &mut merged, lastfm_tracks);

    Ok(merged)
}

#[derive(Debug, Deserialize)]
struct AppleFeed {
    feed: AppleFeedInner,
}

#[derive(Debug, Deserialize)]
struct AppleFeedInner {
    results: Vec<AppleAlbum>,
}

#[derive(Debug, Deserialize)]
struct AppleAlbum {
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    name: Option<String>,
    #[serde(rename = "releaseDate")]
    release_date: Option<String>,
    #[serde(rename = "artworkUrl100")]
    artwork_url_100: Option<String>,
    url: Option<String>,
}

async fn fetch_apple_regional(client: reqwest::Client, country: String) -> Result<Vec<NewsTrack>, String> {
    // Songs chart for IN is more local; albums for everyone else
    let kind = if country == "in" { "songs" } else { "albums" };
    let url = format!(
        "https://rss.marketingtools.apple.com/api/v2/{}/music/most-played/50/{}.json",
        country, kind
    );
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Apple RSS HTTP {}", response.status()));
    }
    let body: AppleFeed = response.json().await.map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();

    for item in body.feed.results {
        let title = item.name.unwrap_or_default().trim().to_string();
        let artist = item.artist_name.unwrap_or_default().trim().to_string();
        if title.is_empty() || artist.is_empty() {
            continue;
        }
        let artwork_url = item
            .artwork_url_100
            .unwrap_or_default()
            .replace("100x100bb", "600x600bb");
        let release_date = item.release_date.unwrap_or_default();
        let url = item.url.unwrap_or_default();

        tracks.push(NewsTrack {
            title,
            artist,
            artwork_url,
            url,
            release_date,
            source: "apple".into(),
            country: country.clone(),
        });
    }

    Ok(tracks)
}

#[derive(Debug, Deserialize)]
struct JioFeed {
    data: Vec<JioItem>,
}

#[derive(Debug, Deserialize)]
struct JioItem {
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(rename = "perma_url")]
    perma_url: Option<String>,
    image: Option<String>,
    #[serde(rename = "more_info")]
    more_info: Option<JioMoreInfo>,
}

#[derive(Debug, Deserialize)]
struct JioMoreInfo {
    #[serde(rename = "release_date")]
    release_date: Option<String>,
    #[serde(rename = "artistMap")]
    artist_map: Option<JioArtistMap>,
}

#[derive(Debug, Deserialize)]
struct JioArtistMap {
    #[serde(rename = "primary_artists")]
    primary_artists: Option<Vec<JioArtist>>,
}

#[derive(Debug, Deserialize)]
struct JioArtist {
    name: Option<String>,
}

/// Unofficial JioSaavn “new” feed — strong Hindi / Bollywood / Indian catalog (no API key).
async fn fetch_jiosaavn_new(client: reqwest::Client) -> Result<Vec<NewsTrack>, String> {
    let url = "https://www.jiosaavn.com/api.php?__call=content.getAlbums&api_version=4&_format=json&_marker=0&n=40&p=1&ctx=web6dot0";
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("JioSaavn HTTP {}", response.status()));
    }
    let body: JioFeed = response.json().await.map_err(|e| e.to_string())?;
    let mut tracks = Vec::new();

    for item in body.data {
        let title = decode_basic_entities(item.title.unwrap_or_default().trim());
        if title.is_empty() {
            continue;
        }

        let mut artist = String::new();
        if let Some(info) = &item.more_info {
            if let Some(map) = &info.artist_map {
                if let Some(primaries) = &map.primary_artists {
                    artist = primaries
                        .iter()
                        .filter_map(|a| a.name.as_ref())
                        .take(2)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ");
                }
            }
        }
        if artist.is_empty() {
            let sub = decode_basic_entities(item.subtitle.unwrap_or_default().trim());
            artist = sub
                .split(" - ")
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
        }
        if artist.is_empty() {
            continue;
        }

        let release_date = item
            .more_info
            .as_ref()
            .and_then(|m| m.release_date.clone())
            .unwrap_or_default();
        let artwork_url = item
            .image
            .unwrap_or_default()
            .replace("150x150", "500x500");
        let url = item.perma_url.unwrap_or_default();

        tracks.push(NewsTrack {
            title,
            artist,
            artwork_url,
            url,
            release_date,
            source: "jiosaavn".into(),
            country: "in".into(),
        });
    }

    Ok(tracks)
}

async fn fetch_news_page(client: reqwest::Client, url: String) -> Result<Vec<NewsTrack>, String> {
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let html_content = response.text().await.map_err(|e| e.to_string())?;

    let document = Html::parse_document(&html_content);
    let mut tracks = Vec::new();

    let item_selector = Selector::parse(".resource-list--release-list-item").map_err(|_| "Failed to parse item selector")?;
    let title_selector = Selector::parse(".link-block-target").map_err(|_| "Failed to parse title selector")?;
    let artist_selector = Selector::parse(".resource-list--release-list-item-artist").map_err(|_| "Failed to parse artist selector")?;
    let img_selector = Selector::parse(".resource-list--release-list-item-image img").map_err(|_| "Failed to parse img selector")?;
    let date_selector = Selector::parse(".resource-list--release-list-item-date").map_err(|_| "Failed to parse date selector")?;

    for element in document.select(&item_selector) {
        let title_elem = element.select(&title_selector).next();
        let title = title_elem
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let artist = element
            .select(&artist_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let artwork_url = element
            .select(&img_selector)
            .next()
            .and_then(|e| e.value().attr("src"))
            .unwrap_or_default()
            .replace("64s", "300s")
            .to_string();

        let release_date = element
            .select(&date_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let url_path = title_elem
            .and_then(|e| e.value().attr("href"))
            .unwrap_or_default()
            .to_string();

        let full_url = if url_path.starts_with("http") {
            url_path
        } else {
            format!("https://www.last.fm{}", url_path)
        };

        if !title.is_empty() && !artist.is_empty() {
            tracks.push(NewsTrack {
                title,
                artist,
                artwork_url,
                url: full_url,
                release_date,
                source: "lastfm".into(),
                country: String::new(),
            });
        }
    }

    Ok(tracks)
}
