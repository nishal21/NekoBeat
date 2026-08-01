#!/usr/bin/env bash
# Build SpotiFLAC CLI for Android (arm64 required; arm/x86 best-effort).
# Clones SpotiFLAC if needed and overlays NekoBeat cli.go.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/src-tauri/binaries}"
CLI_OVERLAY="$ROOT/scripts/spotiflac/cli.go"
SRC="${SPOTIFLAC_SRC:-}"

if [[ -z "$SRC" ]]; then
  if [[ -f "$ROOT/../SpotiFLAC-upstream/cli.go" ]]; then
    SRC="$(cd "$ROOT/../SpotiFLAC-upstream" && pwd)"
  else
    SRC="$ROOT/vendor/SpotiFLAC"
    if [[ ! -f "$SRC/go.mod" ]]; then
      echo "Cloning SpotiFLAC into $SRC ..."
      git clone --depth 1 https://github.com/afkarxyz/SpotiFLAC.git "$SRC"
    fi
  fi
fi

if [[ ! -f "$SRC/go.mod" ]]; then
  echo "Missing SpotiFLAC at $SRC" >&2
  exit 1
fi

if [[ -f "$CLI_OVERLAY" ]]; then
  cp -f "$CLI_OVERLAY" "$SRC/cli.go"
  echo "Overlayed NekoBeat cli.go"
fi

# Android: treat like linux arm64 for ffmpeg auto-download fallback
FFMPEG_GO="$SRC/backend/ffmpeg.go"
if [[ -f "$FFMPEG_GO" ]] && ! grep -q 'case "android"' "$FFMPEG_GO"; then
  python3 -c "
from pathlib import Path
p = Path(r'''$FFMPEG_GO''')
t = p.read_text(encoding='utf-8')
needle = '\tdefault:\n\t\treturn nil, nil, fmt.Errorf(\"unsupported operating system: %s\", runtime.GOOS)\n\t}\n}'
insert = '''\tcase \"android\":
\t\tswitch runtime.GOARCH {
\t\tcase \"arm64\", \"arm\":
\t\t\treturn []string{buildFFmpegReleaseURL(\"ffmpeg-linux-arm64v8.zip\")}, []string{buildFFmpegReleaseURL(\"ffprobe-linux-arm64v8.zip\")}, nil
\t\tdefault:
\t\t\treturn []string{buildFFmpegReleaseURL(\"ffmpeg-linux-arm64v8.zip\")}, []string{buildFFmpegReleaseURL(\"ffprobe-linux-arm64v8.zip\")}, nil
\t\t}
''' + needle
if needle in t:
    p.write_text(t.replace(needle, insert, 1), encoding='utf-8')
    print('Patched getFFmpegDownloadURLs for android')
else:
    print('ffmpeg.go android patch skipped')
"
fi

mkdir -p "$OUT_DIR"
cd "$SRC"
go mod download

build_one() {
  local goos="$1" goarch="$2" suffix="$3"
  local out="$OUT_DIR/spotiflac-cli-${suffix}"
  echo "Building $out ..."
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags="-s -w" -o "$out" cli.go
  chmod +x "$out" 2>/dev/null || true
  ls -lh "$out"
}

build_one android arm64 "aarch64-linux-android"
build_one android arm "armv7-linux-androideabi" || echo "warn: armv7 build failed"
build_one android amd64 "x86_64-linux-android" || echo "warn: x86_64 android build failed"
build_one android 386 "i686-linux-android" || echo "warn: i686 android build failed"

echo "Done. Android sidecars in $OUT_DIR"
