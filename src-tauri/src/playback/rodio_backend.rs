use super::{AudioBackend, PlaybackStatus};
use lofty::file::AudioFile;
use rodio::decoder::Mp4Type;
use rodio::source::Source;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// cpal OutputStream is !Send on some platforms; we only touch it from the
/// player mutex thread, so this is safe for our usage.
struct SendOutput(OutputStream);
#[allow(dead_code)]
unsafe impl Send for SendOutput {}

pub struct RodioBackend {
    _stream: Option<SendOutput>,
    handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,
    /// Keeps ffmpeg alive for HTTP live streams.
    ffmpeg: Option<Child>,
    uri: Option<String>,
    volume: f32,
    started: Option<Instant>,
    paused_at: Option<u64>,
    duration_ms: u64,
}

impl RodioBackend {
    pub fn new() -> Self {
        Self {
            _stream: None,
            handle: None,
            sink: None,
            ffmpeg: None,
            uri: None,
            volume: 0.85,
            started: None,
            paused_at: None,
            duration_ms: 0,
        }
    }

    fn ensure_output(&mut self) -> Result<&OutputStreamHandle, String> {
        if self.handle.is_none() {
            let (stream, handle) =
                OutputStream::try_default().map_err(|e| format!("audio device: {e}"))?;
            self._stream = Some(SendOutput(stream));
            self.handle = Some(handle);
        }
        self.handle
            .as_ref()
            .ok_or_else(|| "No audio output device".into())
    }

    fn kill_ffmpeg(&mut self) {
        if let Some(mut child) = self.ffmpeg.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn sniff_ok(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.len() < 12 {
        return Err("audio file too small / incomplete".into());
    }
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Err("WebM/Matroska crashes the decoder — need MP3/M4A cache".into());
    }
    if bytes.starts_with(b"OggS") {
        return Err("Ogg/Opus is not supported by the Windows decoder — need MP3/M4A".into());
    }
    if bytes.starts_with(b"ID3") || (bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0) {
        return Ok("mp3");
    }
    if &bytes[4..8] == b"ftyp" {
        return Ok("m4a");
    }
    if bytes.starts_with(b"RIFF") {
        return Ok("wav");
    }
    if bytes.starts_with(b"fLaC") {
        return Ok("flac");
    }
    Err("Unrecognized audio header — re-cache as MP3/M4A".into())
}

pub type RodioSource = Decoder<BufReader<File>>;

fn decode_path(path: &Path) -> Result<RodioSource, String> {
    let mut header = [0u8; 16];
    {
        let mut f = File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
        let n = f.read(&mut header).map_err(|e| e.to_string())?;
        if n < 4 {
            return Err("audio file too small / incomplete".into());
        }
    }
    let kind = sniff_ok(&header)?;

    let open = || File::open(path).map_err(|e| format!("open {path:?}: {e}"));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let file = open()?;
        let reader = BufReader::new(file);
        match kind {
            "mp3" => Decoder::new_mp3(reader),
            "flac" => Decoder::new_flac(reader),
            "wav" => Decoder::new_wav(reader),
            "m4a" => Decoder::new_mp4(reader, Mp4Type::M4a),
            _ => Decoder::new(reader),
        }
        .map_err(|e| format!("decode: {e}"))
    }));

    match result {
        Ok(Ok(decoder)) => Ok(decoder),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(
            "Unsupported or corrupt audio (decoder panic). Prefer MP3 — cache cleared, try again."
                .into(),
        ),
    }
}

/// Live HTTP/HTTPS → ffmpeg PCM → rodio (near-instant start, no full download).
pub struct FfmpegPcmSource {
    reader: BufReader<std::process::ChildStdout>,
    channels: u16,
    sample_rate: u32,
    leftover: Vec<u8>,
}

pub struct PreparedLive {
    pub child: Child,
    pub source: FfmpegPcmSource,
}

impl FfmpegPcmSource {
    /// Heavy I/O — must run **outside** the player mutex or the UI freezes.
    pub(crate) fn spawn(url: &str) -> Result<PreparedLive, String> {
        let ff = crate::ytdlp::find_ffmpeg(None)
            .ok_or_else(|| "ffmpeg required for instant stream play".to_string())?;
        let mut cmd = Command::new(&ff);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-i",
            url,
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg stream spawn: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ffmpeg missing stdout".to_string())?;
        let mut reader = BufReader::with_capacity(64 * 1024, stdout);
        let start = Instant::now();
        let mut leftover = Vec::new();
        let mut probe = [0u8; 4096];
        loop {
            match reader.read(&mut probe) {
                Ok(0) => {
                    if start.elapsed() > Duration::from_secs(8) {
                        let _ = child.kill();
                        return Err("stream produced no audio".into());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(n) => {
                    leftover.extend_from_slice(&probe[..n]);
                    if leftover.len() >= 8 {
                        return Ok(PreparedLive {
                            child,
                            source: Self {
                                reader,
                                channels: 2,
                                sample_rate: 44100,
                                leftover,
                            },
                        });
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    let _ = child.kill();
                    return Err(format!("ffmpeg stream read: {e}"));
                }
            }
            if start.elapsed() > Duration::from_secs(8) {
                let _ = child.kill();
                return Err("stream timed out waiting for audio".into());
            }
        }
    }

    fn read_sample(&mut self) -> Option<f32> {
        while self.leftover.len() < 4 {
            let mut chunk = [0u8; 4096];
            match self.reader.read(&mut chunk) {
                Ok(0) => return None,
                Ok(n) => self.leftover.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        let b = [
            self.leftover[0],
            self.leftover[1],
            self.leftover[2],
            self.leftover[3],
        ];
        self.leftover.drain(0..4);
        Some(f32::from_le_bytes(b))
    }
}

impl Iterator for FfmpegPcmSource {
    type Item = f32;
    fn next(&mut self) -> Option<Self::Item> {
        self.read_sample()
    }
}

impl Source for FfmpegPcmSource {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

impl RodioBackend {
    fn status_inner(&self) -> PlaybackStatus {
        let playing = self
            .sink
            .as_ref()
            .map(|s| !s.empty() && !s.is_paused())
            .unwrap_or(false);
        let position_ms = if let Some(paused) = self.paused_at {
            paused
        } else if let Some(started) = self.started {
            started.elapsed().as_millis() as u64
        } else {
            0
        };
        let duration_ms = if self.duration_ms > 0 {
            self.duration_ms
        } else {
            // Unknown (live stream) — report 0 so UI does not think the track is ~1s long
            // and trigger crossfade/next prematurely.
            0
        };
        PlaybackStatus {
            playing,
            position_ms,
            duration_ms,
            uri: self.uri.clone(),
        }
    }

    fn reset_sink(&mut self) -> Result<Sink, String> {
        let handle = self.ensure_output()?.clone();
        if let Some(old) = self.sink.take() {
            old.stop();
        }
        self.kill_ffmpeg();
        let sink = Sink::try_new(&handle).map_err(|e| e.to_string())?;
        sink.set_volume(self.volume);
        Ok(sink)
    }

    /// Attach a live ffmpeg PCM source prepared **outside** the player lock.
    pub(crate) fn play_prepared_live(
        &mut self,
        uri: String,
        prepared: PreparedLive,
    ) -> Result<(), String> {
        let sink = self.reset_sink()?;
        self.ffmpeg = Some(prepared.child);
        let append_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sink.append(prepared.source);
        }));
        if append_res.is_err() {
            self.kill_ffmpeg();
            return Err("Live stream append failed".into());
        }
        self.duration_ms = 0;
        self.sink = Some(sink);
        self.uri = Some(uri);
        self.started = Some(Instant::now());
        self.paused_at = None;
        Ok(())
    }

    /// Validate + decode a local file **outside** the player lock when possible.
    pub(crate) fn prepare_local(path: &str) -> Result<(String, RodioSource, u64), String> {
        let path = path
            .trim_start_matches("file:///")
            .trim_start_matches("file://")
            .to_string();
        if !Path::new(&path).is_file() {
            return Err(format!("audio file missing: {path}"));
        }

        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(ext.as_str(), "webm" | "mkv" | "ogg" | "opus") {
            let _ = std::fs::remove_file(&path);
            return Err(format!(
                "Format .{ext} is not playable here. Deleted bad cache — play again for MP3."
            ));
        }

        let meta_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if meta_len < 8_000 {
            let _ = std::fs::remove_file(&path);
            return Err("audio file incomplete — deleted cache, play again".into());
        }

        if matches!(ext.as_str(), "m4a" | "mp4" | "aac") {
            let _ = std::fs::remove_file(&path);
            return Err(
                "M4A cache is unreliable on Windows — deleted. Play again to remux as MP3."
                    .into(),
            );
        }

        let source = match decode_path(Path::new(&path)) {
            Ok(s) => s,
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
        };

        let duration_ms = lofty::read_from_path(&path)
            .ok()
            .map(|t| t.properties().duration().as_millis() as u64)
            .unwrap_or(0);

        Ok((path, source, duration_ms))
    }

    pub(crate) fn play_prepared_local(
        &mut self,
        path: String,
        source: RodioSource,
        duration_ms: u64,
    ) -> Result<(), String> {
        let sink = self.reset_sink()?;
        let append_res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sink.append(source);
        }));
        if append_res.is_err() {
            let _ = std::fs::remove_file(&path);
            return Err("Audio append panicked — bad cache deleted, play again".into());
        }
        self.duration_ms = duration_ms;
        self.sink = Some(sink);
        self.uri = Some(path);
        self.started = Some(Instant::now());
        self.paused_at = None;
        Ok(())
    }
}

impl AudioBackend for RodioBackend {
    fn play(&mut self, uri: &str) -> Result<(), String> {
        if uri.starts_with("http://") || uri.starts_with("https://") {
            // Prefer playback_play which prepares outside the lock; this path
            // remains for mpv fallback callers and can still block briefly.
            let prepared = FfmpegPcmSource::spawn(uri)?;
            return self.play_prepared_live(uri.to_string(), prepared);
        }
        let (path, source, duration_ms) = Self::prepare_local(uri)?;
        self.play_prepared_local(path, source, duration_ms)
    }

    fn pause(&mut self) -> Result<(), String> {
        if let Some(sink) = &self.sink {
            let pos = self.status_inner();
            sink.pause();
            self.paused_at = Some(pos.position_ms);
        }
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        if let Some(sink) = &self.sink {
            sink.play();
            if let Some(pos) = self.paused_at.take() {
                self.started =
                    Some(Instant::now() - std::time::Duration::from_millis(pos));
            }
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.kill_ffmpeg();
        self.uri = None;
        self.started = None;
        Ok(())
    }

    fn seek(&mut self, _position_ms: u64) -> Result<(), String> {
        if self
            .uri
            .as_deref()
            .is_some_and(|u| u.starts_with("http://") || u.starts_with("https://"))
        {
            return Err("Seek available after the track finishes caching".into());
        }
        Err("Seek requires the mpv backend".into())
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), String> {
        self.volume = volume;
        if let Some(sink) = &self.sink {
            sink.set_volume(volume);
        }
        Ok(())
    }

    fn status(&mut self) -> PlaybackStatus {
        self.status_inner()
    }

    fn is_rodio(&self) -> bool {
        true
    }

    fn play_live_http(
        &mut self,
        uri: &str,
        prepared: PreparedLive,
    ) -> Result<(), String> {
        self.play_prepared_live(uri.to_string(), prepared)
    }

    fn play_local_prepared(
        &mut self,
        path: String,
        source: RodioSource,
        duration_ms: u64,
    ) -> Result<(), String> {
        self.play_prepared_local(path, source, duration_ms)
    }
}

impl Drop for RodioBackend {
    fn drop(&mut self) {
        self.kill_ffmpeg();
    }
}
