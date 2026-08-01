package com.nishal21.nekobeat

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import org.freedesktop.gstreamer.GStreamer
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    try {
      // Tell Rust where jniLibs were extracted (libspotiflac_cli.so, libytdlp.so, …)
      val bin = File(filesDir, "bin")
      if (!bin.exists()) bin.mkdirs()
      File(bin, ".native_lib_dir").writeText(applicationInfo.nativeLibraryDir)
    } catch (e: Exception) {
      android.util.Log.w("NekoBeat", "Failed to write native lib dir marker", e)
    }
    try {
      GStreamer.init(this)
    } catch (e: Exception) {
      android.util.Log.e("NekoBeat", "GStreamer.init failed", e)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
