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

GST_PREBUILT_SO := $(LOCAL_PATH)/../libs/$(TARGET_ARCH_ABI)/libgstreamer_android.so

# Prefer a real PREBUILT for Android Gradle Plugin (AGP checks the .so exists).
# CI builds the umbrella .so first via scripts/ci-build-gstreamer-android.sh.
ifneq ($(wildcard $(GST_PREBUILT_SO)),)

include $(CLEAR_VARS)
LOCAL_MODULE := gstreamer_android
LOCAL_SRC_FILES := ../libs/$(TARGET_ARCH_ABI)/libgstreamer_android.so
LOCAL_EXPORT_C_INCLUDES := \
  $(GSTREAMER_ROOT)/include \
  $(GSTREAMER_ROOT)/include/gstreamer-1.0 \
  $(GSTREAMER_ROOT)/include/glib-2.0 \
  $(GSTREAMER_ROOT)/lib/glib-2.0/include
include $(PREBUILT_SHARED_LIBRARY)

# Optional C++ runtime (copied by ci-build-gstreamer-android.sh)
ifneq ($(wildcard $(LOCAL_PATH)/../libs/$(TARGET_ARCH_ABI)/libc++_shared.so),)
include $(CLEAR_VARS)
LOCAL_MODULE := c++_shared
LOCAL_SRC_FILES := ../libs/$(TARGET_ARCH_ABI)/libc++_shared.so
include $(PREBUILT_SHARED_LIBRARY)
endif

include $(CLEAR_VARS)
LOCAL_MODULE := nekobeat_gst
LOCAL_SRC_FILES := dummy.c
LOCAL_SHARED_LIBRARIES := gstreamer_android
LOCAL_LDLIBS := -llog -landroid
include $(BUILD_SHARED_LIBRARY)

else

# Standalone ndk-build path (no libs/ yet) — full Cerbero umbrella build
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
