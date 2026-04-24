use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, Emitter};
use tokio::process::Command;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LikedTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub artwork_url: String,
    pub source: String,
    pub stream_url: Option<String>,
    pub local_audio_path: Option<String>,
    pub local_lyrics: Option<String>,
}

pub fn get_liked_dir(app: &tauri::AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let liked_dir = app_dir.join("nekobeat_liked_audio");
    if !liked_dir.exists() {
        let _ = fs::create_dir_all(&liked_dir);
    }
    liked_dir
}

pub fn get_registry_path(app: &tauri::AppHandle) -> PathBuf {
    get_liked_dir(app).join("liked_metadata.json")
}

#[tauri::command]
pub async fn get_liked_tracks(app: tauri::AppHandle) -> Result<Vec<LikedTrack>, String> {
    let registry_path = get_registry_path(&app);
    if registry_path.exists() {
        let content = fs::read_to_string(&registry_path).unwrap_or_else(|_| "[]".to_string());
        let tracks: Vec<LikedTrack> = serde_json::from_str(&content).unwrap_or_else(|_| vec![]);
        Ok(tracks)
    } else {
        Ok(vec![])
    }
}

// Find yt-dlp path gracefully
fn get_yt_dlp_path() -> Result<PathBuf, String> {
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(Path::new("."));
        let candidates = [
            exe_dir.join("yt-dlp.exe"),
            exe_dir.join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("..").join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("..").join("..").join("bin").join("yt-dlp.exe"),
        ];
        for candidate in &candidates {
            if candidate.exists() {
                return Ok(candidate.clone());
            }
        }
        let src_tauri_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("yt-dlp.exe");
        if src_tauri_bin.exists() {
            return Ok(src_tauri_bin);
        }
    }
    Err("yt-dlp not found".to_string())
}

#[tauri::command]
pub async fn toggle_like(app: tauri::AppHandle, mut track: LikedTrack, lyrics: Option<String>) -> Result<bool, String> {
    let liked_dir = get_liked_dir(&app);
    let registry_path = get_registry_path(&app);

    // Read existing tracks
    let mut tracks: Vec<LikedTrack> = if registry_path.exists() {
        let content = fs::read_to_string(&registry_path).unwrap_or_else(|_| "[]".to_string());
        serde_json::from_str(&content).unwrap_or_else(|_| vec![])
    } else {
        vec![]
    };

    // Check if the track is already liked
    if let Some(index) = tracks.iter().position(|t| t.id == track.id) {
        // Unlike: Remove the file and from registry
        println!("Offline: Unliking track {} (id: {})", track.title, track.id);
        let existing_track = tracks.remove(index);
        if let Some(local_path) = &existing_track.local_audio_path {
            let path = PathBuf::from(local_path);
            if path.exists() {
                if let Err(e) = fs::remove_file(&path) {
                    eprintln!("Offline: Failed to remove file {:?}: {}. Spawning retry task.", path, e);
                    // Spawn a background task to retry deleting the locked file
                    let retry_path = path.clone();
                    tokio::spawn(async move {
                        for _ in 0..12 {
                            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                            if fs::remove_file(&retry_path).is_ok() {
                                println!("Offline: Successfully deleted locked file {:?} after retries.", retry_path);
                                break;
                            }
                        }
                    });
                } else {
                    println!("Offline: Deleted saved audio file {:?}", path);
                }
            } else {
                println!("Offline: File {:?} not found for deletion", path);
            }
        }
        match fs::write(&registry_path, serde_json::to_string_pretty(&tracks).unwrap()) {
            Ok(_) => println!("Offline: Registry updated after unlike"),
            Err(e) => eprintln!("Offline: Failed to update registry: {}", e),
        }
        Ok(false) // Liked is now false
    } else {
        // Like: Save metadata immediately, then download in background
        let app_handle = app.clone();
        
        track.local_lyrics = lyrics;

        // Save to registry immediately so the track appears in Liked list right away
        tracks.push(track.clone());
        fs::write(&registry_path, serde_json::to_string_pretty(&tracks).unwrap())
            .map_err(|e| format!("Failed to save liked registry: {}", e))?;
        let _ = app_handle.emit("liked-track-downloaded", ());

        // Background: resolve stream URL and download the audio file
        tokio::spawn(async move {
            let safe_id = track.id.replace(|c: char| !c.is_alphanumeric(), "_");
            let output_base = liked_dir.join(format!("nekobeat_liked_{}", safe_id));
            
            // Build the URL to resolve
            let source_url = if track.source == "youtube" {
                format!("https://www.youtube.com/watch?v={}", track.id.replace("yt-", ""))
            } else if track.source == "soundcloud" {
                format!("https://api-v2.soundcloud.com/tracks/{}", track.id.replace("sc-", ""))
            } else if track.source == "spotify" {
                format!("https://open.spotify.com/track/{}", track.id.replace("sp-", ""))
            } else {
                track.stream_url.clone().unwrap_or_else(|| track.id.clone())
            };

            println!("Offline: Downloading '{}' from {} ...", track.title, track.source);

            // Step 1: Check if stream_url is already a local file (copy it)
            let existing_stream = track.stream_url.clone().unwrap_or_default();
            if existing_stream.starts_with("file://") {
                let file_path = existing_stream.strip_prefix("file:///")
                    .or_else(|| existing_stream.strip_prefix("file://"))
                    .unwrap_or(&existing_stream);
                let source_file = PathBuf::from(file_path);
                if source_file.exists() {
                    let ext = source_file.extension().unwrap_or_default().to_string_lossy();
                    let ext = if ext.is_empty() { "m4a".to_string() } else { ext.to_string() };
                    let final_path = PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
                    if fs::copy(&source_file, &final_path).is_ok() {
                        println!("Offline: Copied local file -> {:?}", final_path);
                        update_liked_local_path(&registry_path, &track.id, &final_path);
                        let _ = app_handle.emit("liked-track-downloaded", ());
                        return;
                    }
                }
            }

            // Step 2: Resolve to a direct stream URL using our resolver
            let resolved = crate::aggregator::resolver::resolve_url(&app_handle, &source_url).await;
            
            match resolved {
                Ok(resolved_url) => {
                    if resolved_url.starts_with("file://") {
                        // Resolver returned a local file, copy it
                        let file_path = resolved_url.strip_prefix("file:///")
                            .or_else(|| resolved_url.strip_prefix("file://"))
                            .unwrap_or(&resolved_url);
                        let source_file = PathBuf::from(file_path);
                        if source_file.exists() {
                            let ext = source_file.extension().unwrap_or_default().to_string_lossy();
                            let ext = if ext.is_empty() { "m4a".to_string() } else { ext.to_string() };
                            let final_path = PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
                            if fs::copy(&source_file, &final_path).is_ok() {
                                println!("Offline: Copied resolved local file -> {:?}", final_path);
                                update_liked_local_path(&registry_path, &track.id, &final_path);
                                let _ = app_handle.emit("liked-track-downloaded", ());
                                return;
                            }
                        }
                    }
                    
                    // It's an HTTP URL — download with reqwest
                    println!("Offline: Downloading from HTTP: {}...", &resolved_url[..std::cmp::min(resolved_url.len(), 80)]);
                    let client = reqwest::Client::builder()
                        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                        .build();

                    if let Ok(client) = client {
                        match client.get(&resolved_url).send().await {
                            Ok(resp) => {
                                if resp.status().is_success() {
                                    // Determine file extension from content-type
                                    let content_type = resp.headers()
                                        .get("content-type")
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or("");
                                    let ext = if content_type.contains("mp4") || content_type.contains("m4a") {
                                        "m4a"
                                    } else if content_type.contains("webm") {
                                        "webm"
                                    } else if content_type.contains("opus") {
                                        "opus"
                                    } else if content_type.contains("ogg") {
                                        "ogg"
                                    } else {
                                        "mp3"
                                    };
                                    
                                    let final_path = PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
                                    
                                    match resp.bytes().await {
                                        Ok(bytes) if !bytes.is_empty() => {
                                            if fs::write(&final_path, &bytes).is_ok() {
                                                println!("Offline: Downloaded {} bytes -> {:?}", bytes.len(), final_path);
                                                update_liked_local_path(&registry_path, &track.id, &final_path);
                                                let _ = app_handle.emit("liked-track-downloaded", ());
                                                return;
                                            }
                                        }
                                        Ok(_) => eprintln!("Offline: Downloaded empty response"),
                                        Err(e) => eprintln!("Offline: Failed to read response bytes: {}", e),
                                    }
                                } else {
                                    eprintln!("Offline: HTTP download failed with status {}", resp.status());
                                }
                            }
                            Err(e) => eprintln!("Offline: HTTP request failed: {}", e),
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Offline: Resolver failed: {}. Trying yt-dlp fallback...", e);
                    
                    // Step 3: Last resort — try yt-dlp if available
                    if let Ok(ytdlp_path) = get_yt_dlp_path() {
                        let output = Command::new(&ytdlp_path)
                            .arg(&source_url)
                            .arg("--format")
                            .arg("bestaudio[ext=m4a]/bestaudio/best")
                            .arg("--extract-audio")
                            .arg("--output")
                            .arg(format!("{}.%(ext)s", output_base.to_string_lossy()))
                            .output()
                            .await;
                        
                        if let Ok(cmd_out) = output {
                            if cmd_out.status.success() {
                                for ext in &["m4a", "webm", "mp3", "opus"] {
                                    let possible = PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
                                    if possible.exists() {
                                        println!("Offline: yt-dlp downloaded -> {:?}", possible);
                                        update_liked_local_path(&registry_path, &track.id, &possible);
                                        let _ = app_handle.emit("liked-track-downloaded", ());
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    eprintln!("Offline: All download methods failed for '{}'", track.title);
                }
            }
        });
        Ok(true)
    }
}

/// Helper to update a liked track's local_audio_path in the registry on disk
fn update_liked_local_path(registry_path: &Path, track_id: &str, local_path: &Path) {
    let content = fs::read_to_string(registry_path).unwrap_or_else(|_| "[]".to_string());
    let mut tracks: Vec<LikedTrack> = serde_json::from_str(&content).unwrap_or_else(|_| vec![]);
    if let Some(t) = tracks.iter_mut().find(|t| t.id == track_id) {
        t.local_audio_path = Some(local_path.to_string_lossy().into_owned());
        if let Err(e) = fs::write(registry_path, serde_json::to_string_pretty(&tracks).unwrap()) {
            eprintln!("Offline: Failed to update local_audio_path: {}", e);
        } else {
            println!("Offline: Updated local_audio_path for {} -> {:?}", track_id, local_path);
        }
    }
}

/// Check if a downloaded audio file exists on disk for this track ID
#[tauri::command]
pub async fn check_liked_cache(app: tauri::AppHandle, track_id: String) -> Result<Option<String>, String> {
    let liked_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("nekobeat_liked_audio");
    
    let safe_id = track_id.replace(|c: char| !c.is_alphanumeric(), "_");
    let base = format!("nekobeat_liked_{}", safe_id);
    
    for ext in &["flac", "m4a", "webm", "opus", "ogg", "mp3", "wav"] {
        let path = liked_dir.join(format!("{}.{}", base, ext));
        if path.exists() {
            // Ensure file is not empty/corrupt (at least 10KB)
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() > 10_000 {
                    let path_str = path.to_string_lossy().into_owned();
                    // Also update the registry so future plays use it directly
                    let registry_path = get_registry_path(&app);
                    update_liked_local_path(&registry_path, &track_id, &path);
                    return Ok(Some(path_str));
                }
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn convert_srt_vtt_to_lrc(content: String) -> String {
    let mut lrc = String::new();
    let re_srt = regex::Regex::new(r"(\d+)\s+(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\s+([\s\S]*?)(?:\n\n|\z)").unwrap();
    let re_vtt = regex::Regex::new(r"(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\s+([\s\S]*?)(?:\n\n|\z)").unwrap();

    // Try SRT first
    let mut found = false;
    for cap in re_srt.captures_iter(&content) {
        found = true;
        let start_time = &cap[2].replace(',', ".");
        // Convert HH:MM:SS.mmm to [MM:SS.xx]
        if let Some(lrc_time) = format_lrc_time(start_time) {
            let text = cap[4].replace('\n', " ");
            lrc.push_str(&format!("[{}] {}\n", lrc_time, text.trim()));
        }
    }

    if !found {
        // Try VTT
        for cap in re_vtt.captures_iter(&content) {
            let start_time = &cap[1];
            if let Some(lrc_time) = format_lrc_time(start_time) {
                let text = cap[3].replace('\n', " ");
                lrc.push_str(&format!("[{}] {}\n", lrc_time, text.trim()));
            }
        }
    }

    if lrc.is_empty() { content.to_string() } else { lrc }
}

fn format_lrc_time(time_str: &str) -> Option<String> {
    // Input: HH:MM:SS.mmm
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let hrs: u32 = parts[0].parse().unwrap_or(0);
        let mins: u32 = parts[1].parse().unwrap_or(0);
        let secs_parts: Vec<&str> = parts[2].split('.').collect();
        if secs_parts.len() == 2 {
            let secs: u32 = secs_parts[0].parse().unwrap_or(0);
            let ms: u32 = secs_parts[1].parse().unwrap_or(0);
            
            let total_mins = hrs * 60 + mins;
            let centisecs = ms / 10;
            return Some(format!("{:02}:{:02}.{:02}", total_mins, secs, centisecs));
        }
    }
    None
}

#[tauri::command]
pub async fn update_track_lyrics(app: tauri::AppHandle, track_id: String, filepath: Option<String>, lyrics: String) -> Result<(), String> {
    let processed_lyrics = if lyrics.contains("-->") {
        convert_srt_vtt_to_lrc(lyrics.clone())
    } else {
        lyrics
    };

    // 1. Check if it's a local track (SQLite)
    if let Some(path) = filepath {
        if Path::new(&path).exists() {
            println!("Offline: Updating local track lyrics at {:?}", path);
            let conn = crate::library::init_db().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE tracks SET local_lyrics = ?1 WHERE filepath = ?2",
                rusqlite::params![processed_lyrics, path],
            ).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    // 2. Otherwise update the Liked registry
    let registry_path = get_registry_path(&app);
    if registry_path.exists() {
        let content = fs::read_to_string(&registry_path).map_err(|e| e.to_string())?;
        let mut tracks: Vec<LikedTrack> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        
        if let Some(track) = tracks.iter_mut().find(|t| t.id == track_id) {
            track.local_lyrics = Some(processed_lyrics);
            fs::write(&registry_path, serde_json::to_string_pretty(&tracks).unwrap()).map_err(|e| e.to_string())?;
            println!("Offline: Updated liked track lyrics for id {}", track_id);
            return Ok(());
        }
    }

    Err("Track not found in Library or Liked tracks".to_string())
}
