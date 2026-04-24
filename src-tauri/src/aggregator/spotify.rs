use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use serde_json::Value;

pub async fn resolve_spotify_url(app: &AppHandle, url: &str) -> Result<String, String> {
    println!("Spotify: Spawning spotiflac-cli for URL: {}", url);

    // Create a temporary directory for the download
    let temp_dir = std::env::temp_dir().join("nekobeat_spotify");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let sidecar_command = app.shell().sidecar("spotiflac-cli")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .arg(url)
        .arg(temp_dir.to_string_lossy().to_string());

    let output = sidecar_command.output().await
        .map_err(|e| format!("Failed to execute sidecar: {}", e))?;

    if !output.status.success() {
        let err_str = String::from_utf8_lossy(&output.stderr);
        let out_str = String::from_utf8_lossy(&output.stdout);
        println!("Spotify CLI Error stdout: {}", out_str);
        println!("Spotify CLI Error stderr: {}", err_str);
        return Err(format!("Spotify Downloader failed with status: {:?}. Error: {}", output.status, err_str));
    }

    let output_str = String::from_utf8_lossy(&output.stdout);
    
    // The CLI wrapper outputs progress text before the final JSON. 
    // Find the last line that starts with `{`.
    let json_line = output_str.lines().filter(|l| l.trim().starts_with('{')).last().unwrap_or(&output_str);

    if let Ok(parsed) = serde_json::from_str::<Value>(json_line) {
        if let Some(true) = parsed["success"].as_bool() {
            if let Some(file_path) = parsed["file"].as_str() {
                // Ensure it's treated as a local file scheme
                return Ok(format!("file:///{}", file_path.replace("\\", "/")));
            }
        } else if let Some(true) = parsed["fallback"].as_bool() {
            if let Some(query) = parsed["fallback_query"].as_str() {
                println!("Spotify: Lossless download failed. Falling back to YouTube search for: {}", query);
                return crate::aggregator::resolver::resolve_youtube_search(query).await;
            }
        }
    }
    
    Err(format!("Could not parse successful output from Spotify downloader: {}", output_str))
}
