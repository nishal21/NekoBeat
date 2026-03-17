use std::sync::mpsc::{channel, Sender};
use std::thread;
use tauri::{AppHandle, Emitter, State};

pub enum AudioCommand {
    Play(String),
    PlayUrl(String),
    Pause,
    Resume,
    Seek(std::time::Duration),
    SetVolume(f64),
    SetEqBand(u32, f64),
    GetPosition(Sender<std::time::Duration>),
    GetDuration(Sender<std::time::Duration>),
}

pub struct AudioState {
    pub tx: Sender<AudioCommand>,
}

pub fn init_audio_thread(app_handle: AppHandle) -> AudioState {
    let (tx, rx) = channel::<AudioCommand>();
    let tx_internal = tx.clone();

    thread::spawn(move || {
        println!("Initializing GStreamer audio engine...");
        if let Err(e) = gstreamer::init() {
            eprintln!("Failed to initialize GStreamer: {}", e);
            let _ = app_handle.emit("audio-error", format!("GStreamer init error: {}", e));
            return;
        }

        use gstreamer::prelude::*;
        let playbin = gstreamer::ElementFactory::make("playbin")
            .build()
            .expect("Failed to create playbin element");

        let equalizer = gstreamer::ElementFactory::make("equalizer-10bands")
            .build()
            .expect("Failed to create equalizer element");

        playbin.set_property("audio-filter", &equalizer);
        
        let bus = playbin.bus().expect("Failed to get bus from playbin");
        let app_handle_for_bus = app_handle.clone();

        loop {
            // Check for commands with a short timeout to keep the loop responsive
            if let Ok(cmd) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                match cmd {
                    AudioCommand::Play(path) => {
                        println!("GStreamer: Playing local file: {}", path);
                        playbin.set_state(gstreamer::State::Null).unwrap();
                        
                        // Use the url crate to correctly format the file URI (handles encoding correctly)
                        let uri = if let Ok(u) = url::Url::from_file_path(&path) {
                            u.to_string()
                        } else {
                            format!("file:///{}", path.replace('\\', "/"))
                        };
                        
                        playbin.set_property("uri", &uri);
                        playbin.set_state(gstreamer::State::Playing).unwrap();
                        let _ = app_handle.emit("audio-playing", path);
                    }
                    AudioCommand::PlayUrl(url) => {
                        println!("GStreamer: Playing URL: {}", url);
                        playbin.set_state(gstreamer::State::Null).unwrap();
                        playbin.set_property("uri", &url);
                        playbin.set_state(gstreamer::State::Playing).unwrap();
                        let _ = app_handle.emit("audio-playing", url);
                    }
                    AudioCommand::Pause => {
                        println!("GStreamer: Pausing");
                        playbin.set_state(gstreamer::State::Paused).unwrap();
                    }
                    AudioCommand::Resume => {
                        println!("GStreamer: Resuming");
                        playbin.set_state(gstreamer::State::Playing).unwrap();
                    }
                    AudioCommand::Seek(duration) => {
                        println!("GStreamer: Seeking to {:?}", duration);
                        let position = gstreamer::ClockTime::from_nseconds(duration.as_nanos() as u64);
                        // Using a safer seek flag combination
                        let flags = gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT | gstreamer::SeekFlags::ACCURATE;
                        if let Err(e) = playbin.seek_simple(flags, position) {
                            eprintln!("GStreamer Seek Error: {}", e);
                        }
                    }
                    AudioCommand::SetVolume(volume) => {
                        println!("GStreamer: Setting volume to {}", volume);
                        playbin.set_property("volume", &volume);
                    }
                    AudioCommand::SetEqBand(band, gain) => {
                        // GStreamer equalizer-10bands has 10 bands (0-9) and typically a range of -24.0 to +12.0
                        if band >= 10 {
                            eprintln!("GStreamer: Invalid EQ band index: {}", band);
                        } else {
                            let clamped_gain = gain.clamp(-24.0, 12.0);
                            if clamped_gain != gain {
                                println!("GStreamer: Gain {}dB out of range for band {}, clamping to {}dB", gain, band, clamped_gain);
                            }
                            println!("GStreamer: Setting EQ band {} to {}dB", band, clamped_gain);
                            let prop_name = format!("band{}", band);
                            equalizer.set_property(&prop_name, &clamped_gain);
                        }
                    }
                    AudioCommand::GetPosition(reply_tx) => {
                        let mut pos_out = std::time::Duration::from_secs(0);
                        if let Some(pos) = playbin.query_position::<gstreamer::ClockTime>() {
                            pos_out = std::time::Duration::from_nanos(pos.nseconds());
                        }
                        let _ = reply_tx.send(pos_out);
                    }
                    AudioCommand::GetDuration(reply_tx) => {
                        let mut dur_out = std::time::Duration::from_secs(0);
                        if let Some(dur) = playbin.query_duration::<gstreamer::ClockTime>() {
                            dur_out = std::time::Duration::from_nanos(dur.nseconds());
                        }
                        let _ = reply_tx.send(dur_out);
                    }
                }
            }

            // Continuous non-blocking bus check for events (EOS, Errors)
            while let Some(msg) = bus.pop() {
                use gstreamer::MessageView;
                match msg.view() {
                    MessageView::Eos(..) => {
                        println!("GStreamer: End of stream");
                        let _ = app_handle_for_bus.emit("audio-ended", true);
                    }
                    MessageView::Error(err) => {
                        eprintln!("GStreamer error: {}", err.error());
                        let _ = app_handle_for_bus.emit("audio-error", format!("GStreamer error: {}", err.error()));
                    }
                    MessageView::StateChanged(state) => {
                        // Optional: listen for state changes to stay in sync
                        if state.src().map(|s| s == playbin.upcast_ref::<gstreamer::Object>()).unwrap_or(false) {
                            // println!("GStreamer State Change: {:?} -> {:?}", state.old_state(), state.current_state());
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    AudioState { tx: tx_internal }
}

#[tauri::command]
pub async fn stream_external_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>, 
    url: String, 
    source: String
) -> Result<String, String> {
    println!("Streaming external audio from {}: {}", source, url);
    match crate::aggregator::resolver::resolve_url(&app, &url).await {
        Ok(resolved_url) => {
            println!("Successfully resolved stream URL: {}", &resolved_url[..std::cmp::min(resolved_url.len(), 100)]);
            // If the resolved URL is a local temp file (from HLS assembly), play it directly
            if resolved_url.starts_with("file://") {
                let file_path = resolved_url.trim_start_matches("file://").to_string();
                println!("Playing assembled HLS file: {}", file_path);
                state.tx.send(AudioCommand::Play(file_path)).map_err(|e| e.to_string())?;
            } else {
                state.tx.send(AudioCommand::PlayUrl(resolved_url.clone())).map_err(|e| e.to_string())?;
            }
            Ok(resolved_url)
        }
        Err(e) => {
            eprintln!("Failed to resolve stream URL: {}", e);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn play_audio(state: State<'_, AudioState>, path: String) -> Result<(), String> {
    state.tx.send(AudioCommand::Play(path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pause_audio(state: State<'_, AudioState>) -> Result<(), String> {
    state.tx.send(AudioCommand::Pause).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resume_audio(state: State<'_, AudioState>) -> Result<(), String> {
    state.tx.send(AudioCommand::Resume).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn seek_audio(state: State<'_, AudioState>, position_ms: u64) -> Result<(), String> {
    let duration = std::time::Duration::from_millis(position_ms);
    state.tx.send(AudioCommand::Seek(duration)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_audio_position(state: State<'_, AudioState>) -> Result<u64, String> {
    let (reply_tx, reply_rx) = channel();
    state.tx.send(AudioCommand::GetPosition(reply_tx)).map_err(|e| e.to_string())?;
    
    match reply_rx.recv_timeout(std::time::Duration::from_millis(50)) {
        Ok(duration) => Ok(duration.as_millis() as u64),
        Err(_) => Ok(0),
    }
}

#[tauri::command]
pub fn get_audio_duration(state: State<'_, AudioState>) -> Result<u64, String> {
    let (reply_tx, reply_rx) = channel();
    state.tx.send(AudioCommand::GetDuration(reply_tx)).map_err(|e| e.to_string())?;
    
    match reply_rx.recv_timeout(std::time::Duration::from_millis(50)) {
        Ok(duration) => Ok(duration.as_millis() as u64),
        Err(_) => Ok(0),
    }
}
#[tauri::command]
pub fn set_volume(state: State<'_, AudioState>, volume: f64) -> Result<(), String> {
    state.tx.send(AudioCommand::SetVolume(volume)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_eq_band(state: State<'_, AudioState>, band: u32, gain: f64) -> Result<(), String> {
    state.tx.send(AudioCommand::SetEqBand(band, gain)).map_err(|e| e.to_string())
}
