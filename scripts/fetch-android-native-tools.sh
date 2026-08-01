#!/usr/bin/env bash
# Fetch yt-dlp + ffmpeg/ffprobe for Android (linux arm64 static) into staging.
# SpotiFLAC ffmpeg zips from spotbye/Dependencies; yt-dlp official aarch64.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${1:-$ROOT/src-tauri/android-sidecars}"
FFMPEG_BASE="${FFMPEG_RELEASE_BASE:-https://github.com/spotbye/Dependencies/releases/download/FFmpeg-8.1}"
YTDLP_URL="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64}"

mkdir -p "$STAGE/arm64-v8a" "$STAGE/armeabi-v7a" "$STAGE/x86_64" "$STAGE/tmp"
cd "$STAGE/tmp"

echo "Fetching yt-dlp (linux aarch64) ..."
curl -fsSL --retry 3 -o yt-dlp "$YTDLP_URL"
chmod +x yt-dlp
cp -f yt-dlp "$STAGE/arm64-v8a/yt-dlp"
# Emulators / older devices: reuse aarch64 only when no other artifact exists
cp -f yt-dlp "$STAGE/armeabi-v7a/yt-dlp" 2>/dev/null || true
cp -f yt-dlp "$STAGE/x86_64/yt-dlp" 2>/dev/null || true

echo "Fetching ffmpeg/ffprobe (linux arm64v8) ..."
curl -fsSL --retry 3 -o ffmpeg-linux-arm64v8.zip "$FFMPEG_BASE/ffmpeg-linux-arm64v8.zip"
curl -fsSL --retry 3 -o ffprobe-linux-arm64v8.zip "$FFMPEG_BASE/ffprobe-linux-arm64v8.zip"

rm -rf ffmpeg_extract ffprobe_extract
mkdir -p ffmpeg_extract ffprobe_extract
unzip -qo ffmpeg-linux-arm64v8.zip -d ffmpeg_extract
unzip -qo ffprobe-linux-arm64v8.zip -d ffprobe_extract

find_bin() {
  local name="$1" dir="$2"
  find "$dir" -type f -name "$name" | head -n1
}

FFMPEG_BIN="$(find_bin ffmpeg ffmpeg_extract)"
FFPROBE_BIN="$(find_bin ffprobe ffprobe_extract)"
if [[ -z "$FFMPEG_BIN" || -z "$FFPROBE_BIN" ]]; then
  echo "Failed to locate ffmpeg/ffprobe in zip extracts" >&2
  find ffmpeg_extract ffprobe_extract -type f | head -50 >&2
  exit 1
fi

chmod +x "$FFMPEG_BIN" "$FFPROBE_BIN"
for abi in arm64-v8a armeabi-v7a x86_64; do
  cp -f "$FFMPEG_BIN" "$STAGE/$abi/ffmpeg"
  cp -f "$FFPROBE_BIN" "$STAGE/$abi/ffprobe"
  chmod +x "$STAGE/$abi/ffmpeg" "$STAGE/$abi/ffprobe" "$STAGE/$abi/yt-dlp" 2>/dev/null || true
done

# Require arm64 artifacts
test -x "$STAGE/arm64-v8a/ffmpeg"
test -x "$STAGE/arm64-v8a/ffprobe"
test -x "$STAGE/arm64-v8a/yt-dlp"
ls -lh "$STAGE/arm64-v8a/"

echo "Staged native tools under $STAGE"
