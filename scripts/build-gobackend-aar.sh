#!/usr/bin/env bash
# Build SpotiFLAC-Mobile go_backend → gobackend.aar (gomobile) for NekoBeat Android.
# Requires: Go >= 1.26.5 (see vendor go.mod), ANDROID_NDK_HOME, CGO_ENABLED=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GO_SRC="${SPOTIFLAC_MOBILE_GO:-$ROOT/vendor/SpotiFLAC-Mobile-go/go_backend}"
OUT_DIR="$ROOT/src-tauri/gen/android/app/libs"
OUT_AAR="$OUT_DIR/gobackend.aar"

if [[ ! -f "$GO_SRC/go.mod" ]]; then
  echo "::error::Missing vendored go_backend at $GO_SRC"
  exit 1
fi

if [[ -z "${ANDROID_NDK_HOME:-}${NDK_HOME:-}" ]]; then
  echo "::error::Set ANDROID_NDK_HOME (or NDK_HOME) to the Android NDK"
  exit 1
fi
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"
export CGO_ENABLED=1

echo "SpotiFLAC Mobile AAR: building from $GO_SRC"
cd "$GO_SRC"
go mod download
# Use the x/mobile version pinned by go.mod (do not use @latest).
go install golang.org/x/mobile/cmd/gomobile
go install golang.org/x/mobile/cmd/gobind
export PATH="$(go env GOPATH)/bin:$PATH"
gomobile init

mkdir -p "$OUT_DIR"
# arm64 is what NekoBeat ships (abiFilters arm64-v8a); include arm for completeness.
gomobile bind \
  -target=android/arm,android/arm64 \
  -androidapi 24 \
  -o "$OUT_AAR" \
  .

test -f "$OUT_AAR"
echo "SpotiFLAC Mobile AAR: wrote $OUT_AAR ($(du -h "$OUT_AAR" | cut -f1))"
