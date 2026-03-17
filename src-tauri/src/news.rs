use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use reqwest;
use futures::future::join_all;

#[derive(Debug, Serialize, Deserialize)]
pub struct NewsTrack {
    pub title: String,
    pub artist: String,
    pub artwork_url: String,
    pub url: String,
    pub release_date: String,
}

#[tauri::command]
pub async fn get_music_news() -> Result<Vec<NewsTrack>, String> {
    // Scrape 5 pages in parallel
    let page_count = 5;
    let mut tasks = Vec::new();

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    for page in 1..=page_count {
        let url = format!("https://www.last.fm/music/+releases/out-now/popular?page={}", page);
        let client_clone = client.clone();
        tasks.push(tokio::spawn(async move {
            fetch_news_page(client_clone, url).await
        }));
    }

    let results = join_all(tasks).await;
    let mut all_tracks = Vec::new();

    for res in results {
        match res {
            Ok(Ok(mut tracks)) => all_tracks.append(&mut tracks),
            Ok(Err(e)) => println!("Error fetching page: {}", e),
            Err(e) => println!("Task panicked: {}", e),
        }
    }

    Ok(all_tracks)
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
    // Updated selector based on browser subagent findings
    let date_selector = Selector::parse(".resource-list--release-list-item-date").map_err(|_| "Failed to parse date selector")?;

    for element in document.select(&item_selector) {
        let title_elem = element.select(&title_selector).next();
        let title = title_elem.map(|e| e.text().collect::<String>().trim().to_string()).unwrap_or_default();
        
        let artist = element.select(&artist_selector).next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
            
        let artwork_url = element.select(&img_selector).next()
            .and_then(|e| e.value().attr("src"))
            .unwrap_or_default()
            .replace("64s", "300s")
            .to_string();

        let release_date = element.select(&date_selector).next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
            
        let url_path = title_elem.and_then(|e| e.value().attr("href")).unwrap_or_default().to_string();
        
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
            });
        }
    }

    Ok(tracks)
}
