#!/usr/bin/env bash
# Export pkg-config / OpenSSL / SYSTEM_DEPS for Android cross-compile on Linux CI.
# Requires: GSTREAMER_ROOT_ANDROID pointing at universal SDK (arm64/ armv7/ …).
set -euo pipefail

ROOT="${GSTREAMER_ROOT_ANDROID:-}"
if [[ -z "$ROOT" || ! -d "$ROOT/arm64" ]]; then
  echo "GSTREAMER_ROOT_ANDROID must point at extracted universal SDK (with arm64/)" >&2
  exit 1
fi

ARCH_ROOT="$ROOT/arm64"
LIB="$ARCH_ROOT/lib"
INC="$ARCH_ROOT/include"
GLIB_INC="$LIB/glib-2.0/include"
GIO_INC="$LIB/gio-unix-2.0/include"

{
  echo "GSTREAMER_ROOT_ANDROID=$ROOT"
  echo "PKG_CONFIG_ALLOW_CROSS=1"
  echo "PKG_CONFIG_PATH=$LIB/pkgconfig"
  # Do NOT set PKG_CONFIG_SYSROOT_DIR — it breaks GStreamer ndk-build pkg-config
  # (double-prefixed -I → gst/gst.h not found). Rust uses SYSTEM_DEPS_* instead.
  echo "OPENSSL_DIR=$ARCH_ROOT"
  echo "OPENSSL_LIB_DIR=$LIB"
  echo "OPENSSL_INCLUDE_DIR=$INC"
  echo "AARCH64_LINUX_ANDROID_OPENSSL_DIR=$ARCH_ROOT"
  echo "AARCH64_LINUX_ANDROID_OPENSSL_LIB_DIR=$LIB"
  echo "AARCH64_LINUX_ANDROID_OPENSSL_INCLUDE_DIR=$INC"

  set_dep() {
    local meta="$1" libname="$2" includes="$3"
    local key
    key=$(echo "$meta" | tr '[:lower:]' '[:upper:]')
    echo "SYSTEM_DEPS_${key}_NO_PKG_CONFIG=1"
    echo "SYSTEM_DEPS_${key}_LIB=$libname"
    echo "SYSTEM_DEPS_${key}_SEARCH_NATIVE=$LIB"
    echo "SYSTEM_DEPS_${key}_INCLUDE=$includes"
  }

  set_dep "glib_2_0" "glib-2.0" "$INC/glib-2.0:$GLIB_INC"
  set_dep "gobject_2_0" "gobject-2.0" "$INC/glib-2.0:$GLIB_INC"
  set_dep "gio_2_0" "gio-2.0" "$INC/gio-unix-2.0:$INC:$GIO_INC"
  set_dep "gstreamer_1_0" "gstreamer-1.0" "$INC/gstreamer-1.0"
  set_dep "gstreamer_base_1_0" "gstbase-1.0" "$INC/gstreamer-1.0"
  set_dep "gstreamer_audio_1_0" "gstaudio-1.0" "$INC/gstreamer-1.0"
} >> "$GITHUB_ENV"

echo "Android CI env written for $ARCH_ROOT"
