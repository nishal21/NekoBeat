package com.nishal21.nekobeat

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import org.freedesktop.gstreamer.GStreamer

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    try {
      GStreamer.init(this)
    } catch (e: Exception) {
      android.util.Log.e("NekoBeat", "GStreamer.init failed", e)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
