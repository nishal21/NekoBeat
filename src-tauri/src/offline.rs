use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, Emitter};
use tokio::process::Command;

fn liked_backfill_attempted() -> &'static Mutex<HashSet<String>> {
    static ATTEMPTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ATTEMPTED.get_or_init(|| Mutex::new(HashSet::new()))
}

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
    /// Local cover file under nekobeat_liked_audio (offline art).
    #[serde(default)]
    pub local_artwork_path: Option<String>,
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

/// Parse file:// URIs and raw Windows/Unix paths into an existing PathBuf.
fn local_path_from_stream_url(url: Option<&str>) -> Option<PathBuf> {
    let raw = url?.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return None;
    }

    let mut path_str = raw
        .strip_prefix("file:///")
        .or_else(|| raw.strip_prefix("file://"))
        .unwrap_or(raw)
        .to_string();

    // Windows extended path \\?\C:\... or URI-encoded form
    if let Some(rest) = path_str.strip_prefix("//?/") {
        path_str = rest.to_string();
    }
    if let Some(rest) = path_str.strip_prefix(r"\\?\") {
        path_str = rest.to_string();
    }
    path_str = path_str.replace('/', r"\");

    let path = PathBuf::from(&path_str);
    if path.is_file() {
        return Some(path);
    }
    // Also try forward-slash form (WSL / some URIs)
    let alt = PathBuf::from(path_str.replace('\\', "/"));
    if alt.is_file() {
        return Some(alt);
    }
    None
}

/// Find a downloaded YouTube audio file in the app yt_audio cache by video id.
fn find_yt_audio_cache(app: &tauri::AppHandle, video_id: &str) -> Option<PathBuf> {
    let vid = video_id.trim();
    if vid.is_empty() {
        return None;
    }
    // Same roots as resolver::yt_cache_dir (+ local data fallback from real Windows paths)
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(d) = app.path().app_cache_dir() {
        dirs.push(d.join("yt_audio"));
    }
    if let Ok(d) = app.path().app_data_dir() {
        dirs.push(d.join("yt_audio"));
    }
    if let Ok(d) = app.path().app_local_data_dir() {
        dirs.push(d.join("yt_audio"));
    }
    for dir in dirs {
        if let Some(p) = find_yt_in_dir(&dir, vid) {
            return Some(p);
        }
    }
    None
}

fn find_yt_in_dir(dir: &Path, video_id: &str) -> Option<PathBuf> {
    for ext in &["webm", "m4a", "mp4", "opus", "ogg", "mp3"] {
        let p = dir.join(format!("{}.{}", video_id, ext));
        if p.is_file() {
            if let Ok(meta) = fs::metadata(&p) {
                if meta.len() > 10_000 {
                    return Some(p);
                }
            }
        }
    }
    // Prefix match (some tools add suffixes)
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(video_id) && entry.path().is_file() {
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > 10_000 {
                        return Some(entry.path());
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_liked_tracks(app: tauri::AppHandle) -> Result<Vec<LikedTrack>, String> {
    let registry_path = get_registry_path(&app);
    if !registry_path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&registry_path).unwrap_or_else(|_| "[]".to_string());
    let mut tracks: Vec<LikedTrack> = serde_json::from_str(&content).unwrap_or_else(|_| vec![]);
    let liked_dir = get_liked_dir(&app);
    let mut dirty = false;
    let mut backfill: Vec<LikedTrack> = Vec::new();

    for t in &mut tracks {
        let missing_audio = t
            .local_audio_path
            .as_ref()
            .map(|p| !Path::new(p).is_file())
            .unwrap_or(true);
        if missing_audio {
            if let Ok(Some(path)) = check_liked_cache(app.clone(), t.id.clone()).await {
                t.local_audio_path = Some(path);
                dirty = true;
            }
        }

        // Hydrate local artwork from disk if registry path missing/stale
        let art_missing = t
            .local_artwork_path
            .as_ref()
            .map(|p| !Path::new(p).is_file())
            .unwrap_or(true);
        if art_missing {
            if let Some(art) = find_liked_artwork_file(&liked_dir, &t.id) {
                t.local_artwork_path = Some(art.to_string_lossy().into_owned());
                dirty = true;
            }
        }

        let needs_art = t
            .local_artwork_path
            .as_ref()
            .map(|p| !Path::new(p).is_file())
            .unwrap_or(true)
            && t.artwork_url.starts_with("http");
        let needs_lyrics = t
            .local_lyrics
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);

        // Clear stale local art pointers that point at missing files so UI uses CDN art
        if let Some(ref p) = t.local_artwork_path {
            if !Path::new(p).is_file() {
                t.local_artwork_path = None;
                dirty = true;
            }
        }

        let already = liked_backfill_attempted()
            .lock()
            .map(|s| s.contains(&t.id))
            .unwrap_or(true);
        if !already && (needs_art || needs_lyrics) {
            backfill.push(t.clone());
        }
    }

    if dirty {
        if let Ok(json) = serde_json::to_string_pretty(&tracks) {
            let _ = fs::write(&registry_path, json);
        }
    }

    if !backfill.is_empty() {
        if let Ok(mut set) = liked_backfill_attempted().lock() {
            for t in &backfill {
                set.insert(t.id.clone());
            }
        }
        let app_bg = app.clone();
        tokio::spawn(async move {
            for t in backfill {
                backfill_liked_offline_assets(&app_bg, &t).await;
            }
            let _ = app_bg.emit("liked-track-downloaded", ());
        });
    }

    Ok(tracks)
}

fn find_liked_artwork_file(liked_dir: &Path, track_id: &str) -> Option<PathBuf> {
    let safe_id = track_id.replace(|c: char| !c.is_alphanumeric(), "_");
    let base = format!("nekobeat_liked_{}", safe_id);
    for ext in &["jpg", "jpeg", "png", "webp"] {
        let path = liked_dir.join(format!("{}.{}", base, ext));
        if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() > 200 {
                    return Some(path);
                }
            }
        }
    }
    None
}

async fn download_liked_artwork(url: &str, output_base: &Path) -> Option<PathBuf> {
    let url = url.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let ext = if content_type.contains("png") {
        "png"
    } else if content_type.contains("webp") {
        "webp"
    } else if content_type.contains("gif") {
        "gif"
    } else {
        "jpg"
    };
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() < 200 {
        return None;
    }
    let path = PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
    // Clear other art extensions for this id
    if let Some(parent) = path.parent() {
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            for old in &["jpg", "jpeg", "png", "webp", "gif"] {
                let other = parent.join(format!("{}.{}", stem, old));
                if other != path && other.exists() {
                    let _ = fs::remove_file(other);
                }
            }
        }
    }
    tokio::fs::write(&path, &bytes).await.ok()?;
    println!("Offline: Saved liked artwork -> {:?}", path);
    Some(path)
}

fn update_liked_artwork_path(registry_path: &Path, track_id: &str, local_path: &Path) {
    let content = fs::read_to_string(registry_path).unwrap_or_else(|_| "[]".to_string());
    let mut tracks: Vec<LikedTrack> = serde_json::from_str(&content).unwrap_or_else(|_| vec![]);
    if let Some(t) = tracks.iter_mut().find(|t| t.id == track_id) {
        t.local_artwork_path = Some(local_path.to_string_lossy().into_owned());
        if let Err(e) = fs::write(registry_path, serde_json::to_string_pretty(&tracks).unwrap()) {
            eprintln!("Offline: Failed to update local_artwork_path: {}", e);
        }
    }
}

fn update_liked_lyrics_text(registry_path: &Path, track_id: &str, lyrics: &str) {
    let lyrics = lyrics.trim();
    if lyrics.is_empty() {
        return;
    }
    let content = fs::read_to_string(registry_path).unwrap_or_else(|_| "[]".to_string());
    let mut tracks: Vec<LikedTrack> = serde_json::from_str(&content).unwrap_or_else(|_| vec![]);
    if let Some(t) = tracks.iter_mut().find(|t| t.id == track_id) {
        t.local_lyrics = Some(lyrics.to_string());
        if let Err(e) = fs::write(registry_path, serde_json::to_string_pretty(&tracks).unwrap()) {
            eprintln!("Offline: Failed to update local_lyrics: {}", e);
        } else {
            println!("Offline: Cached lyrics for {}", track_id);
        }
    }
}

async fn fetch_and_store_liked_lyrics(app: &tauri::AppHandle, track: &LikedTrack) {
    let registry_path = get_registry_path(app);
    let spotify_id = if track.id.starts_with("sp-") || track.source == "spotify" {
        Some(track.id.trim_start_matches("sp-").to_string())
    } else {
        None
    };
    match crate::aggregator::lyrics::get_lyrics(
        track.title.clone(),
        track.artist.clone(),
        track.album.clone(),
        track.duration_ms,
        spotify_id,
    )
    .await
    {
        Ok(res) => {
            if let Some(text) = res.synced_lyrics.or(res.plain_lyrics) {
                update_liked_lyrics_text(&registry_path, &track.id, &text);
                // Also drop a sidecar .lrc for inspectability
                let liked_dir = get_liked_dir(app);
                let safe_id = track.id.replace(|c: char| !c.is_alphanumeric(), "_");
                let lrc_path = liked_dir.join(format!("nekobeat_liked_{}.lrc", safe_id));
                let _ = fs::write(lrc_path, &text);
            }
        }
        Err(e) => eprintln!("Offline: Lyrics backfill failed for {}: {}", track.id, e),
    }
}

async fn backfill_liked_offline_assets(app: &tauri::AppHandle, track: &LikedTrack) {
    let liked_dir = get_liked_dir(app);
    let registry_path = get_registry_path(app);
    let safe_id = track.id.replace(|c: char| !c.is_alphanumeric(), "_");
    let art_base = liked_dir.join(format!("nekobeat_liked_{}", safe_id));

    let art_ok = track
        .local_artwork_path
        .as_ref()
        .map(|p| Path::new(p).is_file())
        .unwrap_or(false);
    if !art_ok && track.artwork_url.starts_with("http") {
        if let Some(path) = download_liked_artwork(&track.artwork_url, &art_base).await {
            update_liked_artwork_path(&registry_path, &track.id, &path);
        }
    }

    let lyrics_ok = track
        .local_lyrics
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !lyrics_ok {
        fetch_and_store_liked_lyrics(app, track).await;
    }
}

// Find yt-dlp path gracefully (cross-platform)
fn get_yt_dlp_path() -> Result<PathBuf, String> {
    crate::process_util::find_ytdlp()
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
                    // Only delete later if the track is still unliked (don't wipe a re-like).
                    let retry_path = path.clone();
                    let retry_id = existing_track.id.clone();
                    let retry_registry = registry_path.clone();
                    tokio::spawn(async move {
                        for _ in 0..12 {
                            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                            // Abort if user liked this track again
                            let still_unliked = fs::read_to_string(&retry_registry)
                                .ok()
                                .and_then(|c| serde_json::from_str::<Vec<LikedTrack>>(&c).ok())
                                .map(|list| !list.iter().any(|t| t.id == retry_id))
                                .unwrap_or(true);
                            if !still_unliked {
                                println!(
                                    "Offline: Skip deleting {:?} — track {} was liked again",
                                    retry_path, retry_id
                                );
                                break;
                            }
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
        // Remove cached artwork + lyrics sidecars
        if let Some(art) = &existing_track.local_artwork_path {
            let _ = fs::remove_file(art);
        }
        let safe_id = existing_track.id.replace(|c: char| !c.is_alphanumeric(), "_");
        for ext in &["jpg", "jpeg", "png", "webp", "gif", "lrc"] {
            let p = liked_dir.join(format!("nekobeat_liked_{}.{}", safe_id, ext));
            let _ = fs::remove_file(p);
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

        // Background: art + lyrics + audio so Liked works fully offline
        tokio::spawn(async move {
            let safe_id = track.id.replace(|c: char| !c.is_alphanumeric(), "_");
            let output_base = liked_dir.join(format!("nekobeat_liked_{}", safe_id));

            // Artwork (fast, independent of audio)
            if track.artwork_url.starts_with("http") {
                if let Some(art_path) = download_liked_artwork(&track.artwork_url, &output_base).await {
                    update_liked_artwork_path(&registry_path, &track.id, &art_path);
                    let _ = app_handle.emit("liked-track-downloaded", ());
                }
            }

            // Lyrics if not already saved at like-time
            let needs_lyrics = track
                .local_lyrics
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);
            if needs_lyrics {
                fetch_and_store_liked_lyrics(&app_handle, &track).await;
                let _ = app_handle.emit("liked-track-downloaded", ());
            }
            
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

            // Helper: copy a local source file into liked_audio and register it
            let copy_into_liked = |source_file: &PathBuf| -> bool {
                if !source_file.is_file() {
                    return false;
                }
                let ext = source_file
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy();
                let ext = if ext.is_empty() {
                    "m4a".to_string()
                } else {
                    ext.to_string()
                };
                let final_path =
                    PathBuf::from(format!("{}.{}", output_base.to_string_lossy(), ext));
                match fs::copy(source_file, &final_path) {
                    Ok(_) => {
                        println!("Offline: Copied local file -> {:?}", final_path);
                        update_liked_local_path(&registry_path, &track.id, &final_path);
                        let _ = app_handle.emit("liked-track-downloaded", ());
                        true
                    }
                    Err(e) => {
                        eprintln!("Offline: Copy failed {:?}: {}", source_file, e);
                        false
                    }
                }
            };

            // Step 0 (YouTube): copy from yt_audio disk cache by video id — instant local liked file
            if track.source == "youtube" || track.id.starts_with("yt-") {
                let vid = track.id.trim_start_matches("yt-");
                if let Some(yt_cached) = find_yt_audio_cache(&app_handle, vid) {
                    println!("Offline: YouTube cache hit for liked copy {:?}", yt_cached);
                    if copy_into_liked(&yt_cached) {
                        return;
                    }
                }
            }

            // Step 1: stream_url is already a local file / file URI (copy it)
            if let Some(source_file) = local_path_from_stream_url(track.stream_url.as_deref()) {
                if copy_into_liked(&source_file) {
                    return;
                }
            }

            // Step 2: Resolve with title/artist so YouTube match isn't a random same-named song
            let resolved = crate::aggregator::resolver::resolve_url(
                &app_handle,
                &source_url,
                Some(track.title.as_str()),
                Some(track.artist.as_str()),
            )
            .await;
            
            match resolved {
                Ok(resolved_url) => {
                    if let Some(source_file) = local_path_from_stream_url(Some(&resolved_url)) {
                        if copy_into_liked(&source_file) {
                            return;
                        }
                    }
                    
                    // It's an HTTP URL — download with reqwest
                    println!("Offline: Downloading from HTTP: {}...", &resolved_url[..std::cmp::min(resolved_url.len(), 80)]);
                    let ua = if resolved_url.contains("googlevideo.com") {
                        "com.google.android.youtube/19.45.36 (Linux; U; Android 12) gzip"
                    } else {
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    };
                    let client = reqwest::Client::builder().user_agent(ua).build();

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

                                    if let Ok(mut file) = tokio::fs::File::create(&final_path).await {
                                        let mut stream = resp.bytes_stream();
                                        let mut total: u64 = 0;
                                        use futures::StreamExt;
                                        use tokio::io::AsyncWriteExt;
                                        while let Some(chunk) = stream.next().await {
                                            match chunk {
                                                Ok(bytes) => {
                                                    total += bytes.len() as u64;
                                                    if file.write_all(&bytes).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Err(e) => {
                                                    eprintln!("Offline: Stream chunk error: {}", e);
                                                    break;
                                                }
                                            }
                                        }
                                        if total > 0 {
                                            println!("Offline: Streamed {} bytes -> {:?}", total, final_path);
                                            update_liked_local_path(&registry_path, &track.id, &final_path);
                                            let _ = app_handle.emit("liked-track-downloaded", ());
                                            return;
                                        }
                                        let _ = std::fs::remove_file(&final_path);
                                    } else {
                                        eprintln!("Offline: Failed to create output file");
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
                        let mut cmd = Command::new(&ytdlp_path);
                        cmd.arg(&source_url)
                            .arg("--format")
                            .arg("bestaudio[ext=m4a]/bestaudio/best")
                            .arg("--extract-audio")
                            .arg("--output")
                            .arg(format!("{}.%(ext)s", output_base.to_string_lossy()));
                        let output = crate::process_util::run_silent_timeout(
                            cmd,
                            std::time::Duration::from_secs(180),
                        )
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

/// Public helper for Spotify hybrid HiFi cache → liked registry sync
pub fn update_local_audio_path_for_track(app: &tauri::AppHandle, track_id: &str, local_path: &Path) {
    let registry_path = get_registry_path(app);
    update_liked_local_path(&registry_path, track_id, local_path);
}

/// Copy a correctly resolved audio file into the liked_audio dir (overwrites bad YT matches).
pub fn replace_liked_audio_file(app: &tauri::AppHandle, track_id: &str, source: &Path) -> Option<PathBuf> {
    if !source.is_file() {
        return None;
    }
    let liked_dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("nekobeat_liked_audio");
    let _ = fs::create_dir_all(&liked_dir);
    let safe_id = track_id.replace(|c: char| !c.is_alphanumeric(), "_");
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .unwrap_or("m4a");
    let dest = liked_dir.join(format!("nekobeat_liked_{}.{}", safe_id, ext));
    // Remove other extensions for this id so check_liked_cache can't pick a stale wrong file
    for old_ext in &["flac", "m4a", "webm", "opus", "ogg", "mp3", "wav", "mp4"] {
        let old = liked_dir.join(format!("nekobeat_liked_{}.{}", safe_id, old_ext));
        if old != dest && old.exists() {
            let _ = fs::remove_file(&old);
        }
    }
    match fs::copy(source, &dest) {
        Ok(_) => {
            let registry_path = get_registry_path(app);
            update_liked_local_path(&registry_path, track_id, &dest);
            println!(
                "Offline: Replaced liked audio for {} -> {:?}",
                track_id, dest
            );
            Some(dest)
        }
        Err(e) => {
            eprintln!("Offline: Failed to replace liked audio: {}", e);
            None
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
            let conn = crate::library::init_db(&app).map_err(|e| e.to_string())?;
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
