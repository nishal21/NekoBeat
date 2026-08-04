//! Discord Rich Presence with rich media (Harmonoid-style).
use crate::playback::TrackMeta;
use crate::settings::AppSettings;
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const DISCORD_APP_ID: &str = "1481006235192131744";

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
}

impl Default for DiscordState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn discord_update(
    discord: tauri::State<'_, Arc<DiscordState>>,
    settings: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    track: Option<TrackMeta>,
    playing: bool,
    position_ms: u64,
) -> Result<(), String> {
    if !settings.lock().discord_rich_presence {
        return discord_clear(discord);
    }
    let Some(track) = track else {
        return discord_clear(discord);
    };

    let mut guard = discord.client.lock();
    if guard.is_none() {
        let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
        if client.connect().is_ok() {
            *guard = Some(client);
        }
    }
    let Some(client) = guard.as_mut() else {
        return Ok(());
    };

    let details = track.title.chars().take(128).collect::<String>();
    let state = track.artist.chars().take(128).collect::<String>();
    let large_text = track
        .album
        .clone()
        .unwrap_or_else(|| details.clone());

    let mut assets = activity::Assets::new()
        .large_text(&large_text)
        .small_text(if playing { "Playing" } else { "Paused" })
        .small_image(if playing { "play" } else { "pause" });

    if let Some(url) = track
        .cover_url
        .as_deref()
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
    {
        assets = assets.large_image(url);
    } else {
        assets = assets.large_image("nekobeat_logo");
    }

    let find_url = format!(
        "https://www.google.com/search?q={}",
        urlencoding::encode(&format!("{} {}", track.title, track.artist))
    );

    let act = activity::Activity::new()
        .details(&details)
        .state(&state)
        .assets(assets);

    // Button label+url must outlive set_activity call
    let mut act = act.buttons(vec![activity::Button::new("Find", find_url.as_str())]);

    if playing {
        let start = now_secs() - (position_ms as i64 / 1000);
        let end = start + (track.duration_ms.unwrap_or(position_ms) as i64 / 1000).max(1);
        act = act.timestamps(activity::Timestamps::new().start(start).end(end));
    }

    client
        .set_activity(act)
        .map_err(|e| format!("discord set_activity: {e:?}"))?;
    Ok(())
}

#[tauri::command]
pub fn discord_clear(discord: tauri::State<'_, Arc<DiscordState>>) -> Result<(), String> {
    let mut guard = discord.client.lock();
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
    Ok(())
}
