LOCAL_PATH := $(call my-dir)

ifndef GSTREAMER_ROOT_ANDROID
$(error GSTREAMER_ROOT_ANDROID is not defined! Set env var or Gradle ndkBuild.arguments)
endif

ifeq ($(TARGET_ARCH_ABI),arm64-v8a)
  GSTREAMER_ROOT := $(GSTREAMER_ROOT_ANDROID)/arm64
else ifeq ($(TARGET_ARCH_ABI),armeabi-v7a)
  GSTREAMER_ROOT := $(GSTREAMER_ROOT_ANDROID)/armv7
else ifeq ($(TARGET_ARCH_ABI),x86)
  GSTREAMER_ROOT := $(GSTREAMER_ROOT_ANDROID)/x86
else ifeq ($(TARGET_ARCH_ABI),x86_64)
  GSTREAMER_ROOT := $(GSTREAMER_ROOT_ANDROID)/x86_64
else
  $(error Unsupported TARGET_ARCH_ABI: $(TARGET_ARCH_ABI))
endif

# Marker written by scripts/ci-build-gstreamer-android.sh after the umbrella is copied
# into gen/.../jniLibs. Real .so must NOT stay under android-gst/libs or AGP merges
# them twice (with Tauri's jniLibs copy) → Duplicate resources.
GST_PREBUILT_MARKER := $(LOCAL_PATH)/../libs/$(TARGET_ARCH_ABI)/.use_prebuilt_gst

ifneq ($(wildcard $(GST_PREBUILT_MARKER)),)

include $(CLEAR_VARS)
LOCAL_MODULE := nekobeat_gst
LOCAL_SRC_FILES := dummy.c
LOCAL_LDLIBS := -llog -landroid
include $(BUILD_SHARED_LIBRARY)

else

# Standalone ndk-build (scripts/ci-build-gstreamer-android.sh) — full Cerbero umbrella
unexport PKG_CONFIG_SYSROOT_DIR
unexport PKG_CONFIG_PATH
export PKG_CONFIG_LIBDIR := $(GSTREAMER_ROOT)/lib/pkgconfig

GSTREAMER_NDK_BUILD_PATH := $(GSTREAMER_ROOT)/share/gst-android/ndk-build
include $(GSTREAMER_NDK_BUILD_PATH)/plugins.mk

GSTREAMER_PLUGINS := \
  coreelements playback audioconvert audioresample volume typefindfunctions \
  opensles soup hls equalizer \
  ogg vorbis opus flac mpg123 isomp4 matroska icydemux id3demux tcp udp

G_IO_MODULES := openssl
GSTREAMER_EXTRA_DEPS := gstreamer-audio-1.0

include $(GSTREAMER_NDK_BUILD_PATH)/gstreamer-1.0.mk

GSTREAMER_ANDROID_CFLAGS += \
  -I$(GSTREAMER_ROOT)/include/gstreamer-1.0 \
  -I$(GSTREAMER_ROOT)/include/glib-2.0 \
  -I$(GSTREAMER_ROOT)/lib/glib-2.0/include

$(GSTREAMER_ANDROID_O): PRIV_CC_CMD := $(TARGET_CC) --sysroot=$(SYSROOT_GST_INC) $(SYSROOT_ARCH_INC_ARG) $(GLOBAL_CFLAGS) $(TARGET_CFLAGS) \
	-c $(GSTREAMER_ANDROID_C) -Wall -Werror -o $(GSTREAMER_ANDROID_O) $(GSTREAMER_ANDROID_CFLAGS)

include $(CLEAR_VARS)
LOCAL_MODULE := nekobeat_gst
LOCAL_SRC_FILES := dummy.c
LOCAL_SHARED_LIBRARIES := gstreamer_android
LOCAL_LDLIBS := -llog -landroid
include $(BUILD_SHARED_LIBRARY)

endif
