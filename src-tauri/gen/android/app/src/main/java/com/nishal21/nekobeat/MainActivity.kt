package com.nishal21.nekobeat

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.freedesktop.gstreamer.GStreamer
import org.json.JSONObject
import java.io.File

class MainActivity : TauriActivity() {
  private var mediaActionReceiverRegistered = false
  private val mediaActionReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      dispatchPendingMediaActions()
    }
  }

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
    ContextCompat.registerReceiver(
      this,
      mediaActionReceiver,
      IntentFilter(PendingMediaActionStore.BROADCAST_ACTION),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    mediaActionReceiverRegistered = true
    window.decorView.postDelayed({ dispatchPendingMediaActions() }, 250)
  }

  override fun onResume() {
    super.onResume()
    window.decorView.postDelayed({ dispatchPendingMediaActions() }, 100)
  }

  override fun onDestroy() {
    if (mediaActionReceiverRegistered) {
      unregisterReceiver(mediaActionReceiver)
      mediaActionReceiverRegistered = false
    }
    super.onDestroy()
  }

  private fun dispatchPendingMediaActions(attempt: Int = 0) {
    if (!PendingMediaActionStore.hasPending(this)) return
    val webView = findWebView(window.decorView)
    if (webView == null) {
      if (attempt < 10) {
        window.decorView.postDelayed({ dispatchPendingMediaActions(attempt + 1) }, 200)
      }
      return
    }
    val actions = PendingMediaActionStore.takeAll(this)
    if (actions.isEmpty()) return
    webView.post {
      actions.forEach { pending ->
        val detail = JSONObject().apply {
          put("action", pending.action)
          pending.positionMs?.let { put("positionMs", it) }
        }.toString()
        val script = """
          (() => {
            const detail = $detail;
            if (window.__nekobeatNativeMediaReady) {
              window.dispatchEvent(new CustomEvent('nekobeat-native-media-action', { detail }));
            } else {
              (window.__nekobeatNativeMediaQueue ||= []).push(detail);
            }
          })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
      }
    }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebView(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  companion object {
    private const val PERMISSION_REQUEST_CODE = 2401

    private fun permissionEntry(
      context: Context,
      permission: String,
      label: String,
      applicable: Boolean,
    ): JSONObject = JSONObject().apply {
      put("permission", permission)
      put("label", label)
      put("applicable", applicable)
      put(
        "granted",
        !applicable || Build.VERSION.SDK_INT < 23 ||
          ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED,
      )
    }

    @JvmStatic
    fun permissionStatus(context: Context): String {
      val modernAudio = Build.VERSION.SDK_INT >= 33
      return JSONObject().apply {
        put("apiLevel", Build.VERSION.SDK_INT)
        put(
          "audio",
          permissionEntry(
            context,
            if (modernAudio) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE,
            if (modernAudio) "Music and audio" else "Device storage (Android 12 and earlier)",
            true,
          ),
        )
        put(
          "notifications",
          permissionEntry(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
            if (Build.VERSION.SDK_INT >= 33) "Playback notifications" else "Playback notifications (managed by Android)",
            Build.VERSION.SDK_INT >= 33,
          ),
        )
      }.toString()
    }

    @JvmStatic
    fun mediaSessionSupport(context: Context): Boolean {
      return try {
        // androidx.media keeps MediaSessionCompat in its historical support-v4 package.
        Class.forName("android.support.v4.media.session.MediaSessionCompat")
        val component = ComponentName(context, PlaybackService::class.java)
        val service = if (Build.VERSION.SDK_INT >= 33) {
          context.packageManager.getServiceInfo(
            component,
            PackageManager.ComponentInfoFlags.of(0),
          )
        } else {
          @Suppress("DEPRECATION")
          context.packageManager.getServiceInfo(component, 0)
        }
        Build.VERSION.SDK_INT < 29 ||
          service.foregroundServiceType and ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK != 0
      } catch (error: Throwable) {
        android.util.Log.w("NekoBeat", "MediaSession capability check failed", error)
        false
      }
    }

    @JvmStatic
    fun requestPermission(context: Context, kind: String): Boolean {
      val activity = context as? MainActivity ?: return false
      val permission = when (kind) {
        "audio" -> if (Build.VERSION.SDK_INT >= 33) {
          Manifest.permission.READ_MEDIA_AUDIO
        } else {
          Manifest.permission.READ_EXTERNAL_STORAGE
        }
        "notifications" -> {
          if (Build.VERSION.SDK_INT < 33) return true
          Manifest.permission.POST_NOTIFICATIONS
        }
        else -> return false
      }
      if (
        Build.VERSION.SDK_INT < 23 ||
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
      ) {
        return true
      }
      ActivityCompat.requestPermissions(activity, arrayOf(permission), PERMISSION_REQUEST_CODE)
      return true
    }
  }
}
