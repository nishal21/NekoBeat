use reqwest::Client;
use serde_json::Value;
use regex::Regex;

#[tauri::command]
pub async fn get_genius_lyrics(title: String, artist: String) -> Result<String, String> {
    let client = Client::new();
    
    // 1. Search for the song
    // Sanitize title and artist
    let clean_title = title.replace(r#"(\[.*?\]|\(.*?\))"#, "").trim().to_string();
    let clean_artist = artist.to_lowercase().replace("- topic", "").replace("-topic", "").trim().to_string();
    
    let query = format!("{} {}", clean_title, clean_artist);
    println!("Genius: Searching for: {}", query);
    
    let search_url = format!("https://genius.com/api/search/multi?per_page=5&q={}", urlencoding::encode(&query));
    
    let search_res: Value = client.get(&search_url)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    // Find the song section
    let mut song_url = None;
    if let Some(sections) = search_res["response"]["sections"].as_array() {
        for section in sections {
            if section["type"] == "song" {
                if let Some(hits) = section["hits"].as_array() {
                    if let Some(first_hit) = hits.first() {
                        if let Some(url) = first_hit["result"]["url"].as_str() {
                            song_url = Some(url.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    let song_url = match song_url {
        Some(url) => url,
        None => return Err(format!("No lyrics found on Genius for '{}'", query)),
    };

    println!("Genius: Found lyrics URL: {}", song_url);

    // 2. Fetch the lyrics HTML page
    let html = client.get(&song_url)
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;

    // 3. Extract lyrics from HTML
    // Genius puts lyrics inside <div data-lyrics-container="true" class="...">...</div>
    // Because HTML can contain newlines inside tags, we'll use a regex strategy:
    // Some lyrics are spread across multiple data-lyrics-container divs.
    
    // A simpler way without a full HTML parser: 
    // Find all <div data-lyrics-container="true"...> and extract everything until the NEXT </div>
    // Actually, Genius HTML structure can be tricky, but mostly they don't nest divs heavily inside lyrics containers.
    // They usually nest <a> spans though.
    // Let's just find the start of the container, and since it might contain child elements,
    // a pure regex for `.*?</div>` might stop too early if there's a nested </div>.
    // Luckily, Genius lyrics containers usually contain only text, <br>, <a>, <span>, <i>, <b>.
    // They rarely contain nested <div>. So `</div>` should mark the end.
    
    let container_re = Regex::new(r#"(?s)<div data-lyrics-container="true"[^>]*>(.*?)</div>"#).unwrap();
    let mut extracted_lyrics = String::new();
    
    for cap in container_re.captures_iter(&html) {
        if let Some(m) = cap.get(1) {
            extracted_lyrics.push_str(m.as_str());
            extracted_lyrics.push_str("\n\n");
        }
    }

    if extracted_lyrics.is_empty() {
        return Err("Could not extract lyrics from Genius page HTML".to_string());
    }

    // Clean up HTML tags
    // Replace <br/> or <br> with newlines
    let br_re = Regex::new(r#"(?i)<br\s*/?>"#).unwrap();
    extracted_lyrics = br_re.replace_all(&extracted_lyrics, "\n").to_string();
    
    // Strip other HTML tags
    let tag_re = Regex::new(r#"(?s)<[^>]*>"#).unwrap();
    extracted_lyrics = tag_re.replace_all(&extracted_lyrics, "").to_string();

    // Decode HTML entities (basic ones)
    extracted_lyrics = extracted_lyrics.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ");

    Ok(extracted_lyrics.trim().to_string())
}
