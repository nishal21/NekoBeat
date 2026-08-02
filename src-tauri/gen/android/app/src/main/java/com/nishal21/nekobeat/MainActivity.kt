package com.nishal21.nekobeat

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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
    requestMediaPermission()
    try {
      GStreamer.init(this)
    } catch (e: Exception) {
      android.util.Log.e("NekoBeat", "GStreamer.init failed", e)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  private fun requestMediaPermission() {
    val needed = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 33) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO)
        != PackageManager.PERMISSION_GRANTED
      ) {
        needed.add(Manifest.permission.READ_MEDIA_AUDIO)
      }
    } else {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
        != PackageManager.PERMISSION_GRANTED
      ) {
        needed.add(Manifest.permission.READ_EXTERNAL_STORAGE)
      }
    }
    if (needed.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, needed.toTypedArray(), 2401)
    }
  }
}
