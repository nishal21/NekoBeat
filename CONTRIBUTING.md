# Contributing to NekoBeat 🎧

First off, thank you for considering contributing to NekoBeat! It's people like you that make NekoBeat such a great tool for the music community.

## 🚀 How Can I Contribute?

### Reporting Bugs
* Check the existing issues to see if the bug has already been reported.
* If not, open a new issue. Clearly describe the problem and include steps to reproduce it.

### Suggesting Enhancements
* Open an issue with the tag `enhancement`.
* Explain the feature you'd like to see and why it would be useful for NekoBeat.

### Pull Requests
1. **Fork the Repo**: Create your own fork of the repository.
2. **Clone Locally**: `git clone https://github.com/nishal21/NekoBeat.git`
3. **Branch**: Create a branch for your fix or feature (`git checkout -b feature/amazing-feature`).
4. **Develop**: Make your changes. Ensure you follow the existing style and architecture (Tauri v2, GStreamer, React).
5. **Commit**: Keep your commits clean and descriptive (`git commit -m 'Add support for FLAC streaming'`).
6. **Push**: `git push origin feature/amazing-feature`
7. **Open a PR**: Submit your pull request to the `main` branch.

## 🛠️ Development Setup

NekoBeat is a high-performance app with a few specific requirements:
- **Rust & Tauri v2**: Ensure your environment is set up for Tauri v2 development.
- **GStreamer**: You **must** have GStreamer development libraries installed locally to compile the audio engine.
- **yt-dlp**: Make sure `yt-dlp` is in your system PATH for audio resolution.

## 🎨 Creative Guidelines
- **UI Consistency**: We use a "Neon-Glass" aesthetic. Please ensure new components match the current glassmorphism and motion feel.
- **Privacy First**: Never add telemetry or tracking without explicit user consent. NekoBeat is local-first.

## 📜 Code of Conduct
Please be respectful and kind to others in every interaction. We aim to build a welcoming community for everyone.

---

Happy coding! 🎹✨
