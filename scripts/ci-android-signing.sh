#!/usr/bin/env bash
# Prepare Android release signing for CI/local.
# Prefers GitHub secrets; otherwise generates an ephemeral sideload keystore.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/src-tauri/gen/android"
APP_DIR="$ANDROID_DIR/app"
KS_NAME="upload-keystore.jks"
KS_PATH="$APP_DIR/$KS_NAME"
PROPS="$ANDROID_DIR/keystore.properties"

mkdir -p "$APP_DIR"

if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  echo "Using ANDROID_KEYSTORE_BASE64 secret"
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KS_PATH"
  PASS="${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD required with keystore secret}"
  ALIAS="${ANDROID_KEY_ALIAS:-upload}"
  KEYPASS="${ANDROID_KEY_PASSWORD:-$PASS}"
  cat > "$PROPS" <<EOF
password=$PASS
keyPassword=$KEYPASS
keyAlias=$ALIAS
storeFile=$KS_NAME
EOF
else
  echo "No ANDROID_KEYSTORE_BASE64 — generating ephemeral sideload keystore"
  PASS="nekobeat-ci"
  ALIAS="upload"
  rm -f "$KS_PATH"
  keytool -genkeypair -v -storetype PKCS12 \
    -keystore "$KS_PATH" \
    -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=NekoBeat CI, OU=CI, O=NekoBeat, L=NA, ST=NA, C=US"
  cat > "$PROPS" <<EOF
password=$PASS
keyPassword=$PASS
keyAlias=$ALIAS
storeFile=$KS_NAME
EOF
  echo "::warning::Ephemeral keystore: uninstall previous NekoBeat before installing a new CI APK (signature changes each run). Set ANDROID_KEYSTORE_* secrets for a stable key."
fi

test -f "$KS_PATH"
test -f "$PROPS"
echo "Android signing ready → $PROPS (storeFile=$KS_NAME)"
