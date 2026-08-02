package com.nishal21.nekobeat

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Main-process facade for Rust JNI. Never loads `gobackend.Gobackend` /
 * `libgojni` here — all Go work is delegated to [SpotiFlacService] in
 * process `:spotiflac`.
 *
 * Reply Messenger uses a dedicated HandlerThread (never MainLooper) so
 * blocking RPC cannot ANR/deadlock the UI when Settings opens.
 */
object SpotiFlacClient {
  private const val TAG = "SpotiFlacClient"
  private const val BIND_TIMEOUT_MS = 15_000L
  private const val DEFAULT_RPC_TIMEOUT_MS = 30_000L
  private const val DOWNLOAD_TIMEOUT_MS = 300_000L

  private val serviceMessenger = AtomicReference<Messenger?>(null)
  private val bindLock = Any()
  @Volatile private var connection: ServiceConnection? = null
  @Volatile private var lastError: String? = null

  private val replyThread: HandlerThread by lazy {
    HandlerThread("SpotiFlacClientReply", Process.THREAD_PRIORITY_DEFAULT).also { it.start() }
  }
  private val replyLooper: Looper
    get() = replyThread.looper

  @JvmStatic
  fun isAvailable(): Boolean {
    return try {
      BuildConfig.HAS_GOBACKEND
    } catch (_: Throwable) {
      false
    }
  }

  @JvmStatic
  fun lastError(): String = lastError ?: ""

  /**
   * Lightweight status for Settings — **never** binds the Go worker.
   * Binding/loading libgojni on Settings open was crashing / ANRing the UI.
   */
  @JvmStatic
  fun getStatus(filesDirPath: String): String {
    // filesDir unused — local probe only (do not start :spotiflac).
    if (filesDirPath.isEmpty()) {
      // no-op keep param for JNI signature stability
    }
    val packaged = isAvailable()
    val err = lastError
    val errJson = if (err.isNullOrBlank()) "null" else jsonString(err)
    return """{"ok":true,"available":$packaged,"packaged":$packaged,"ready":false,"bootstrapped":false,"process":"none","platform":"android","probe":"local","lastError":$errJson}"""
  }

  /** Deep probe (binds `:spotiflac`) — only from explicit Retry / HiFi download. */
  @JvmStatic
  fun getStatusDeep(filesDirPath: String): String {
    val packaged = isAvailable()
    if (!packaged) {
      return """{"ok":true,"available":false,"packaged":false,"process":"none","platform":"android","lastError":"AAR not packaged"}"""
    }
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_FILES_DIR, filesDirPath)
    }
    return try {
      callRemote(SpotiFlacService.MSG_STATUS, b, DEFAULT_RPC_TIMEOUT_MS)
    } catch (t: Throwable) {
      lastError = t.message
      """{"ok":false,"available":true,"packaged":true,"process":"spotiflac","error":${jsonString(t.message ?: t.toString())},"lastError":${jsonString(lastError ?: "")}}"""
    }
  }

  @JvmStatic
  fun ensureInitialized(filesDirPath: String): String {
    if (!isAvailable()) {
      return """{"ok":false,"error":"gobackend.aar not packaged (HAS_GOBACKEND=false)"}"""
    }
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_FILES_DIR, filesDirPath)
    }
    return callRemote(SpotiFlacService.MSG_ENSURE_INIT, b, DEFAULT_RPC_TIMEOUT_MS)
  }

  @JvmStatic
  fun bootstrapDefaultExtensions(filesDirPath: String): String {
    if (!isAvailable()) {
      return """{"ok":false,"error":"gobackend.aar not packaged"}"""
    }
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_FILES_DIR, filesDirPath)
    }
    return callRemote(SpotiFlacService.MSG_BOOTSTRAP, b, DOWNLOAD_TIMEOUT_MS)
  }

  @JvmStatic
  fun downloadByStrategy(requestJson: String): String {
    if (!isAvailable()) {
      return """{"success":false,"error":"gobackend.aar not packaged"}"""
    }
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_REQUEST_JSON, requestJson)
    }
    return callRemote(SpotiFlacService.MSG_DOWNLOAD, b, DOWNLOAD_TIMEOUT_MS)
  }

  @JvmStatic
  fun getProgress(): String {
    if (!isAvailable()) return "{}"
    return callRemote(SpotiFlacService.MSG_PROGRESS, Bundle(), DEFAULT_RPC_TIMEOUT_MS)
  }

  @JvmStatic
  fun cancelDownload(itemId: String) {
    if (!isAvailable()) return
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_ITEM_ID, itemId)
    }
    callRemote(SpotiFlacService.MSG_CANCEL, b, DEFAULT_RPC_TIMEOUT_MS)
  }

  @JvmStatic
  fun installExtensionById(filesDirPath: String, extensionId: String): String {
    if (!isAvailable()) {
      return """{"ok":false,"error":"gobackend.aar not packaged"}"""
    }
    val b = Bundle().apply {
      putString(SpotiFlacService.KEY_FILES_DIR, filesDirPath)
      putString(SpotiFlacService.KEY_EXTENSION_ID, extensionId)
    }
    return callRemote(SpotiFlacService.MSG_INSTALL_EXT, b, DOWNLOAD_TIMEOUT_MS)
  }

  private fun callRemote(what: Int, data: Bundle, timeoutMs: Long): String {
    return try {
      ensureBound()
      val messenger = serviceMessenger.get()
        ?: return """{"ok":false,"success":false,"error":"service not bound"}"""

      val latch = CountDownLatch(1)
      val resultBox = AtomicReference("""{"ok":false,"error":"timeout"}""")
      // Dedicated looper — NEVER MainLooper (Settings invoke + await = ANR/deadlock).
      val replyHandler = object : Handler(replyLooper) {
        override fun handleMessage(msg: Message) {
          resultBox.set(msg.data?.getString(SpotiFlacService.KEY_RESULT) ?: "{}")
          latch.countDown()
        }
      }
      val msg = Message.obtain(null, what)
      msg.data = data
      msg.replyTo = Messenger(replyHandler)
      messenger.send(msg)
      if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
        lastError = "RPC timeout what=$what after ${timeoutMs}ms"
        return """{"ok":false,"success":false,"error":${jsonString(lastError!!)}}"""
      }
      lastError = null
      resultBox.get()
    } catch (t: Throwable) {
      lastError = t.message ?: t.toString()
      Log.e(TAG, "callRemote what=$what failed", t)
      serviceMessenger.set(null)
      """{"ok":false,"success":false,"error":${jsonString(lastError!!)}}"""
    }
  }

  private fun ensureBound() {
    if (serviceMessenger.get() != null) return
    synchronized(bindLock) {
      if (serviceMessenger.get() != null) return
      val ctx = appContext()
      val intent = Intent(ctx, SpotiFlacService::class.java)
      try {
        ctx.startService(intent)
      } catch (t: Throwable) {
        Log.w(TAG, "startService failed (bind may still work)", t)
      }
      val latch = CountDownLatch(1)
      val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
          serviceMessenger.set(Messenger(binder))
          latch.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
          Log.w(TAG, "SpotiFlacService disconnected (worker process died?)")
          serviceMessenger.set(null)
        }

        override fun onBindingDied(name: ComponentName?) {
          Log.w(TAG, "SpotiFlacService binding died")
          serviceMessenger.set(null)
        }
      }
      connection = conn
      val ok = ctx.bindService(intent, conn, Context.BIND_AUTO_CREATE)
      if (!ok) {
        throw IllegalStateException("bindService(SpotiFlacService) returned false")
      }
      if (!latch.await(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
        throw IllegalStateException("SpotiFlacService bind timeout (${BIND_TIMEOUT_MS}ms)")
      }
      Log.i(TAG, "bound to SpotiFlacService (:spotiflac)")
    }
  }

  private fun appContext(): Context {
    val at = Class.forName("android.app.ActivityThread")
    val app = at.getMethod("currentApplication").invoke(null) as? Context
      ?: throw IllegalStateException("ActivityThread.currentApplication() is null")
    return app.applicationContext
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
