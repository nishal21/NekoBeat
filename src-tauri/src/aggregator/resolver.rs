pub async fn resolve_url(app: &tauri::AppHandle, url: &str) -> Result<String, String> {
    println!("Resolver: Resolving URL: {}", url);
    let result = if url.contains("youtube.com") || url.contains("youtu.be") {
        resolve_youtube(url).await
    } else if url.contains("soundcloud.com") || url.contains("api-v2.soundcloud.com") {
        resolve_soundcloud(url).await
    } else if url.contains("spotify.com") {
        crate::aggregator::spotify::resolve_spotify_url(app, url).await
    } else {
        Err(format!("Unsupported external source URL: {}", url))
    };
    match &result {
        Ok(resolved) => println!("Resolver: Successfully resolved to: {}...", &resolved[..std::cmp::min(resolved.len(), 120)]),
        Err(e) => eprintln!("Resolver: Failed: {}", e),
    }
    result
}

fn find_ytdlp() -> Result<std::path::PathBuf, String> {
    // Look for yt-dlp.exe next to the current executable (src-tauri/bin/)
    if let Ok(exe_path) = std::env::current_exe() {
        let exe_dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
        // In dev mode, binary is in target/debug/, yt-dlp is in src-tauri/bin/
        // Try multiple locations
        let candidates = [
            exe_dir.join("yt-dlp.exe"),
            exe_dir.join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("..").join("bin").join("yt-dlp.exe"),
            exe_dir.join("..").join("..").join("..").join("bin").join("yt-dlp.exe"),
        ];
        for candidate in &candidates {
            if candidate.exists() {
                println!("yt-dlp found at: {}", candidate.display());
                return Ok(candidate.clone());
            }
        }
        // Also try the src-tauri/bin path directly in dev
        let src_tauri_bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("yt-dlp.exe");
        if src_tauri_bin.exists() {
            println!("yt-dlp found at: {}", src_tauri_bin.display());
            return Ok(src_tauri_bin);
        }
    }
    // Fallback: check PATH  
    Err("yt-dlp.exe not found. Place it in src-tauri/bin/".to_string())
}

async fn resolve_youtube(url: &str) -> Result<String, String> {
    // Extract video ID from URL
    let video_id = extract_youtube_id(url)
        .ok_or_else(|| format!("Could not extract YouTube video ID from: {}", url))?;

    let temp_dir = std::env::temp_dir();
    let ytdlp_path = find_ytdlp()?;
    let output_template = temp_dir.join(format!("nekobeat_yt_{}", video_id));

    // Prioritize .m4a cache lookup
    let m4a_path = temp_dir.join(format!("nekobeat_yt_{}.m4a", video_id));
    if m4a_path.exists() && std::fs::metadata(&m4a_path).map(|m| m.len() > 0).unwrap_or(false) {
        let file_url = format!("file://{}", m4a_path.to_string_lossy().replace('\\', "/"));
        println!("YouTube: Using cached M4A file: {}", file_url);
        return Ok(file_url);
    }

    println!("YouTube: Downloading audio via yt-dlp for {}...", video_id);

    // Download native best audio format (m4a) without ffmpeg post-processing
    let output = tokio::process::Command::new(&ytdlp_path)
        .arg(url)
        .arg("--format")
        .arg("bestaudio[ext=m4a]/bestaudio/best") // Prefer m4a, fallback to best audio, then best generic format
        .arg("--no-playlist")
        .arg("--no-part")
        .arg("--concurrent-fragments")
        .arg("5")
        .arg("--output")
        .arg(format!("{}.%(ext)s", output_template.to_string_lossy()))
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    let _stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    
    if !output.status.success() {
        return Err(format!("yt-dlp failed (exit {}): {}", output.status, stderr));
    }

    // Search for the downloaded file, prioritizing .m4a
    let extensions = ["m4a", "mp3", "webm", "opus"];
    for ext in extensions {
        let path = temp_dir.join(format!("nekobeat_yt_{}.{}", video_id, ext));
        if path.exists() && std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false) {
            let file_url = format!("file://{}", path.to_string_lossy().replace('\\', "/"));
            println!("YouTube: Success! Found downloaded file: {}", file_url);
            return Ok(file_url);
        }
    }

    Err(format!("Could not find downloaded file. Output log: {}", stderr))
}

pub async fn resolve_youtube_search(query: &str) -> Result<String, String> {
    let search_term = format!("ytsearch1:{}", query);
    // Sanitize query for filename
    let safe_query: String = query.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
    let safe_query = if safe_query.len() > 30 { safe_query[..30].to_string() } else { safe_query };
    
    let temp_dir = std::env::temp_dir();
    let ytdlp_path = find_ytdlp()?;
    let output_template = temp_dir.join(format!("nekobeat_yt_search_{}", safe_query));

    let m4a_path = temp_dir.join(format!("nekobeat_yt_search_{}.m4a", safe_query));
    if m4a_path.exists() && std::fs::metadata(&m4a_path).map(|m| m.len() > 0).unwrap_or(false) {
        let file_url = format!("file://{}", m4a_path.to_string_lossy().replace('\\', "/"));
        println!("YouTube: Using cached search file: {}", file_url);
        return Ok(file_url);
    }

    println!("YouTube: Downloading audio via yt-dlp for search '{}'...", query);

    let output = tokio::process::Command::new(&ytdlp_path)
        .arg(&search_term)
        .arg("--format")
        .arg("bestaudio[ext=m4a]/bestaudio/best")
        .arg("--no-playlist")
        .arg("--no-part")
        .arg("--concurrent-fragments")
        .arg("5")
        .arg("--output")
        .arg(format!("{}.%(ext)s", output_template.to_string_lossy()))
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("yt-dlp failed (exit {}): {}", output.status, stderr));
    }

    let extensions = ["m4a", "mp3", "webm", "opus"];
    for ext in extensions {
        let path = temp_dir.join(format!("nekobeat_yt_search_{}.{}", safe_query, ext));
        if path.exists() && std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false) {
            let file_url = format!("file://{}", path.to_string_lossy().replace('\\', "/"));
            println!("YouTube: Success! Found search downloaded file: {}", file_url);
            return Ok(file_url);
        }
    }

    Err(format!("Could not find downloaded file. Output log: {}", stderr))
}

fn extract_youtube_id(url: &str) -> Option<&str> {
    // Handle youtube.com/watch?v=ID
    if let Some(pos) = url.find("v=") {
        let id_start = pos + 2;
        let id = &url[id_start..];
        let id = id.split('&').next().unwrap_or(id);
        if !id.is_empty() {
            return Some(id);
        }
    }
    // Handle youtu.be/ID
    if url.contains("youtu.be/") {
        if let Some(pos) = url.find("youtu.be/") {
            let id_start = pos + 9;
            let id = &url[id_start..];
            let id = id.split('?').next().unwrap_or(id);
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

async fn resolve_soundcloud(url: &str) -> Result<String, String> {
    // Direct API for maximum speed, relying on audio.rs header fixes
    crate::aggregator::soundcloud::resolve(url).await
}
