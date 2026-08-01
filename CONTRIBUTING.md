# Contributing to NekoBeat

Thanks for wanting to help. Bug reports, ideas, and pull requests are welcome as long as they fit the license below.

## License (read this first)

NekoBeat uses the [PolyForm Noncommercial License 1.0.0](LICENSE). That means:

- Personal use, forks, experiments, and noncommercial builds are fine.
- Selling NekoBeat, shipping it in a paid product, putting ads or paid subscriptions on it, or otherwise using it commercially is not allowed under this license.
- Contributions you submit are accepted under the same terms. By opening a PR you agree your changes can be distributed with NekoBeat under that license.
- If you need commercial rights, contact the copyright holder ([Nishal](https://github.com/nishal21)) for a separate agreement.

Keep a copy of `LICENSE` (or a link to it) with any fork you publish.

## Reporting bugs

Check existing issues first. If yours is new, open one with what you expected, what happened, and steps to reproduce. OS and app version help a lot.

## Suggesting changes

Open an issue with the `enhancement` label. Say what you want and why it matters for NekoBeat. Small, concrete proposals are easier to act on than vague wish lists.

## Pull requests

1. Fork the repo and clone your fork.
2. Create a branch for the change (`git checkout -b fix/something-clear`).
3. Match the existing stack and style: Tauri v2, Rust, GStreamer, React.
4. Commit with a short message that says why the change exists.
5. Push and open a PR against `main`.

Do not add telemetry or tracking without an explicit, optional user consent path. NekoBeat is local-first.

## Development setup

- Rust and Tauri v2 toolchain
- GStreamer development libraries (required to build the audio engine)
- `yt-dlp` available for audio resolution (bundled or on PATH)

See the README and `docs/` for platform notes (Windows bundled GStreamer, Linux system packages, Android SDK).

## UI notes

Stick to the current neon/glass look and motion. New screens should feel like the rest of the app, not a separate theme.

## Conduct

Be decent. Disagree on code, not on people.
