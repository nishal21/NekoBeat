#!/usr/bin/env bash
# Sync brand launcher icons from src-tauri/icons/android → gen Android res.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src-tauri/icons/android"
DST="$ROOT/src-tauri/gen/android/app/src/main/res"

test -d "$SRC/mipmap-xxxhdpi"
mkdir -p "$DST"

for dens in mipmap-mdpi mipmap-hdpi mipmap-xhdpi mipmap-xxhdpi mipmap-xxxhdpi; do
  mkdir -p "$DST/$dens"
  cp -f "$SRC/$dens/"*.png "$DST/$dens/"
done

mkdir -p "$DST/mipmap-anydpi-v26"
cp -f "$SRC/mipmap-anydpi-v26/ic_launcher.xml" "$DST/mipmap-anydpi-v26/ic_launcher.xml"
cp -f "$SRC/mipmap-anydpi-v26/ic_launcher.xml" "$DST/mipmap-anydpi-v26/ic_launcher_round.xml"

# Brand adaptive-icon background
if ! grep -q 'ic_launcher_background' "$DST/values/colors.xml" 2>/dev/null; then
  # Insert before closing </resources>
  sed -i 's|</resources>|    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>|' "$DST/values/colors.xml"
fi

# Drop default Tauri vector placeholders
rm -f "$DST/drawable/ic_launcher_background.xml"
rm -f "$DST/drawable-v24/ic_launcher_foreground.xml"

echo "Synced Android launcher icons from icons/android → gen res"
