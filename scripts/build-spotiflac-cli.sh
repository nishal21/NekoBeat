#!/usr/bin/env bash
# Build SpotiFLAC go_backend CLI into src-tauri/bin/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/src-tauri/sidecars/spotiflac-cli"
export GOTOOLCHAIN=auto
go build -o "$ROOT/src-tauri/bin/spotiflac-cli.exe" .
echo "built $ROOT/src-tauri/bin/spotiflac-cli.exe"
