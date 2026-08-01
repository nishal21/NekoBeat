APP_ABI := arm64-v8a
APP_PLATFORM := android-24
# Help ndk-build find GStreamer headers when building gstreamer_android.c
APP_CFLAGS := -I$(GSTREAMER_ROOT_ANDROID)/arm64/include -I$(GSTREAMER_ROOT_ANDROID)/arm64/include/gstreamer-1.0 -I$(GSTREAMER_ROOT_ANDROID)/arm64/include/glib-2.0 -I$(GSTREAMER_ROOT_ANDROID)/arm64/lib/glib-2.0/include
APP_CPPFLAGS := $(APP_CFLAGS)
