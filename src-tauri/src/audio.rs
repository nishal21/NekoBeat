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
    GetClock(Sender<(std::time::Duration, std::time::Duration)>),
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

        // Match CDN client in the signed URL — wrong UA => souphttpsrc -5 / 403.
        // Check ANDROID_VR before ANDROID (substring trap: ANDROID_VR contains ANDROID).
        const YT_ANDROID_UA: &str =
            "com.google.android.youtube/19.45.36 (Linux; U; Android 12) gzip";
        const YT_ANDROID_VR_UA: &str =
            "com.google.android.apps.youtube.vr.oculus/1.60.27 (Linux; U; Android 12; xx_XX; Quest 3; Build/SQ3A.220605.009.A1; Cronet/131.0.6778.135)";
        const YT_TV_UA: &str =
            "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";
        const DESKTOP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

        playbin.connect("source-setup", false, move |args| {
            let source = args[1].get::<gstreamer::Element>().unwrap();

            let uri: String = if source.has_property("location", None) {
                source.property::<String>("location")
            } else {
                String::new()
            };

            let is_youtube_cdn = uri.contains("googlevideo.com") || uri.contains("youtube.com");
            let ua = if !is_youtube_cdn {
                DESKTOP_UA
            } else if uri.contains("c=ANDROID_VR") {
                YT_ANDROID_VR_UA
            } else if uri.contains("c=ANDROID") {
                YT_ANDROID_UA
            } else if uri.contains("c=TVHTML5") || uri.contains("c=TV") {
                YT_TV_UA
            } else {
                DESKTOP_UA
            };

            if source.has_property("user-agent", None) {
                source.set_property("user-agent", &ua);
            }

            if source.has_property("keep-alive", None) {
                source.set_property("keep-alive", &true);
            }
            if source.has_property("timeout", None) {
                source.set_property("timeout", &30u32);
            }

            if source.has_property("extra-headers", None)
                && (uri.contains("soundcloud") || uri.contains("sndcdn.com"))
            {
                let mut structure = gstreamer::Structure::new_empty("headers");
                structure.set("Referer", &"https://soundcloud.com/");
                structure.set("Origin", &"https://soundcloud.com");
                source.set_property("extra-headers", &structure);
            }
            println!(
                "GStreamer: source-setup (yt_cdn={}, uri={}...)",
                is_youtube_cdn,
                &uri[..std::cmp::min(uri.len(), 60)]
            );
            None
        });

        let equalizer = gstreamer::ElementFactory::make("equalizer-10bands")
            .build()
            .expect("Failed to create equalizer element");

        playbin.set_property("audio-filter", &equalizer);

        // Android: prefer OpenSLES output (GStreamer Android SDK default audio path)
        #[cfg(target_os = "android")]
        if let Ok(opensles) = gstreamer::ElementFactory::make("opensles").build() {
            playbin.set_property("audio-sink", &opensles);
        }

        // Low preroll — start audible ASAP; soup will keep filling behind
        playbin.set_property("buffer-size", &(256 * 1024i32));
        playbin.set_property("buffer-duration", &(800_000_000i64));
        
        // Track current volume and EQ so we can re-apply after pipeline resets
        let mut current_volume: f64 = 1.0;
        let mut current_eq: [f64; 10] = [0.0; 10];
        let mut current_uri = String::new();
        // Cached clock — refreshed every loop so UI never depends on a raced IPC query
        let mut cached_pos = std::time::Duration::ZERO;
        let mut cached_dur = std::time::Duration::ZERO;
        // Ignore Pause commands briefly after Resume (SMTC/shortcut double-fire)
        let mut resume_guard_until = std::time::Instant::now();
        // Ignore Seek briefly after Play — stale UI seeks were jumping new tracks to ~EOF
        let mut play_guard_until = std::time::Instant::now();

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
            // Keep a fresh clock sample even when no UI poll is waiting
            if let Some(pos) = playbin.query_position::<gstreamer::ClockTime>() {
                cached_pos = std::time::Duration::from_nanos(pos.nseconds());
            }
            if let Some(dur) = playbin.query_duration::<gstreamer::ClockTime>() {
                if dur.nseconds() > 0 {
                    cached_dur = std::time::Duration::from_nanos(dur.nseconds());
                }
            }

            // Check for commands with a short timeout to keep the loop responsive
            if let Ok(cmd) = rx.recv_timeout(std::time::Duration::from_millis(50)) {
                match cmd {
                    AudioCommand::Play(path) => {
                        let resolved = match crate::path_util::resolve_playable_local_path(&path) {
                            Ok(p) => p,
                            Err(e) => {
                                eprintln!("GStreamer: {}", e);
                                let _ = app_handle.emit("audio-error", e);
                                continue;
                            }
                        };
                        println!("GStreamer: Playing local file: {}", resolved.display());
                        cached_pos = std::time::Duration::ZERO;
                        cached_dur = std::time::Duration::ZERO;
                        play_guard_until =
                            std::time::Instant::now() + std::time::Duration::from_millis(500);
                        set_state_safe(&playbin, gstreamer::State::Null, &app_handle);

                        let uri = crate::path_util::path_to_file_uri(&resolved);
                        current_uri = uri.clone();
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
                            let _ = app_handle.emit("audio-buffering", false);
                            let _ = app_handle.emit("audio-ready", true);
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
                        cached_pos = std::time::Duration::ZERO;
                        cached_dur = std::time::Duration::ZERO;
                        play_guard_until =
                            std::time::Instant::now() + std::time::Duration::from_millis(500);
                        set_state_safe(&playbin, gstreamer::State::Null, &app_handle);
                        current_uri = url.clone();
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
                            // Keep buffering true until bus Buffering reports usable percent
                        } else {
                            let _ = app_handle.emit("audio-buffering", false);
                        }
                    }
                    AudioCommand::Pause => {
                        if std::time::Instant::now() < resume_guard_until {
                            println!("GStreamer: Ignoring Pause (resume guard)");
                            continue;
                        }
                        println!("GStreamer: Pausing");
                        set_state_safe(&playbin, gstreamer::State::Paused, &app_handle);
                    }
                    AudioCommand::Resume => {
                        println!("GStreamer: Resuming at {:?}", cached_pos);
                        resume_guard_until =
                            std::time::Instant::now() + std::time::Duration::from_millis(1500);
                        playbin.set_property("volume", &current_volume);
                        // Force pipeline back to Playing; on Windows pause→play can go silent
                        // without a flush seek to the current position.
                        let _ = playbin.set_state(gstreamer::State::Playing);
                        if cached_pos.as_millis() > 0 {
                            let position = gstreamer::ClockTime::from_nseconds(
                                cached_pos.as_nanos() as u64,
                            );
                            if let Err(e) = playbin.seek_simple(
                                gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT,
                                position,
                            ) {
                                eprintln!("GStreamer: Resume seek failed: {}", e);
                            }
                        }
                        playbin.set_property("volume", &current_volume);
                        let (_ret, state, _pending) =
                            playbin.state(gstreamer::ClockTime::from_seconds(1));
                        println!("GStreamer: State after resume: {:?}", state);
                        if state != gstreamer::State::Playing {
                            eprintln!("GStreamer: Not Playing after resume — forcing Playing");
                            let _ = set_state_safe(&playbin, gstreamer::State::Playing, &app_handle);
                            playbin.set_property("volume", &current_volume);
                        }
                    }
                    AudioCommand::Seek(duration) => {
                        if std::time::Instant::now() < play_guard_until {
                            println!("GStreamer: Ignoring stale Seek {:?} (play guard)", duration);
                            continue;
                        }
                        println!("GStreamer: Seeking to {:?}", duration);
                        cached_pos = duration;
                        let _ = playbin.seek_simple(
                            gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::KEY_UNIT,
                            gstreamer::ClockTime::from_nseconds(duration.as_nanos() as u64),
                        );
                    }
                    AudioCommand::SetVolume(volume) => {
                        println!("GStreamer: Setting volume to {}", volume);
                        current_volume = volume;
                        playbin.set_property("volume", &volume);
                    }
                    AudioCommand::SetEqBand(band, gain) => {
                        if (band as usize) < current_eq.len() {
                            let clamped_gain = gain.clamp(-24.0, 12.0);
                            current_eq[band as usize] = clamped_gain;
                            let prop_name = format!("band{}", band);
                            equalizer.set_property(&prop_name, &clamped_gain);
                        }
                    }
                    AudioCommand::GetPosition(reply_tx) => {
                        let _ = reply_tx.send(cached_pos);
                    }
                    AudioCommand::GetDuration(reply_tx) => {
                        let _ = reply_tx.send(cached_dur);
                    }
                    AudioCommand::GetClock(reply_tx) => {
                        // One fresh query then return cache (never block the UI on a cold pipeline)
                        if let Some(pos) = playbin.query_position::<gstreamer::ClockTime>() {
                            cached_pos = std::time::Duration::from_nanos(pos.nseconds());
                        }
                        if let Some(dur) = playbin.query_duration::<gstreamer::ClockTime>() {
                            if dur.nseconds() > 0 {
                                cached_dur = std::time::Duration::from_nanos(dur.nseconds());
                            }
                        }
                        let _ = reply_tx.send((cached_pos, cached_dur));
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
                        let gst_err = err.error().to_string();
                        let debug = err.debug().unwrap_or_default();
                        let err_msg = format!("GStreamer error: {}", gst_err);
                        eprintln!("{} (debug: {})", err_msg, debug);
                        let _ = playbin.set_state(gstreamer::State::Null);
                        let _ = app_handle_for_bus.emit("audio-buffering", false);
                        let human = if debug.contains("reason error (-5)") || gst_err.contains("stream error") {
                            format!(
                                "Playback failed (stream error). Try another source or track. ({})",
                                gst_err
                            )
                        } else {
                            err_msg.clone()
                        };
                        let _ = app_handle_for_bus.emit("audio-error", human);
                        let yt_fail = current_uri.contains("googlevideo.com")
                            || gst_err.contains("Forbidden")
                            || gst_err.contains("403")
                            || debug.contains("Forbidden")
                            || debug.contains("403")
                            || debug.contains("reason error (-5)");
                        if yt_fail {
                            let _ = app_handle_for_bus.emit("audio-youtube-forbidden", ());
                        }
                    }
                    MessageView::Buffering(buffering) => {
                        let percent = buffering.percent();
                        // Usable start once ~10% buffered (fast time-to-first-audio)
                        if percent < 10 {
                            let _ = app_handle_for_bus.emit("audio-buffering", true);
                        } else {
                            let _ = app_handle_for_bus.emit("audio-buffering", false);
                        }
                    }
                    MessageView::StateChanged(state) => {
                        if state.src().map(|s| s == playbin.upcast_ref::<gstreamer::Object>()).unwrap_or(false) {
                            if state.current() == gstreamer::State::Playing {
                                let _ = app_handle_for_bus.emit("audio-buffering", false);
                                let _ = app_handle_for_bus.emit("audio-ready", true);
                            }
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
    source: String,
    title: Option<String>,
    artist: Option<String>,
) -> Result<String, String> {
    println!("Streaming external audio from {}: {}", source, url);
    let _ = app.emit("audio-buffering", true);
    match crate::aggregator::resolver::resolve_url(&app, &url, title.as_deref(), artist.as_deref()).await {
        Ok(resolved_url) => {
            // Stay buffering until GStreamer Buffering bus clears it
            
            // Check if this is a preview URL (SoundCloud restricted tracks)
            let (actual_url, is_preview) = if let Some(preview_url) = resolved_url.strip_prefix("PREVIEW:") {
                println!("Audio: Playing preview (30s) for restricted track");
                let _ = app.emit("audio-preview", "This track is restricted by the distributor. Playing 30-second preview.");
                (preview_url.to_string(), true)
            } else {
                (resolved_url.clone(), false)
            };
            
            if actual_url.starts_with("file:") {
                let path = url::Url::parse(&actual_url)
                    .ok()
                    .and_then(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .or_else(|| {
                        crate::path_util::resolve_playable_local_path(&actual_url)
                            .ok()
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .or_else(|| {
                        #[cfg(windows)]
                        {
                            actual_url
                                .strip_prefix("file:///")
                                .or_else(|| actual_url.strip_prefix("file://"))
                                .map(|s| s.replace('/', "\\"))
                        }
                        #[cfg(not(windows))]
                        {
                            // file:///data/... → /data/... ; file:////data → collapse
                            let rest = actual_url
                                .strip_prefix("file://")
                                .unwrap_or(&actual_url);
                            let normalized = rest.trim_start_matches('/');
                            Some(format!("/{}", normalized))
                        }
                    })
                    .ok_or_else(|| format!("Invalid file URI: {}", actual_url))?;
                crate::path_util::resolve_playable_local_path(&path)?;
                state
                    .tx
                    .send(AudioCommand::Play(path))
                    .map_err(|e| e.to_string())?;
                let _ = app.emit("audio-buffering", false);
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

/// Download/resolve next track(s) into disk cache while current song plays.
#[tauri::command]
pub async fn prefetch_external_audio(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    artist: Option<String>,
) -> Result<(), String> {
    crate::aggregator::resolver::prefetch_url(&app, &url, title.as_deref(), artist.as_deref()).await
}

#[tauri::command]
pub fn play_audio(state: State<'_, AudioState>, path: String) -> Result<(), String> {
    crate::path_util::resolve_playable_local_path(&path)?;
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

#[derive(serde::Serialize)]
pub struct AudioClock {
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[tauri::command]
pub fn get_audio_clock(state: State<'_, AudioState>) -> Result<AudioClock, String> {
    let (reply_tx, reply_rx) = channel();
    state.tx.send(AudioCommand::GetClock(reply_tx)).map_err(|e| e.to_string())?;

    match reply_rx.recv_timeout(std::time::Duration::from_millis(300)) {
        Ok((pos, dur)) => Ok(AudioClock {
            position_ms: pos.as_millis() as u64,
            duration_ms: dur.as_millis() as u64,
        }),
        Err(_) => Ok(AudioClock {
            position_ms: 0,
            duration_ms: 0,
        }),
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
