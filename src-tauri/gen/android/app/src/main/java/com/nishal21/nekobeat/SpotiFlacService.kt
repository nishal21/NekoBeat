package com.nishal21.nekobeat

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log

/**
 * Runs in process `:spotiflac` so gomobile `libgojni` cannot SIGSEGV the
 * main Tauri/GStreamer process. All [SpotiFlacMobile] / Gobackend calls
 * happen only on this process.
 */
class SpotiFlacService : Service() {
  companion object {
    private const val TAG = "SpotiFlacService"

    const val MSG_IS_AVAILABLE = 1
    const val MSG_ENSURE_INIT = 2
    const val MSG_BOOTSTRAP = 3
    const val MSG_DOWNLOAD = 4
    const val MSG_PROGRESS = 5
    const val MSG_CANCEL = 6
    const val MSG_INSTALL_EXT = 7
    const val MSG_STATUS = 8

    const val KEY_RESULT = "result"
    const val KEY_FILES_DIR = "filesDir"
    const val KEY_REQUEST_JSON = "requestJson"
    const val KEY_ITEM_ID = "itemId"
    const val KEY_EXTENSION_ID = "extensionId"
  }

  private lateinit var workerThread: HandlerThread
  private lateinit var workerHandler: Handler
  private lateinit var messenger: Messenger

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate pid=${Process.myPid()} (isolated SpotiFLAC worker)")
    workerThread = HandlerThread("SpotiFlacWorker", Process.THREAD_PRIORITY_BACKGROUND)
    workerThread.start()
    workerHandler = IncomingHandler(workerThread.looper)
    messenger = Messenger(workerHandler)
  }

  override fun onBind(intent: Intent?): IBinder {
    return messenger.binder
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    return START_STICKY
  }

  override fun onDestroy() {
    workerThread.quitSafely()
    super.onDestroy()
  }

  private fun reply(replyTo: Messenger?, result: String) {
    if (replyTo == null) return
    try {
      val msg = Message.obtain(null, 0)
      msg.data = Bundle().apply { putString(KEY_RESULT, result) }
      replyTo.send(msg)
    } catch (t: Throwable) {
      Log.w(TAG, "reply failed", t)
    }
  }

  private inner class IncomingHandler(looper: Looper) : Handler(looper) {
    override fun handleMessage(msg: Message) {
      val replyTo = msg.replyTo
      val data = msg.data ?: Bundle.EMPTY
      try {
        when (msg.what) {
          MSG_IS_AVAILABLE -> {
            val ok = SpotiFlacMobile.isAvailable()
            reply(replyTo, """{"ok":true,"available":$ok}""")
          }
          MSG_ENSURE_INIT -> {
            val filesDir = data.getString(KEY_FILES_DIR) ?: ""
            reply(replyTo, SpotiFlacMobile.ensureInitialized(filesDir))
          }
          MSG_BOOTSTRAP -> {
            val filesDir = data.getString(KEY_FILES_DIR) ?: ""
            reply(replyTo, SpotiFlacMobile.bootstrapDefaultExtensions(filesDir))
          }
          MSG_DOWNLOAD -> {
            val req = data.getString(KEY_REQUEST_JSON) ?: "{}"
            reply(replyTo, SpotiFlacMobile.downloadByStrategy(req))
          }
          MSG_PROGRESS -> {
            reply(replyTo, SpotiFlacMobile.getProgress())
          }
          MSG_CANCEL -> {
            val id = data.getString(KEY_ITEM_ID) ?: ""
            SpotiFlacMobile.cancelDownload(id)
            reply(replyTo, """{"ok":true}""")
          }
          MSG_INSTALL_EXT -> {
            val filesDir = data.getString(KEY_FILES_DIR) ?: ""
            val extId = data.getString(KEY_EXTENSION_ID) ?: ""
            reply(replyTo, SpotiFlacMobile.installExtensionById(filesDir, extId))
          }
          MSG_STATUS -> {
            val filesDir = data.getString(KEY_FILES_DIR) ?: ""
            reply(replyTo, SpotiFlacMobile.statusJson(filesDir))
          }
          else -> {
            reply(replyTo, """{"ok":false,"error":"unknown msg ${msg.what}"}""")
          }
        }
      } catch (t: Throwable) {
        Log.e(TAG, "handleMessage ${msg.what} failed", t)
        reply(
          replyTo,
          """{"ok":false,"success":false,"error":${jsonString(t.message ?: t.toString())}}""",
        )
      }
    }
  }

  private fun jsonString(s: String): String {
    val escaped = s
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
    return "\"$escaped\""
  }
}
