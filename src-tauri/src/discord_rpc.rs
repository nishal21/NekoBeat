use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DISCORD_APP_ID: &str = "1481006235192131744";

pub struct DiscordState {
    pub client: Arc<Mutex<Option<DiscordIpcClient>>>,
}

#[tauri::command]
pub fn set_discord_activity(
    state: tauri::State<'_, DiscordState>,
    title: String,
    artist: String,
    duration_ms: u64,
    artwork_url: Option<String>,
) -> Result<(), String> {
    let mut client_guard = state.client.lock().unwrap();

    // Re-initialize if dropped or not connected
    if client_guard.is_none() {
        let mut new_client = DiscordIpcClient::new(DISCORD_APP_ID);
        if new_client.connect().is_ok() {
            *client_guard = Some(new_client);
        }
    }

    if let Some(client) = client_guard.as_mut() {
        let details = format!("Listening to {}", title);
        let state_str = format!("by {}", artist);

        let mut assets = activity::Assets::new().large_text(&title);
        
        // Use external artwork URL if provided, fallback to the generic asset name
        if let Some(url) = artwork_url.as_deref().filter(|s| !s.is_empty()) {
            assets = assets.large_image(url);
        } else {
            assets = assets.large_image("nekobeat_logo");
        }

        let mut payload = activity::Activity::new()
            .details(&details)
            .state(&state_str)
            .assets(assets);

        if duration_ms > 0 {
            // Calculate end timestamp
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            let end_timestamp = now + (duration_ms / 1000);
            payload = payload.timestamps(activity::Timestamps::new().end(end_timestamp as i64));
        }

        if let Err(e) = client.set_activity(payload) {
            eprintln!("Failed to set Discord activity: {}", e);
            // Drop client on error so we can attempt to reconnect later
            *client_guard = None;
            return Err(e.to_string());
        }
    } else {
        return Err("Discord RPC client not connected".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn clear_discord_activity(state: tauri::State<'_, DiscordState>) -> Result<(), String> {
    let mut client_guard = state.client.lock().unwrap();
    if let Some(client) = client_guard.as_mut() {
        let _ = client.clear_activity();
    }
    Ok(())
}
