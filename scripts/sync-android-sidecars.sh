#!/usr/bin/env bash
# Sync SpotiFLAC + ffmpeg + yt-dlp into Android jniLibs as lib*.so (executable).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARIES="$ROOT/src-tauri/binaries"
STAGE="${ANDROID_SIDECAR_STAGE:-$ROOT/src-tauri/android-sidecars}"
JNILIBS="$ROOT/src-tauri/gen/android/app/src/main/jniLibs"

sync_abi() {
  local abi="$1" triple="$2"
  local dest="$JNILIBS/$abi"
  mkdir -p "$dest"

  local spoti="$BINARIES/spotiflac-cli-$triple"
  if [[ -f "$spoti" ]]; then
    cp -f "$spoti" "$dest/libspotiflac_cli.so"
    chmod +x "$dest/libspotiflac_cli.so"
    echo "Synced spotiflac -> $dest/libspotiflac_cli.so"
  else
    echo "warn: missing $spoti" >&2
  fi

  for pair in "ffmpeg:libffmpeg.so" "ffprobe:libffprobe.so" "yt-dlp:libytdlp.so"; do
    local src_name="${pair%%:*}"
    local dst_name="${pair##*:}"
    local src="$STAGE/$abi/$src_name"
    if [[ -f "$src" ]]; then
      cp -f "$src" "$dest/$dst_name"
      chmod +x "$dest/$dst_name"
      echo "Synced $src_name -> $dest/$dst_name"
    else
      echo "warn: missing $src" >&2
    fi
  done
}

sync_abi arm64-v8a aarch64-linux-android
sync_abi armeabi-v7a armv7-linux-androideabi
sync_abi x86_64 x86_64-linux-android

# Hard-require arm64 SpotiFLAC + tools for release APKs
test -f "$JNILIBS/arm64-v8a/libspotiflac_cli.so"
test -f "$JNILIBS/arm64-v8a/libffmpeg.so"
test -f "$JNILIBS/arm64-v8a/libffprobe.so"
test -f "$JNILIBS/arm64-v8a/libytdlp.so"

# Size sanity (reject leftover dummy shell scripts)
MIN=100000
for f in libspotiflac_cli.so libffmpeg.so libytdlp.so; do
  sz=$(wc -c < "$JNILIBS/arm64-v8a/$f")
  if [[ "$sz" -lt "$MIN" ]]; then
    echo "::error::$f looks too small ($sz bytes) — dummy or corrupt" >&2
    exit 1
  fi
done

echo "Android sidecars synced into $JNILIBS"
ls -lh "$JNILIBS/arm64-v8a/"
