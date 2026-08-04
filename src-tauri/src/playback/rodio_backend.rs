use super::{AudioBackend, PlaybackStatus};
use lofty::file::AudioFile;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use std::fs::File;
use std::io::BufReader;
use std::time::Instant;

/// cpal OutputStream is !Send on some platforms; we only touch it from the
/// player mutex thread, so this is safe for our usage.
struct SendOutput(OutputStream);
unsafe impl Send for SendOutput {}

pub struct RodioBackend {
    _stream: Option<SendOutput>,
    handle: Option<OutputStreamHandle>,
    sink: Option<Sink>,
    uri: Option<String>,
    volume: f32,
    started: Option<Instant>,
    paused_at: Option<u64>,
    duration_ms: u64,
}

impl RodioBackend {
    pub fn new() -> Self {
        let pair = OutputStream::try_default().ok();
        let (stream, handle) = match pair {
            Some((s, h)) => (Some(SendOutput(s)), Some(h)),
            None => (None, None),
        };
        Self {
            _stream: stream,
            handle,
            sink: None,
            uri: None,
            volume: 0.85,
            started: None,
            paused_at: None,
            duration_ms: 0,
        }
    }
}

impl AudioBackend for RodioBackend {
    fn play(&mut self, uri: &str) -> Result<(), String> {
        let handle = self
            .handle
            .as_ref()
            .ok_or_else(|| "No audio output device".to_string())?;
        let sink = Sink::try_new(handle).map_err(|e| e.to_string())?;
        sink.set_volume(self.volume);

        if uri.starts_with("http://") || uri.starts_with("https://") {
            let resp = reqwest::blocking::get(uri).map_err(|e| e.to_string())?;
            let bytes = resp.bytes().map_err(|e| e.to_string())?;
            let cursor = std::io::Cursor::new(bytes.to_vec());
            let source = Decoder::new(cursor).map_err(|e| e.to_string())?;
            sink.append(source);
            self.duration_ms = 0;
        } else {
            let path = uri
                .trim_start_matches("file:///")
                .trim_start_matches("file://");
            let file = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
            let source = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
            sink.append(source);
            self.duration_ms = lofty::read_from_path(path)
                .ok()
                .map(|t| t.properties().duration().as_millis() as u64)
                .unwrap_or(0);
        }

        self.sink = Some(sink);
        self.uri = Some(uri.to_string());
        self.started = Some(Instant::now());
        self.paused_at = None;
        Ok(())
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
        self.uri = None;
        self.started = None;
        Ok(())
    }

    fn seek(&mut self, _position_ms: u64) -> Result<(), String> {
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
        PlaybackStatus {
            playing,
            position_ms,
            duration_ms: self.duration_ms.max(position_ms),
            uri: self.uri.clone(),
        }
    }
}
