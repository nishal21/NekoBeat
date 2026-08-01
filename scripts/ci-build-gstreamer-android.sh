#!/usr/bin/env bash
# Build libgstreamer_android.so with standalone ndk-build, then copy into
# android-gst/libs/<abi>/ so Gradle can use a real PREBUILT_SHARED_LIBRARY.
set -euo pipefail

ROOT="${GSTREAMER_ROOT_ANDROID:-}"
NDK="${ANDROID_NDK_HOME:-${NDK_HOME:-}}"
JNI_DIR="$(cd "$(dirname "$0")/../src-tauri/android-gst/jni" && pwd)"
GST_DIR="$(cd "$JNI_DIR/.." && pwd)"

if [[ -z "$ROOT" || ! -d "$ROOT/arm64" ]]; then
  echo "GSTREAMER_ROOT_ANDROID must point at universal SDK (arm64/)" >&2
  exit 1
fi
if [[ -z "$NDK" || ! -x "$NDK/ndk-build" ]]; then
  echo "ANDROID_NDK_HOME/NDK_HOME must point at an NDK with ndk-build" >&2
  exit 1
fi

# Wipe Windows/CI leftovers — .d files with D:/ paths break Linux make
# ("target pattern contains no '%'").
rm -rf "$GST_DIR/obj" "$GST_DIR/libs" "$JNI_DIR/gst-android-build"
mkdir -p "$GST_DIR/libs/arm64-v8a"

echo "Building GStreamer Android umbrella (arm64-v8a)..."
# Clear sysroot so pkg-config -I paths stay correct
env -u PKG_CONFIG_SYSROOT_DIR -u PKG_CONFIG_PATH \
  PKG_CONFIG_LIBDIR="$ROOT/arm64/lib/pkgconfig" \
  GSTREAMER_ROOT_ANDROID="$ROOT" \
  "$NDK/ndk-build" -C "$GST_DIR" \
    NDK_PROJECT_PATH="$GST_DIR" \
    APP_BUILD_SCRIPT="$JNI_DIR/Android.mk" \
    NDK_APPLICATION_MK="$JNI_DIR/Application.mk" \
    APP_ABI=arm64-v8a \
    APP_PLATFORM=android-24 \
    GSTREAMER_ROOT_ANDROID="$ROOT" \
    -j"$(nproc)" \
    V=1

SO=""
for candidate in \
  "$JNI_DIR/gst-android-build/arm64-v8a/libgstreamer_android.so" \
  "$GST_DIR/libs/arm64-v8a/libgstreamer_android.so" \
  "$GST_DIR/obj/local/arm64-v8a/libgstreamer_android.so"
do
  if [[ -f "$candidate" ]]; then
    SO="$candidate"
    break
  fi
done

if [[ -z "$SO" ]]; then
  echo "ndk-build finished but libgstreamer_android.so was not found. Search:" >&2
  find "$GST_DIR" -name 'libgstreamer_android.so' 2>/dev/null || true
  exit 1
fi

cp -f "$SO" "$GST_DIR/libs/arm64-v8a/libgstreamer_android.so"
# Optional C++ runtime often required alongside umbrella
CXX_CANDIDATES=( "$NDK"/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so )
if [[ -f "${CXX_CANDIDATES[0]:-}" ]]; then
  cp -f "${CXX_CANDIDATES[0]}" "$GST_DIR/libs/arm64-v8a/libc++_shared.so"
fi

# Also drop into gen jniLibs so Tauri/Rust packaging sees it early
JNILIBS="$GST_DIR/../gen/android/app/src/main/jniLibs/arm64-v8a"
mkdir -p "$JNILIBS"
cp -f "$GST_DIR/libs/arm64-v8a/libgstreamer_android.so" "$JNILIBS/"
if [[ -f "$GST_DIR/libs/arm64-v8a/libc++_shared.so" ]]; then
  cp -f "$GST_DIR/libs/arm64-v8a/libc++_shared.so" "$JNILIBS/"
fi

ls -la "$GST_DIR/libs/arm64-v8a/"
echo "GStreamer Android umbrella ready → $GST_DIR/libs/arm64-v8a/libgstreamer_android.so"
