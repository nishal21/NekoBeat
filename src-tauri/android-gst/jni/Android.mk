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

# Rust/CI often export PKG_CONFIG_SYSROOT_DIR. Cerbero's ndk-build pkg-config then
# double-prefixes -I paths, so clang cannot find <gst/gst.h> even though the SDK
# headers exist. Clear it for this make process.
unexport PKG_CONFIG_SYSROOT_DIR
unexport PKG_CONFIG_PATH
export PKG_CONFIG_LIBDIR := $(GSTREAMER_ROOT)/lib/pkgconfig

GSTREAMER_NDK_BUILD_PATH := $(GSTREAMER_ROOT)/share/gst-android/ndk-build
include $(GSTREAMER_NDK_BUILD_PATH)/plugins.mk

# NekoBeat: minimal plugin set (keeps Windows ndk-build sed under cmd line limits)
GSTREAMER_PLUGINS := \
  coreelements playback audioconvert audioresample volume typefindfunctions \
  opensles soup hls equalizer \
  ogg vorbis opus flac mpg123 isomp4 matroska icydemux id3demux tcp udp

G_IO_MODULES := openssl
GSTREAMER_EXTRA_DEPS := gstreamer-audio-1.0

include $(GSTREAMER_NDK_BUILD_PATH)/gstreamer-1.0.mk

# If pkg-config still returned nothing, force the includes cerbero expects.
ifeq ($(strip $(GSTREAMER_ANDROID_CFLAGS)),-I$(GSTREAMER_ROOT)/include)
  GSTREAMER_ANDROID_CFLAGS := \
    -I$(GSTREAMER_ROOT)/include/gstreamer-1.0 \
    -I$(GSTREAMER_ROOT)/include/glib-2.0 \
    -I$(GSTREAMER_ROOT)/lib/glib-2.0/include \
    -I$(GSTREAMER_ROOT)/include
endif
# Always ensure gstreamer-1.0 is on the include path (gst/gst.h lives there)
GSTREAMER_ANDROID_CFLAGS += -I$(GSTREAMER_ROOT)/include/gstreamer-1.0 -I$(GSTREAMER_ROOT)/include/glib-2.0 -I$(GSTREAMER_ROOT)/lib/glib-2.0/include

# Re-bind compile command after CFLAGS fix (gstreamer-1.0.mk sets PRIV_CC_CMD with :=)
$(GSTREAMER_ANDROID_O): PRIV_CC_CMD := $(TARGET_CC) --sysroot=$(SYSROOT_GST_INC) $(SYSROOT_ARCH_INC_ARG) $(GLOBAL_CFLAGS) $(TARGET_CFLAGS) \
	-c $(GSTREAMER_ANDROID_C) -Wall -Werror -o $(GSTREAMER_ANDROID_O) $(GSTREAMER_ANDROID_CFLAGS)

# Link stub against gstreamer_android (ensures .so is packaged)
include $(CLEAR_VARS)
LOCAL_MODULE := nekobeat_gst
LOCAL_SRC_FILES := dummy.c
LOCAL_SHARED_LIBRARIES := gstreamer_android
LOCAL_LDLIBS := -llog -landroid
include $(BUILD_SHARED_LIBRARY)
