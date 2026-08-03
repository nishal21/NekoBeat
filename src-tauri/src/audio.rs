use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

const MIN_PLAYBACK_RATE: f64 = 0.5;
const MAX_PLAYBACK_RATE: f64 = 2.0;
const MIN_REPLAY_GAIN_DB: f64 = -24.0;
const MAX_REPLAY_GAIN_DB: f64 = 12.0;

#[derive(Clone, Copy, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplayGainMode {
    #[default]
    Off,
    Track,
    Album,
}

#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
pub struct ReplayGainTags {
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct PlaybackCapabilities {
    pub playback_rate: bool,
    pub min_playback_rate: f64,
    pub max_playback_rate: f64,
    pub replay_gain: bool,
    pub replay_gain_strategy: &'static str,
    pub replay_gain_filter_available: bool,
    pub pitch: bool,
    pub pitch_element_available: bool,
    pub mobile_controls: bool,
}

fn clamp_playback_rate(rate: f64) -> Result<f64, String> {
    if !rate.is_finite() {
        return Err("Playback rate must be finite".into());
    }
    Ok(rate.clamp(MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE))
}

fn replay_gain_multiplier(
    mode: ReplayGainMode,
    preamp_db: f64,
    tags: ReplayGainTags,
) -> f64 {
    let (gain_db, peak) = match mode {
        ReplayGainMode::Off => return 1.0,
        ReplayGainMode::Track => (tags.track_gain_db, tags.track_peak),
        ReplayGainMode::Album => (
            tags.album_gain_db.or(tags.track_gain_db),
            tags.album_peak.or(tags.track_peak),
        ),
    };
    let Some(gain_db) = gain_db.filter(|gain| gain.is_finite()) else {
        return 1.0;
    };

    let mut effective_db =
        (gain_db + preamp_db.clamp(-12.0, 12.0)).clamp(MIN_REPLAY_GAIN_DB, MAX_REPLAY_GAIN_DB);
    if let Some(peak) = peak.filter(|peak| peak.is_finite() && *peak > 0.0) {
        // Keep the predicted sample peak at or below full scale. This is deliberately
        // conservative and avoids requiring a live limiter/filter graph mutation.
        effective_db = effective_db.min(-20.0 * peak.log10());
    }
    10f64.powf(effective_db / 20.0)
}

fn output_volume(user_volume: f64, replay_gain: f64) -> f64 {
    user_volume.clamp(0.0, 1.0) * replay_gain.clamp(0.0, 4.0)
}

fn seek_with_rate(
    element: &gstreamer::Element,
    position: std::time::Duration,
    rate: f64,
) -> Result<(), String> {
    use gstreamer::prelude::*;
    let position = gstreamer::ClockTime::from_nseconds(
        position.as_nanos().min(u64::MAX as u128) as u64,
    );
    element
        .seek(
            rate,
            gstreamer::SeekFlags::FLUSH | gstreamer::SeekFlags::ACCURATE,
            gstreamer::SeekType::Set,
            position,
            gstreamer::SeekType::None,
            gstreamer::ClockTime::NONE,
        )
        .map_err(|error| error.to_string())
}

pub enum AudioCommand {
    Play(String),
    PlayUrl(String),
    Pause,
    Resume,
    Seek(std::time::Duration),
    SetVolume(f64),
    SetEqBand(u32, f64),
    SetPlaybackRate(f64, Sender<Result<f64, String>>),
    SetReplayGain {
        mode: ReplayGainMode,
        preamp_db: f64,
        tags: ReplayGainTags,
    },
    GetPosition(Sender<std::time::Duration>),
    GetDuration(Sender<std::time::Duration>),
    GetClock(Sender<(std::time::Duration, std::time::Duration)>),
}

pub struct AudioState {
    pub tx: Sender<AudioCommand>,
    /// Invalidates slow URL resolutions when a newer play request arrives.
    play_generation: Arc<AtomicU64>,
}

pub fn init_audio_thread(app_handle: AppHandle) -> AudioState {
    let (tx, rx) = channel::<AudioCommand>();
    let tx_internal = tx.clone();
    let play_generation = Arc::new(AtomicU64::new(0));

    thread::spawn(move || {
        let exe_path = std::env::current_exe().unwrap_or_default();
        let exe_dir = exe_path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let log_path = exe_dir.join("nekobeat_startup.log");

        let _ = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "GStreamer audio thread initialized.")
        });

        use gstreamer::prelude::*;
        let playbin = match gstreamer::ElementFactory::make("playbin").build() {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("Failed to create playbin element: {e}");
                eprintln!("{msg}");
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log_path)
                    .and_then(|mut f| {
                        use std::io::Write;
                        writeln!(f, "{msg}")
                    });
                let _ = app_handle.emit("audio-error", msg);
                // Stay alive so the UI can open; drain commands without panicking.
                while rx.recv().is_ok() {}
                return;
            }
        };

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
            let source = match args[1].get::<gstreamer::Element>() {
                Ok(s) => s,
                Err(_) => return None,
            };

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

        // Android OpenSLES + FLAC/hi-res often dies when equalizer-10bands is forced
        // as audio-filter (library preview crash). Desktop keeps EQ.
        #[cfg(not(target_os = "android"))]
        let equalizer = {
            let equalizer = gstreamer::ElementFactory::make("equalizer-10bands")
                .build()
                .ok();
            if let Some(ref eq) = equalizer {
                playbin.set_property("audio-filter", eq);
            } else {
                eprintln!("GStreamer: equalizer-10bands unavailable — EQ disabled");
            }
            equalizer
        };
        #[cfg(target_os = "android")]
        let equalizer: Option<gstreamer::Element> = {
            println!("GStreamer: Android — EQ filter skipped (stable local FLAC/MP3)");
            None
        };

        // Android: OpenSLES sink element is openslessink (plugin name "opensles")
        #[cfg(target_os = "android")]
        {
            let sink = gstreamer::ElementFactory::make("openslessink")
                .build()
                .or_else(|_| gstreamer::ElementFactory::make("opensles").build());
            if let Ok(opensles) = sink {
                playbin.set_property("audio-sink", &opensles);
                println!("GStreamer: using OpenSLES audio sink");
            } else {
                eprintln!("GStreamer: openslessink unavailable — playbin will auto-pick sink");
            }
        }

        // Low preroll — start audible ASAP; soup will keep filling behind
        playbin.set_property("buffer-size", &(256 * 1024i32));
        playbin.set_property("buffer-duration", &(800_000_000i64));
        
        // User volume and ReplayGain stay separate. The pipeline receives their product,
        // so changing normalization never destroys the user's volume preference.
        let mut current_volume: f64 = 1.0;
        let mut current_replay_gain: f64 = 1.0;
        let mut current_rate: f64 = 1.0;
        let mut current_eq: [f64; 10] = [0.0; 10];
        let mut current_uri = String::new();
        // Cached clock — refreshed every loop so UI never depends on a raced IPC query
        let mut cached_pos = std::time::Duration::ZERO;
        let mut cached_dur = std::time::Duration::ZERO;
        // Ignore Pause commands briefly after Resume (SMTC/shortcut double-fire)
        let mut resume_guard_until = std::time::Instant::now();
        // Ignore Seek briefly after Play — stale UI seeks were jumping new tracks to ~EOF
        let mut play_guard_until = std::time::Instant::now();

        let bus = match playbin.bus() {
            Some(b) => b,
            None => {
                let msg = "Failed to get bus from playbin".to_string();
                eprintln!("{msg}");
                let _ = app_handle.emit("audio-error", msg);
                while rx.recv().is_ok() {}
                return;
            }
        };
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
                        let _ = playbin.state(gstreamer::ClockTime::from_seconds(1));
                        // Nulling the previous pipeline can enqueue EOS/error messages. They
                        // belong to the old track and must not advance the newly selected queue.
                        while bus.pop().is_some() {}

                        let uri = crate::path_util::path_to_file_uri(&resolved);
                        current_uri = uri.clone();
                        playbin.set_property("uri", &uri);
                        // Re-apply volume and EQ after pipeline reset
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
                        if let Some(ref eq) = equalizer {
                            for (i, &g) in current_eq.iter().enumerate() {
                                if g != 0.0 {
                                    eq.set_property(&format!("band{}", i), &g);
                                }
                            }
                        }
                        if set_state_safe(&playbin, gstreamer::State::Playing, &app_handle) {
                            #[cfg(not(target_os = "android"))]
                            if (current_rate - 1.0).abs() > f64::EPSILON {
                                if let Err(error) =
                                    seek_with_rate(&playbin, std::time::Duration::ZERO, current_rate)
                                {
                                    eprintln!("GStreamer: Initial rate seek failed: {error}");
                                    current_rate = 1.0;
                                }
                            }
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
                        let _ = playbin.state(gstreamer::ClockTime::from_seconds(1));
                        while bus.pop().is_some() {}
                        current_uri = url.clone();
                        playbin.set_property("uri", &url);
                        // Re-apply volume and EQ after pipeline reset
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
                        if let Some(ref eq) = equalizer {
                            for (i, &g) in current_eq.iter().enumerate() {
                                if g != 0.0 {
                                    eq.set_property(&format!("band{}", i), &g);
                                }
                            }
                        }
                        if set_state_safe(&playbin, gstreamer::State::Playing, &app_handle) {
                            #[cfg(not(target_os = "android"))]
                            if (current_rate - 1.0).abs() > f64::EPSILON {
                                if let Err(error) =
                                    seek_with_rate(&playbin, std::time::Duration::ZERO, current_rate)
                                {
                                    eprintln!("GStreamer: Initial rate seek failed: {error}");
                                    current_rate = 1.0;
                                }
                            }
                            let _ = app_handle.emit("audio-playing", url);
                            // Many HTTP sources never emit Buffering messages — don't leave UI stuck.
                            let _ = app_handle.emit("audio-buffering", false);
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
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
                        // Force pipeline back to Playing; on Windows pause→play can go silent
                        // without a flush seek to the current position.
                        let _ = playbin.set_state(gstreamer::State::Playing);
                        if cached_pos.as_millis() > 0 {
                            if let Err(e) = seek_with_rate(&playbin, cached_pos, current_rate) {
                                eprintln!("GStreamer: Resume seek failed: {}", e);
                            }
                        }
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
                        let (_ret, state, _pending) =
                            playbin.state(gstreamer::ClockTime::from_seconds(1));
                        println!("GStreamer: State after resume: {:?}", state);
                        if state != gstreamer::State::Playing {
                            eprintln!("GStreamer: Not Playing after resume — forcing Playing");
                            let _ = set_state_safe(&playbin, gstreamer::State::Playing, &app_handle);
                            playbin.set_property(
                                "volume",
                                output_volume(current_volume, current_replay_gain),
                            );
                        }
                    }
                    AudioCommand::Seek(duration) => {
                        if std::time::Instant::now() < play_guard_until {
                            println!("GStreamer: Ignoring stale Seek {:?} (play guard)", duration);
                            continue;
                        }
                        println!("GStreamer: Seeking to {:?}", duration);
                        cached_pos = duration;
                        if let Err(error) = seek_with_rate(&playbin, duration, current_rate) {
                            eprintln!("GStreamer: Seek failed: {error}");
                        }
                    }
                    AudioCommand::SetVolume(volume) => {
                        println!("GStreamer: Setting volume to {}", volume);
                        current_volume = volume.clamp(0.0, 1.0);
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
                    }
                    AudioCommand::SetEqBand(band, gain) => {
                        if (band as usize) < current_eq.len() {
                            let clamped_gain = gain.clamp(-24.0, 12.0);
                            current_eq[band as usize] = clamped_gain;
                            if let Some(ref eq) = equalizer {
                                let prop_name = format!("band{}", band);
                                eq.set_property(&prop_name, &clamped_gain);
                            }
                        }
                    }
                    AudioCommand::SetPlaybackRate(rate, reply_tx) => {
                        #[cfg(target_os = "android")]
                        {
                            let _ = rate;
                            let _ = reply_tx.send(Err(
                                "Playback-rate control is disabled on Android for pipeline stability"
                                    .into(),
                            ));
                        }
                        #[cfg(not(target_os = "android"))]
                        {
                            let result = clamp_playback_rate(rate).and_then(|rate| {
                                if current_uri.is_empty() {
                                    current_rate = rate;
                                    return Ok(rate);
                                }
                                let position = playbin
                                    .query_position::<gstreamer::ClockTime>()
                                    .map(|time| std::time::Duration::from_nanos(time.nseconds()))
                                    .unwrap_or(cached_pos);
                                seek_with_rate(&playbin, position, rate)?;
                                cached_pos = position;
                                current_rate = rate;
                                Ok(rate)
                            });
                            let _ = reply_tx.send(result);
                        }
                    }
                    AudioCommand::SetReplayGain {
                        mode,
                        preamp_db,
                        tags,
                    } => {
                        current_replay_gain = replay_gain_multiplier(mode, preamp_db, tags);
                        playbin.set_property(
                            "volume",
                            output_volume(current_volume, current_replay_gain),
                        );
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

    AudioState {
        tx: tx_internal,
        play_generation,
    }
}

#[tauri::command]
pub async fn stream_external_audio(
    app: tauri::AppHandle,
    state: tauri::State<'_, AudioState>, 
    url: String, 
    source: String,
    title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<u64>,
) -> Result<String, String> {
    let generation = state.play_generation.fetch_add(1, Ordering::SeqCst) + 1;
    println!("Streaming external audio from {}: {}", source, url);
    let _ = app.emit("audio-buffering", true);
    match crate::aggregator::resolver::resolve_url_with_duration(
        &app,
        &url,
        title.as_deref(),
        artist.as_deref(),
        duration_ms,
    )
    .await
    {
        Ok(resolved_url) => {
            if state.play_generation.load(Ordering::SeqCst) != generation {
                return Err("Playback request superseded".into());
            }
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
            if state.play_generation.load(Ordering::SeqCst) != generation {
                return Err("Playback request superseded".into());
            }
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
    duration_ms: Option<u64>,
) -> Result<(), String> {
    crate::aggregator::resolver::prefetch_url_with_duration(
        &app,
        &url,
        title.as_deref(),
        artist.as_deref(),
        duration_ms,
    )
    .await
}

#[tauri::command]
pub fn play_audio(state: State<'_, AudioState>, path: String) -> Result<(), String> {
    crate::path_util::resolve_playable_local_path(&path)?;
    state.play_generation.fetch_add(1, Ordering::SeqCst);
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

#[tauri::command]
pub fn set_playback_rate(state: State<'_, AudioState>, rate: f64) -> Result<f64, String> {
    let (reply_tx, reply_rx) = channel();
    state
        .tx
        .send(AudioCommand::SetPlaybackRate(rate, reply_tx))
        .map_err(|error| error.to_string())?;
    reply_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .map_err(|_| "Timed out while changing playback rate".to_string())?
}

#[tauri::command]
pub fn set_replay_gain(
    state: State<'_, AudioState>,
    mode: ReplayGainMode,
    preamp_db: f64,
    tags: ReplayGainTags,
) -> Result<(), String> {
    if !preamp_db.is_finite() {
        return Err("ReplayGain preamp must be finite".into());
    }
    state
        .tx
        .send(AudioCommand::SetReplayGain {
            mode,
            preamp_db: preamp_db.clamp(-12.0, 12.0),
            tags,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_playback_capabilities() -> PlaybackCapabilities {
    let replay_gain_filter_available =
        gstreamer::ElementFactory::find("rgvolume").is_some()
            && gstreamer::ElementFactory::find("rglimiter").is_some();
    let pitch_element_available = gstreamer::ElementFactory::find("pitch").is_some()
        || gstreamer::ElementFactory::find("rubberband").is_some();

    PlaybackCapabilities {
        playback_rate: cfg!(not(target_os = "android")),
        min_playback_rate: MIN_PLAYBACK_RATE,
        max_playback_rate: MAX_PLAYBACK_RATE,
        replay_gain: true,
        // The graph is intentionally not mutated at runtime. This preserves playbin/EQ
        // stability and makes off/track/album switching safe on every supported platform.
        replay_gain_strategy: "volume",
        replay_gain_filter_available,
        pitch: false,
        pitch_element_available,
        mobile_controls: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_rate_is_finite_and_clamped() {
        assert_eq!(clamp_playback_rate(0.1).unwrap(), MIN_PLAYBACK_RATE);
        assert_eq!(clamp_playback_rate(1.25).unwrap(), 1.25);
        assert_eq!(clamp_playback_rate(9.0).unwrap(), MAX_PLAYBACK_RATE);
        assert!(clamp_playback_rate(f64::NAN).is_err());
    }

    #[test]
    fn replay_gain_off_and_missing_tags_are_unity() {
        let tags = ReplayGainTags {
            track_gain_db: Some(-6.0),
            ..Default::default()
        };
        assert_eq!(replay_gain_multiplier(ReplayGainMode::Off, 12.0, tags), 1.0);
        assert_eq!(
            replay_gain_multiplier(ReplayGainMode::Track, 6.0, ReplayGainTags::default()),
            1.0
        );
    }

    #[test]
    fn replay_gain_album_falls_back_to_track() {
        let tags = ReplayGainTags {
            track_gain_db: Some(-6.0),
            ..Default::default()
        };
        let multiplier = replay_gain_multiplier(ReplayGainMode::Album, 0.0, tags);
        assert!((multiplier - 10f64.powf(-6.0 / 20.0)).abs() < 1e-9);
    }

    #[test]
    fn replay_gain_peak_prevents_clipping() {
        let tags = ReplayGainTags {
            track_gain_db: Some(8.0),
            track_peak: Some(0.8),
            ..Default::default()
        };
        let multiplier = replay_gain_multiplier(ReplayGainMode::Track, 6.0, tags);
        assert!((multiplier * 0.8 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn output_volume_preserves_user_factor() {
        assert!((output_volume(0.5, 1.5) - 0.75).abs() < 1e-9);
        assert_eq!(output_volume(-1.0, 2.0), 0.0);
        assert_eq!(output_volume(2.0, 1.0), 1.0);
    }
}
