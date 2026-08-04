//! mpv IPC backend — same engine family as Spotube/Harmonoid media_kit.
//! mpv IPC backend — same engine family as Spotube/Harmonoid media_kit.
use super::{AudioBackend, PlaybackStatus};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::fs::OpenOptions;

#[cfg(not(windows))]
use std::net::Shutdown;
#[cfg(not(windows))]
use std::os::unix::net::UnixStream;

pub struct MpvBackend {
    child: Option<Child>,
    ipc_path: String,
    uri: Option<String>,
    volume: f32,
    start_pos_ms: AtomicU64,
}

impl MpvBackend {
    pub fn available() -> bool {
        Command::new("mpv")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    pub fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let ipc_path = if cfg!(windows) {
            format!(r"\\.\pipe\nekobeat-mpv-{stamp}")
        } else {
            format!("/tmp/nekobeat-mpv-{stamp}")
        };
        Self {
            child: None,
            ipc_path,
            uri: None,
            volume: 0.85,
            start_pos_ms: AtomicU64::new(0),
        }
    }

    fn ensure_process(&mut self) -> Result<(), String> {
        if self.child.as_mut().and_then(|c| c.try_wait().ok().flatten()).is_none()
            && self.child.is_some()
        {
            return Ok(());
        }
        let child = Command::new("mpv")
            .args([
                "--no-video",
                "--idle=yes",
                "--quiet",
                &format!("--input-ipc-server={}", self.ipc_path),
                &format!("--volume={}", (self.volume * 100.0) as u32),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn mpv: {e}"))?;
        self.child = Some(child);
        std::thread::sleep(std::time::Duration::from_millis(200));
        Ok(())
    }

    fn send_cmd(&mut self, cmd: serde_json::Value) -> Result<serde_json::Value, String> {
        self.ensure_process()?;
        let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())? + "\n";

        #[cfg(windows)]
        {
            let mut pipe = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.ipc_path)
                .map_err(|e| format!("mpv ipc open: {e}"))?;
            pipe.write_all(line.as_bytes())
                .map_err(|e| format!("mpv ipc write: {e}"))?;
            let mut reader = BufReader::new(pipe.try_clone().map_err(|e| e.to_string())?);
            let mut resp = String::new();
            reader
                .read_line(&mut resp)
                .map_err(|e| format!("mpv ipc read: {e}"))?;
            serde_json::from_str(&resp).map_err(|e| format!("mpv ipc json: {e}"))
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::net::UnixStream;
            let mut stream = UnixStream::connect(&self.ipc_path)
                .map_err(|e| format!("mpv ipc connect: {e}"))?;
            stream
                .write_all(line.as_bytes())
                .map_err(|e| format!("mpv ipc write: {e}"))?;
            let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
            let mut resp = String::new();
            reader
                .read_line(&mut resp)
                .map_err(|e| format!("mpv ipc read: {e}"))?;
            let _ = stream.shutdown(Shutdown::Both);
            serde_json::from_str(&resp).map_err(|e| format!("mpv ipc json: {e}"))
        }
    }

    fn get_prop<T: serde::de::DeserializeOwned>(&mut self, name: &str) -> Option<T> {
        let resp = self
            .send_cmd(serde_json::json!({
                "command": ["get_property", name]
            }))
            .ok()?;
        serde_json::from_value(resp.get("data")?.clone()).ok()
    }
}

impl AudioBackend for MpvBackend {
    fn play(&mut self, uri: &str) -> Result<(), String> {
        self.uri = Some(uri.to_string());
        self.start_pos_ms.store(0, Ordering::Relaxed);
        self.send_cmd(serde_json::json!({
            "command": ["loadfile", uri, "replace"]
        }))?;
        let _ = self.send_cmd(serde_json::json!({ "command": ["set_property", "pause", false] }));
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        self.send_cmd(serde_json::json!({ "command": ["set_property", "pause", true] }))
            .map(|_| ())
    }

    fn resume(&mut self) -> Result<(), String> {
        self.send_cmd(serde_json::json!({ "command": ["set_property", "pause", false] }))
            .map(|_| ())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.uri = None;
        self.send_cmd(serde_json::json!({ "command": ["stop"] }))
            .map(|_| ())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), String> {
        let secs = position_ms as f64 / 1000.0;
        self.send_cmd(serde_json::json!({
            "command": ["seek", secs, "absolute"]
        }))
        .map(|_| ())
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), String> {
        self.volume = volume;
        self.send_cmd(serde_json::json!({
            "command": ["set_property", "volume", (volume * 100.0) as u32]
        }))
        .map(|_| ())
    }

    fn status(&mut self) -> PlaybackStatus {
        let paused: bool = self.get_prop("pause").unwrap_or(true);
        let pos: f64 = self.get_prop("time-pos").unwrap_or(0.0);
        let dur: f64 = self.get_prop("duration").unwrap_or(0.0);
        PlaybackStatus {
            playing: !paused && self.uri.is_some(),
            position_ms: (pos * 1000.0) as u64,
            duration_ms: (dur * 1000.0) as u64,
            uri: self.uri.clone(),
        }
    }

    fn set_eq(&mut self, bands: &[f32]) -> Result<(), String> {
        // Map 10-band gains into mpv af equalizer if available.
        let gains: Vec<String> = bands
            .iter()
            .map(|g| format!("{g}"))
            .collect();
        let _ = self.send_cmd(serde_json::json!({
            "command": ["set_property", "af", format!("lavfi=[equalizer=g={}:f=60]", gains.first().unwrap_or(&"0".into()))]
        }));
        Ok(())
    }
}

impl Drop for MpvBackend {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}
