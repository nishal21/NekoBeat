#!/usr/bin/env bash
set -euo pipefail

apk="${1:-}"
if [[ -z "$apk" || ! -f "$apk" ]]; then
  echo "usage: $0 path/to/app.apk" >&2
  exit 2
fi

entries="$(unzip -Z1 "$apk")"
for forbidden in \
  libgstreamer_android \
  '/libgst' \
  yt-dlp \
  spotiflac \
  gobackend
do
  if [[ "$entries" == *"$forbidden"* ]]; then
    echo "forbidden Android payload remains in APK: $forbidden" >&2
    exit 1
  fi
done

if [[ "$entries" != *"lib/arm64-v8a/"* ]]; then
  echo "APK does not contain the required arm64-v8a native payload" >&2
  exit 1
fi

bytes="$(wc -c < "$apk" | tr -d ' ')"
mebibytes="$((bytes / 1024 / 1024))"
echo "Media3 APK payload check passed (${mebibytes} MiB; no GStreamer/Go/online sidecars)."
