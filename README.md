<div align="center">

# NekoBeat

**A native, cross-platform music aggregator built with Rust, React, and GStreamer.**

<img src="assets/logo.png" width="160" alt="NekoBeat Logo">

[![Tauri](https://img.shields.io/badge/Tauri_v2-24C8D8?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Download](https://github.com/nishal21/NekoBeat/releases/latest) | [Report Bug](https://github.com/nishal21/NekoBeat/issues)

</div>

---

NekoBeat is not a wrapper for a website. It is a native, hardware-accelerated audio engine that combines Rust's safety, React's fluidity, and GStreamer's audio pipeline to deliver an audiophile-grade listening experience — without the bloat of Electron.

![NekoBeat Main Interface](assets/news.png)

## Features

### Universal Search & Streaming
Search and stream from **YouTube**, **SoundCloud**, and **Spotify** — all from one unified interface. NekoBeat resolves audio through a custom scraping engine with `yt-dlp` fallback for maximum reliability.

![NekoBrowse Search](assets/search.png)

![NekoBrowse Search-2](assets/search2.png)

### Offline Library
Every liked track is automatically cached to your local drive. Your library plays instantly with zero latency, regardless of internet connectivity.

![Liked Songs Library](assets/liked.png)

### 10-Band Equalizer
A GStreamer-powered equalizer integrated directly into the Rust audio pipeline. 10 frequency bands from 31 Hz to 16 kHz with real-time, stutter-free adjustment.

![NekoEQ Equalizer](assets/equalizer.png)

### Synchronized Lyrics
Auto-fetched lyrics from Genius with manual `.lrc` / `.srt` / `.vtt` upload support. Per-track timing offset adjustment, multi-language rendering, and persistent storage across sessions.

![Player & Lyrics](assets/player_expanded.png)

### YouTube Video Sync
When playing YouTube tracks, the music video auto-plays in an embedded window, synchronized with the audio stream.

![Player, Lyrics & Video from YT](assets/yt-play.png)

### Discover (Listen Now)
Live Last.fm scraping surfaces globally trending tracks. One click routes any discovery directly into the search engine.

![NekoBeat Main Interface](assets/news.png)

### Discord Rich Presence
Track titles, artists, remaining time, and album art broadcast to your Discord profile — handled entirely by the Rust backend.

![Discord Rich Presence](assets/discord1.png)

![Discord Rich Presence-2](assets/discord2.png)

### Auto-Updater
In-app update checking with one-click install. Built on the Tauri updater plugin with signed releases.

### Picture-in-Picture Miniplayer
Compact always-on-top floating player with album art, track info, and playback controls. Click anywhere to drag. One click to shrink, one click to expand back.

![PiP Miniplayer](assets/pip.png)

### Media Session Integration
Full Windows SMTC / macOS Now Playing integration with play, pause, next, previous, and seek controls.

![Media-session](assets/smtp-windows.png)

## Architecture

| Layer | Technology |
|-------|-----------|
| **Core** | Rust |
| **Framework** | Tauri v2 |
| **Frontend** | React + TypeScript |
| **Styling** | Tailwind CSS |
| **Animations** | Framer Motion |
| **Audio Engine** | GStreamer |
| **Stream Resolution** | Custom scraping + yt-dlp fallback |
| **Database** | SQLite (via rusqlite) |
| **Lyrics** | Genius API scraping |

## Installation

### Download

Grab the latest release from the [Releases](https://github.com/nishal21/NekoBeat/releases/latest) page.

- **Windows**: `NekoBeat_x64-setup.exe` (recommended) or `.msi`

> The Windows installer bundles all dependencies including GStreamer — no manual setup required.

### Build from Source

**Prerequisites:**
- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install)
- [GStreamer](https://gstreamer.freedesktop.org/download/) development libraries
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) in your system PATH

```bash
git clone https://github.com/nishal21/NekoBeat.git
cd NekoBeat
npm install
npm run tauri dev
```

### Build a Release

```bash
# Build signed installer (Windows)
.\scripts\build-release.ps1
```

This produces signed `.exe` and `.msi` installers with `.sig` files for the auto-updater.

## Project Structure

```
nekobeat/
├── src/                    # React frontend
│   ├── App.tsx             # Main application
│   └── hooks.ts            # Custom React hooks
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         # Entry point & GStreamer init
│   │   ├── lib.rs          # Tauri command registration
│   │   ├── audio.rs        # GStreamer playback engine
│   │   ├── aggregator/     # Search, resolve, Spotify, SoundCloud
│   │   ├── offline.rs      # Local caching & liked songs
│   │   └── library.rs      # SQLite database operations
│   ├── gstreamer/          # Bundled GStreamer runtime
│   └── binaries/           # External tools (spotiflac-cli)
└── scripts/
    ├── build-release.ps1   # Signed release builder
    └── publish-update.ps1  # Update manifest generator
```

## Acknowledgments

NekoBeat was built with inspiration and reference from these amazing open-source projects:

- **[Harmonoid](https://github.com/harmonoid/harmonoid)** — Beautiful cross-platform music player built with Flutter. Influenced NekoBeat's UI/UX approach and local library management design.
- **[Muffon](https://github.com/staniel359/muffon)** — Advanced multi-source music streaming & discovery client. Inspired the multi-source aggregation architecture.
- **[Muffon API](https://github.com/staniel359/muffon-api)** — Backend API powering Muffon's multi-source integration. Referenced for source aggregation patterns.
- **[SpotiFLAC](https://github.com/afkarxyz/SpotiFLAC)** — Spotify to lossless FLAC downloader via Tidal/Amazon/Deezer fallback chain. Powers NekoBeat's Spotify playback pipeline.
- **[Spotify Lyrics API](https://github.com/akashrchandran/spotify-lyrics-api)** — Lightweight API for fetching synced lyrics from Spotify. Used for real-time lyrics display.
- **[MusicXMatch API](https://github.com/Fabrice-Music/musicxmatch-api)** — TypeScript wrapper for Musixmatch with automatic signature generation. Referenced for lyrics fetching.

Thank you to all the developers and contributors behind these projects.

## License

[MIT](LICENSE)

---

<div align="center">

Made with care by [Nishal](https://github.com/nishal21)

*"Music is the wine that fills the cup of silence."*

</div>
