//! Cover resolve — cache remote / data URL for WebView; file for MediaSession.
use crate::playback::TrackMeta;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;

#[tauri::command]
pub fn cover_resolve(
    app: tauri::AppHandle,
    track: TrackMeta,
) -> Result<String, String> {
    if let Some(url) = &track.cover_url {
        if url.starts_with("data:") || url.starts_with("http://") || url.starts_with("https://") {
            return Ok(url.clone());
        }
        if Path::new(url).exists() {
            return file_as_data_url(url);
        }
    }
    if let Some(path) = &track.path {
        // folder cover cascade
        if let Some(parent) = Path::new(path).parent() {
            for name in ["cover.jpg", "Cover.jpg", "folder.jpg", "Folder.jpg"] {
                let c = parent.join(name);
                if c.exists() {
                    return file_as_data_url(&c.to_string_lossy());
                }
            }
        }
    }
    // placeholder brand-tinted SVG
    let svg = format!(
        r#"<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#2dd4bf'/><stop offset='1' stop-color='#0f766e'/></linearGradient></defs><rect width='320' height='320' fill='url(#g)'/><text x='50%' y='54%' text-anchor='middle' fill='#042f2e' font-size='72' font-family='sans-serif'>N</text></svg>"#
    );
    let _ = app;
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg.as_bytes())
    ))
}

fn file_as_data_url(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mime = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Ok(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    ))
}
