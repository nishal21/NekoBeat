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
        let exe_path = std::env::current_exe().unwrap_or_default();
        let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let log_path = exe_dir.join("nekobeat_startup.log");

        let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "GStreamer audio thread initialized.")
        });

        use gstreamer::prelude::*;
        let playbin = gstreamer::ElementFactory::make("playbin")
            .build()
            .expect("Failed to create playbin element");

        // Disable video rendering — we only need audio
        let fakesink = gstreamer::ElementFactory::make("fakesink").build().ok();
        if let Some(ref sink) = fakesink {
            playbin.set_property("video-sink", sink);
        }

        // Increase connection speed hint for better format selection
        playbin.set_property("connection-speed", &(10000u64));

        // Set User-Agent and correct Referer/Origin for all network requests
        playbin.connect("source-setup", false, move |args| {
            let source = args[1].get::<gstreamer::Element>().unwrap();
            let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
            
            if source.has_property("user-agent", None) {
                source.set_property("user-agent", &ua);
            }
            
            // Set Referer and Origin via extra-headers (souphttpsrc)
            if source.has_property("extra-headers", None) {
                let mut structure = gstreamer::Structure::new_empty("headers");
                
                // Detect source by inspecting the URI property
                let uri: String = if source.has_property("location", None) {
                    source.property::<String>("location")
                } else {
                    String::new()
                };

                if uri.contains("googlevideo.com") || uri.contains("youtube.com") {
                    structure.set("Referer", &"https://www.youtube.com/");
                    structure.set("Origin", &"https://www.youtube.com");
                } else if uri.contains("soundcloud") || uri.contains("sndcdn.com") {
                    structure.set("Referer", &"https://soundcloud.com/");
                    structure.set("Origin", &"https://soundcloud.com");
                }

                source.set_property("extra-headers", &structure);
                println!("GStreamer: Headers configured for source (uri contains: {}...)", &uri[..std::cmp::min(uri.len(), 60)]);
            }
            None
        });

        let equalizer = gstreamer::ElementFactory::make("equalizer-10bands")
            .build()
            .expect("Failed to create equalizer element");

        playbin.set_property("audio-filter", &equalizer);

        // Configure buffering for network streams
        // buffer-size: 2MB buffer for smoother network playback
        playbin.set_property("buffer-size", &(2 * 1024 * 1024i32));
        // buffer-duration: 5 seconds of audio buffered ahead
        playbin.set_property("buffer-duration", &(5_000_000_000i64));
        
        // Track current volume and EQ so we can re-apply after pipeline resets
        let mut current_volume: f64 = 1.0;
        let mut current_eq: [f64; 10] = [0.0; 10];

        let bus = playbin.bus().expect("Failed to get bus from playbin");
        let app_handle_for_bus = app_handle.clone();

        // Helper to handle state change errors without panicking
        let set_state_safe = |element: &gstreamer::Element, state: gstreamer::State, app: &AppHandle| {
            if let Err(err) = element.set_state(state) {
                let err_msg = format!("GStreamer State Change Error ({:?}): {}", state, err);
                eprintln!("{}", err_msg);
                
                // Also log to file for release debugging
                let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                    use std::io::Write;
                    writeln!(f, "{}", err_msg)
                });
                
                let _ = app.emit("audio-error", err_msg);
                return false;
            }
            true
        };

        loop {
            // Check for commands with a short timeout to keep the loop responsive
            if let Ok(cmd) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                match cmd {
                    AudioCommand::Play(path) => {
                        println!("GStreamer: Playing local file: {}", path);
                        set_state_safe(&playbin, gstreamer::State::Null, &app_handle);
                        
                        let uri = if let Ok(u) = url::Url::from_file_path(&path) {
                            u.to_string()
                        } else {
                            format!("file:///{}", path.replace('\\', "/"))
                        };
                        
                        playbin.set_property("uri", &uri);
                        // Re-apply volume and EQ after pipeline reset
                        playbin.set_property("volume", &current_volume);
                        for (i, &g) in current_eq.iter().enumerate() {
                            if g != 0.0 {
                                equalizer.set_property(&format!("band{}", i), &g);
                            }
                        }
                        if set_state_safe(&playbin, gstreamer::State::Playing, &app_handle) {
                            let _ = app_handle.emit("audio-playing", path);
                        }
                    }
                    AudioCommand::PlayUrl(url) => {
                        println!("GStreamer: Playing URL: {}", url);
                        
                        // Log URI to startup log for debugging
                        let _ = std::fs::OpenOptions::new().append(true).open(&log_path).and_then(|mut f| {
                            use std::io::Write;
                            writeln!(f, "GStreamer: Attempting to play URL: {}", url)
                        });

                        let _ = app_handle.emit("audio-buffering", true);
                        set_state_safe(&playbin, gstreamer::State::Null, &app_handle);
                        playbin.set_property("uri", &url);
                        // Re-apply volume and EQ after pipeline reset
                        playbin.set_property("volume", &current_volume);
                        for (i, &g) in current_eq.iter().enumerate() {
                            if g != 0.0 {
                                equalizer.set_property(&format!("band{}", i), &g);
                            }
                        }
                        if set_state_safe(&playbin, gstreamer::State::Playing, &app_handle) {
                            let _ = app_handle.emit("audio-playing", url);
                            let _ = app_handle.emit("audio-buffering", false);
                        } else {
                            let _ = app_handle.emit("audio-buffering", false);
                        }
                    }
                    AudioCommand::Pause => {
                        println!("GStreamer: Pausing");
                        set_state_safe(&playbin, gstreamer::State::Paused, &app_handle);
                    }
                    AudioCommand::Resume => {
                        println!("GStreamer: Resuming");
                        set_state_safe(&playbin, gstreamer::State::Playing, &app_handle);
                    }
                    AudioCommand::Seek(duration) => {
                        println!("GStreamer: Seeking to {:?}", duration);
                        let position = gstreamer::ClockTime::from_nseconds(duration.as_nanos() as u64);
                        let flags = gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT | gstreamer::SeekFlags::ACCURATE;
                        if let Err(e) = playbin.seek_simple(flags, position) {
                            eprintln!("GStreamer Seek Error: {}", e);
                        }
                    }
                    AudioCommand::SetVolume(volume) => {
                        println!("GStreamer: Setting volume to {}", volume);
                        current_volume = volume;
                        playbin.set_property("volume", &volume);
                    }
                    AudioCommand::SetEqBand(band, gain) => {
                        if band >= 10 {
                            eprintln!("GStreamer: Invalid EQ band index: {}", band);
                        } else {
                            let clamped_gain = gain.clamp(-24.0, 12.0);
                            current_eq[band as usize] = clamped_gain;
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
                        let err_msg = format!("GStreamer error: {}", err.error());
                        if let Some(debug) = err.debug() {
                            eprintln!("{} (debug: {})", err_msg, debug);
                        } else {
                            eprintln!("{}", err_msg);
                        }
                        // Reset pipeline to prevent stuck state
                        let _ = playbin.set_state(gstreamer::State::Null);
                        let _ = app_handle_for_bus.emit("audio-error", err_msg);
                    }
                    MessageView::Buffering(buffering) => {
                        let percent = buffering.percent();
                        if percent < 100 {
                            let _ = app_handle_for_bus.emit("audio-buffering", true);
                        } else {
                            let _ = app_handle_for_bus.emit("audio-buffering", false);
                        }
                    }
                    MessageView::StateChanged(state) => {
                        if state.src().map(|s| s == playbin.upcast_ref::<gstreamer::Object>()).unwrap_or(false) {
                            // Optional: status tracking
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
    let _ = app.emit("audio-buffering", true);
    match crate::aggregator::resolver::resolve_url(&app, &url).await {
        Ok(resolved_url) => {
            let _ = app.emit("audio-buffering", false);
            
            // Check if this is a preview URL (SoundCloud restricted tracks)
            let (actual_url, is_preview) = if let Some(preview_url) = resolved_url.strip_prefix("PREVIEW:") {
                println!("Audio: Playing preview (30s) for restricted track");
                let _ = app.emit("audio-preview", "This track is restricted by the distributor. Playing 30-second preview.");
                (preview_url.to_string(), true)
            } else {
                (resolved_url.clone(), false)
            };
            
            if let Some(path) = actual_url.strip_prefix("file:///") {
                state.tx.send(AudioCommand::Play(path.to_string())).map_err(|e| e.to_string())?;
            } else if let Some(path) = actual_url.strip_prefix("file://") {
                state.tx.send(AudioCommand::Play(path.to_string())).map_err(|e| e.to_string())?;
            } else {
                state.tx.send(AudioCommand::PlayUrl(actual_url.clone())).map_err(|e| e.to_string())?;
            }
            // Return PREVIEW: prefix so frontend knows
            if is_preview {
                Ok(format!("PREVIEW:{}", actual_url))
            } else {
                Ok(resolved_url)
            }
        }
        Err(e) => {
            let _ = app.emit("audio-buffering", false);
            let _ = app.emit("audio-error", format!("Stream resolution failed: {}", e));
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
