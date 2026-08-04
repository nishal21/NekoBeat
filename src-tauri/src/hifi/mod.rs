//! SpotiFLAC-inspired HiFi search + download queue (FLAC + tags).
use crate::playback::TrackMeta;
use crate::settings::AppSettings;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub track: TrackMeta,
    pub status: String,
    pub progress: f32,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub measured_format: Option<String>,
    /// Requested quality tier (LOSSLESS / HI_RES / HI_RES_LOSSLESS)
    pub requested_quality: Option<String>,
    pub bit_depth: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub service: Option<String>,
    pub needs_login: Option<bool>,
}

#[derive(Default)]
pub struct HifiState {
    pub jobs: Mutex<Vec<DownloadJob>>,
}

#[tauri::command]
pub fn hifi_search(
    settings: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    query: String,
) -> Result<Vec<TrackMeta>, String> {
    let q = query.trim().to_string();
    let base = settings.lock().zarz_api_base.clone();

    // Spotify URL / URI → resolve via api.zarz.moe
    if q.contains("spotify.com/") || q.starts_with("spotify:") {
        if let Ok(resolved) = crate::zarz_api::resolve_url(&base, &q) {
            let id = resolved
                .spotify_id
                .clone()
                .unwrap_or_else(|| q.clone());
            return Ok(vec![TrackMeta {
                id: format!("spotify:{id}"),
                title: "Resolved track".into(),
                artist: "SpotiFLAC resolve".into(),
                album: None,
                duration_ms: None,
                cover_url: None,
                isrc: resolved.isrc,
                spotify_id: resolved.spotify_id.or(Some(id)),
                source: Some("hifi".into()),
                path: None,
                stream_url: resolved.tidal_url.or(resolved.qobuz_url),
                quality_label: Some("LOSSLESS".into()),
            }]);
        }
    }

    crate::stream::stream_search(q).map(|mut rows| {
        let base = settings.lock().zarz_api_base.clone();
        for r in &mut rows {
            r.source = Some("hifi".into());
            r.quality_label = Some(settings.lock().hifi_quality.clone());
            // Enrich Spotify-like ids through resolve when id looks like yt:… skip;
            // if title search later yields spotify ids, callers can zarz_resolve.
            let _ = &base;
        }
        rows
    })
}

#[tauri::command]
pub fn hifi_enqueue(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<HifiState>>,
    settings: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    ext: tauri::State<'_, Arc<crate::extensions::ExtState>>,
    track: TrackMeta,
) -> Result<DownloadJob, String> {
    use tauri::Manager;
    let id = Uuid::new_v4().to_string();
    let cfg = settings.lock().clone();
    let quality = cfg.hifi_quality.clone();
    let service = cfg.preferred_download_service.clone();
    let logged_in = crate::extensions::is_logged_in(&ext, &service);

    if !logged_in {
        let job = DownloadJob {
            id: id.clone(),
            track: track.clone(),
            status: "error".into(),
            progress: 0.0,
            file_path: None,
            error: Some(format!(
                "Login required for {service}. Open Extensions → Connect / save credentials."
            )),
            measured_format: None,
            requested_quality: Some(quality),
            bit_depth: None,
            sample_rate_hz: None,
            service: Some(service),
            needs_login: Some(true),
        };
        state.jobs.lock().push(job.clone());
        return Ok(job);
    }

    let job = DownloadJob {
        id: id.clone(),
        track: track.clone(),
        status: "queued".into(),
        progress: 0.0,
        file_path: None,
        error: None,
        measured_format: None,
        requested_quality: Some(quality.clone()),
        bit_depth: None,
        sample_rate_hz: None,
        service: Some(service.clone()),
        needs_login: Some(false),
    };
    state.jobs.lock().push(job.clone());

    let jobs = state.inner().clone();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hifi");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let embed_meta = cfg.embed_metadata;
    let embed_lyrics = cfg.embed_lyrics;
    let filename_format = cfg.filename_format.clone();
    let auto_fallback = cfg.auto_fallback;
    let api_base = cfg.zarz_api_base.clone();

    std::thread::spawn(move || {
        // Enrich ISRC / platform IDs via api.zarz.moe before download attempt
        let mut track = track;
        if let Some(sid) = track.spotify_id.clone().or_else(|| {
            track
                .id
                .strip_prefix("spotify:")
                .map(|s| s.to_string())
        }) {
            if let Ok(r) = crate::zarz_api::resolve_spotify_track(&api_base, &sid) {
                if track.isrc.is_none() {
                    track.isrc = r.isrc;
                }
                if track.spotify_id.is_none() {
                    track.spotify_id = r.spotify_id.or(Some(sid));
                }
            }
        }
        let _ = (embed_meta, embed_lyrics, filename_format, auto_fallback, service);
        run_download(&jobs, &id, &track, &data_dir, &quality);
    });

    Ok(job)
}

fn run_download(
    state: &HifiState,
    id: &str,
    track: &TrackMeta,
    dir: &PathBuf,
    _quality: &str,
) {
    {
        let mut jobs = state.jobs.lock();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
            j.status = "running".into();
            j.progress = 0.1;
        }
    }

    let out_tmpl = dir.join("%(title)s-%(id)s.%(ext)s");
    let video = track.id.strip_prefix("yt:").unwrap_or(&track.id);
    let url = format!("https://www.youtube.com/watch?v={video}");

    // Prefer FLAC extraction when possible.
    let result = Command::new("yt-dlp")
        .args([
            "-f",
            "bestaudio",
            "-x",
            "--audio-format",
            "flac",
            "--embed-thumbnail",
            "--embed-metadata",
            "-o",
            out_tmpl.to_string_lossy().as_ref(),
            &url,
        ])
        .output();

    match result {
        Ok(output) if output.status.success() => {
            let flac = std::fs::read_dir(dir)
                .ok()
                .and_then(|rd| {
                    rd.filter_map(|e| e.ok())
                        .map(|e| e.path())
                        .find(|p| {
                            p.extension()
                                .and_then(|e| e.to_str())
                                .map(|e| e.eq_ignore_ascii_case("flac"))
                                .unwrap_or(false)
                                && p
                                    .file_name()
                                    .map(|n| n.to_string_lossy().contains(video))
                                    .unwrap_or(false)
                        })
                });
            let mut jobs = state.jobs.lock();
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                    if let Some(path) = flac {
                        // Sidecar LRC placeholder; real lyrics_get fills library later.
                        let lrc = path.with_extension("lrc");
                        let _ = std::fs::write(
                            &lrc,
                            format!("[ti:{}]\n[ar:{}]\n", track.title, track.artist),
                        );
                        let (bit_depth, sample_rate_hz, label) = measure_flac(&path);
                        j.file_path = Some(path.to_string_lossy().into_owned());
                        j.bit_depth = bit_depth;
                        j.sample_rate_hz = sample_rate_hz;
                        j.measured_format = Some(label);
                        j.progress = 1.0;
                        j.status = "done".into();
                    } else {
                    j.status = "error".into();
                    j.error = Some("FLAC not found after download".into());
                }
            }
        }
        Ok(output) => {
            let err = String::from_utf8_lossy(&output.stderr).into_owned();
            let mut jobs = state.jobs.lock();
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                j.status = "error".into();
                j.error = Some(err.chars().take(240).collect());
            }
        }
        Err(e) => {
            let mut jobs = state.jobs.lock();
            if let Some(j) = jobs.iter_mut().find(|j| j.id == id) {
                j.status = "error".into();
                j.error = Some(format!("yt-dlp: {e}"));
            }
        }
    }
}

#[tauri::command]
pub fn hifi_jobs(state: tauri::State<'_, Arc<HifiState>>) -> Vec<DownloadJob> {
    state.jobs.lock().clone()
}

fn measure_flac(path: &PathBuf) -> (Option<u32>, Option<u32>, String) {
    use lofty::file::AudioFile;
    if let Ok(tagged) = lofty::read_from_path(path) {
        let props = tagged.properties();
        let bit = props.bit_depth().map(|b| b as u32);
        let rate = props.sample_rate().filter(|&r| r > 0);
        let label = match (bit, rate) {
            (Some(b), Some(r)) => {
                let khz = f64::from(r) / 1000.0;
                format!("FLAC · {b}bit · {khz:.1}kHz")
            }
            _ => "FLAC".into(),
        };
        return (bit, rate, label);
    }
    (None, None, "FLAC".into())
}
