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
        // Like: Process the download asynchronously without blocking the UI
        let app_handle = app.clone();
        
        track.local_lyrics = lyrics;

        tokio::spawn(async move {
            let output_template = liked_dir.join(format!("nekobeat_liked_{}", track.id.replace(|c: char| !c.is_alphanumeric(), "_")));
            
            // Try to resolve the URL to download
            let download_url = track.stream_url.clone().unwrap_or_else(|| {
                if track.source == "youtube" {
                    format!("https://www.youtube.com/watch?v={}", track.id.replace("yt-", ""))
                } else if track.source == "soundcloud" {
                    format!("https://api-v2.soundcloud.com/tracks/{}", track.id.replace("sc-", ""))
                } else {
                    track.id.clone()
                }
            });

            // If the stream was already resolved to a local temp file, just copy it!
            if download_url.starts_with("file://") {
                let source_file = PathBuf::from(download_url.trim_start_matches("file://"));
                if source_file.exists() {
                    let ext = source_file.extension().unwrap_or_default().to_string_lossy();
                    let ext = if ext.is_empty() { "m4a".to_string() } else { ext.to_string() };
                    let final_path = PathBuf::from(format!("{}.{}", output_template.to_string_lossy(), ext));
                    if fs::copy(&source_file, &final_path).is_ok() {
                        track.local_audio_path = Some(final_path.to_string_lossy().into_owned());
                    }
                }
            } else if let Ok(ytdlp_path) = get_yt_dlp_path() {
                // Otherwise, use yt-dlp to download it
                println!("Offline: Background downloading {} via yt-dlp...", track.title);
                
                let output = Command::new(&ytdlp_path)
                    .arg(&download_url)
                    .arg("--format")
                    .arg("bestaudio[ext=m4a]/bestaudio/best")
                    .arg("--extract-audio")
                    // Avoid forcing audio-format if we don't have ffmpeg, let yt-dlp pick best natively
                    .arg("--output")
                    .arg(format!("{}.%(ext)s", output_template.to_string_lossy()))
                    .output()
                    .await;
                
                if let Ok(cmd_out) = output {
                    if cmd_out.status.success() {
                        // Assuming m4a or webm or mp3
                        let extensions = ["m4a", "webm", "mp3", "opus"];
                        for ext in extensions {
                            let possible_file = PathBuf::from(format!("{}.{}", output_template.to_string_lossy(), ext));
                            if possible_file.exists() {
                                track.local_audio_path = Some(possible_file.to_string_lossy().into_owned());
                                break;
                            }
                        }
                    } else {
                        eprintln!("Offline: yt-dlp download failed: {}", String::from_utf8_lossy(&cmd_out.stderr));
                    }
                }
            }

            // Re-read tracks from disk to avoid overwriting changes (like unlikes) that happened during download
            let mut current_tracks: Vec<LikedTrack> = if registry_path.exists() {
                let content = fs::read_to_string(&registry_path).unwrap_or_else(|_| "[]".to_string());
                serde_json::from_str(&content).unwrap_or_else(|_| vec![])
            } else {
                vec![]
            };

            // Check if user unliked while downloading. If so, don't append.
            if current_tracks.iter().any(|t| t.id == track.id) {
                // If it's somehow already there (e.g. rapid clicking), replace it
                if let Some(pos) = current_tracks.iter().position(|t| t.id == track.id) {
                    current_tracks[pos] = track;
                }
            } else {
                current_tracks.push(track);
            }

            if let Err(e) = fs::write(&registry_path, serde_json::to_string_pretty(&current_tracks).unwrap()) {
                eprintln!("Offline: Failed to save to Liked registry: {}", e);
            } else {
                println!("Offline: Checked and successfully saved to Liked registry.");
            }
            
            // Optionally emit an event back to the frontend to say download finished
            let _ = app_handle.emit("liked-track-downloaded", ());
        });
        Ok(true)
    }
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
