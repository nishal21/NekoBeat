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

GSTREAMER_NDK_BUILD_PATH := $(GSTREAMER_ROOT)/share/gst-android/ndk-build/
include $(GSTREAMER_NDK_BUILD_PATH)/plugins.mk

# NekoBeat: minimal plugin set (keeps Windows ndk-build sed under cmd line limits)
GSTREAMER_PLUGINS := \
  coreelements playback audioconvert audioresample volume typefindfunctions \
  opensles soup hls equalizer \
  ogg vorbis opus flac mpg123 isomp4 matroska icydemux id3demux tcp udp

G_IO_MODULES := openssl
GSTREAMER_EXTRA_DEPS := gstreamer-audio-1.0

include $(GSTREAMER_NDK_BUILD_PATH)/gstreamer-1.0.mk

# Link stub against gstreamer_android (ensures .so is packaged)
include $(CLEAR_VARS)
LOCAL_MODULE := nekobeat_gst
LOCAL_SRC_FILES := dummy.c
LOCAL_SHARED_LIBRARIES := gstreamer_android
LOCAL_LDLIBS := -llog -landroid
include $(BUILD_SHARED_LIBRARY)
