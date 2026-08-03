package com.nishal21.nekobeat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.app.ServiceCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class PendingMediaAction(val action: String, val positionMs: Long?)

/**
 * Persistent mailbox used by native media controls. MainActivity drains it into the WebView when
 * one is available, including after Android has recreated the activity.
 */
object PendingMediaActionStore {
  const val BROADCAST_ACTION = "com.nishal21.nekobeat.NATIVE_MEDIA_ACTION"
  private const val PREFS = "nekobeat_native_media"
  private const val KEY_ACTIONS = "pending_actions"
  private val lock = Any()

  fun enqueue(context: Context, action: String, positionMs: Long? = null) {
    synchronized(lock) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val actions = try {
        JSONArray(prefs.getString(KEY_ACTIONS, "[]") ?: "[]")
      } catch (_: Exception) {
        JSONArray()
      }
      actions.put(JSONObject().apply {
        put("action", action)
        if (positionMs != null) put("positionMs", positionMs)
      })
      while (actions.length() > 32) actions.remove(0)
      prefs.edit().putString(KEY_ACTIONS, actions.toString()).apply()
    }
  }

  fun takeAll(context: Context): List<PendingMediaAction> = synchronized(lock) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val actions = try {
      JSONArray(prefs.getString(KEY_ACTIONS, "[]") ?: "[]")
    } catch (_: Exception) {
      JSONArray()
    }
    val result = ArrayList<PendingMediaAction>(actions.length())
    for (index in 0 until actions.length()) {
      val item = actions.optJSONObject(index) ?: continue
      val action = item.optString("action")
      if (action.isBlank()) continue
      result.add(
        PendingMediaAction(
          action,
          if (item.has("positionMs")) item.optLong("positionMs") else null,
        ),
      )
    }
    prefs.edit().remove(KEY_ACTIONS).apply()
    result
  }

  fun hasPending(context: Context): Boolean = synchronized(lock) {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(KEY_ACTIONS, "[]") ?: "[]"
    try {
      JSONArray(raw).length() > 0
    } catch (_: Exception) {
      false
    }
  }
}

private data class NativeMetadata(
  val title: String = "NekoBeat",
  val artist: String = "",
  val album: String = "",
  val artworkUrl: String = "",
  val durationMs: Long = 0,
)

/**
 * Android playback owner. ExoPlayer + MediaSession.
 *
 * Critical: [startForegroundService] requires [startForeground] within a few seconds.
 * ExoPlayer/FFmpeg init can exceed that window, so we promote to foreground immediately
 * in [onCreate] before building the player.
 */
@UnstableApi
class PlaybackService : MediaSessionService() {
  companion object {
    private const val TAG = "NekoBeatMedia3"
    private const val ACTION_PLAY = "com.nishal21.nekobeat.playback.PLAY"
    private const val EXTRA_SOURCE = "source"
    private const val FG_CHANNEL = "com.nishal21.nekobeat.playback"
    /** Same id Media3 uses by default so the placeholder is replaced, not duplicated. */
    private const val FG_NOTIFICATION_ID = 1001
    private const val LYRICS_TICK_MS = 350L

    @Volatile private var activeService: PlaybackService? = null
    @Volatile private var pendingMetadata = NativeMetadata()
    @Volatile private var latestError = ""
    @Volatile private var pendingSource: String? = null
    @Volatile private var endedDispatchedForItem = false

    @JvmStatic
    fun play(context: Context, source: String): String {
      val normalized = normalizeSource(source)
        ?: return "Android Media3 accepts only absolute file:// paths and content:// URIs"
      latestError = ""
      val service = activeService
      if (service != null) {
        pendingSource = null
        service.postToPlayer { it.playSource(normalized) }
        return ""
      }
      pendingSource = normalized
      return try {
        ContextCompat.startForegroundService(
          context.applicationContext,
          Intent(context.applicationContext, PlaybackService::class.java)
            .setAction(ACTION_PLAY)
            .putExtra(EXTRA_SOURCE, normalized),
        )
        ""
      } catch (error: Throwable) {
        pendingSource = null
        recordError("Unable to start Media3 playback", error)
      }
    }

    @JvmStatic
    fun pause(): Boolean = withActiveService { it.player.pause() }

    @JvmStatic
    fun resume(): Boolean = withActiveService { it.player.play() }

    @JvmStatic
    fun seek(positionMs: Long): Boolean =
      withActiveService { it.player.seekTo(positionMs.coerceAtLeast(0)) }

    @JvmStatic
    fun setVolume(volume: Double): Boolean = withActiveService {
      it.player.volume = volume.takeIf(Double::isFinite)?.coerceIn(0.0, 1.0)?.toFloat() ?: 1f
    }

    @JvmStatic
    fun getClockJson(): String {
      val service = activeService ?: return """{"positionMs":0,"durationMs":0}"""
      return service.readClock()
    }

    @JvmStatic
    fun getLastError(): String = latestError

    @JvmStatic
    fun updateMetadata(
      context: Context,
      title: String,
      artist: String,
      album: String,
      artworkUrl: String,
      durationMs: Long,
    ) {
      pendingMetadata = NativeMetadata(
        title = title.ifBlank { "NekoBeat" },
        artist = artist,
        album = album,
        artworkUrl = artworkUrl,
        durationMs = durationMs.coerceAtLeast(0),
      )
      activeService?.postToPlayer { it.applyMetadata(pendingMetadata) }
    }

    @JvmStatic
    fun setLyricsCues(title: String, artist: String, cuesJson: String, offsetMs: Long) {
      LyricsSync.setCues(title, artist, cuesJson, offsetMs)
      // Push an immediate line if we already know position
      activeService?.postToPlayer { svc ->
        try {
          LyricsSync.tick(svc.applicationContext, svc.player.currentPosition)
        } catch (_: Throwable) {
        }
      }
    }

    @JvmStatic
    fun setLyricsOffset(offsetMs: Long) {
      LyricsSync.setOffset(offsetMs)
    }

    @JvmStatic
    fun clearLyricsCues() {
      LyricsSync.clear()
    }

    @JvmStatic
    fun updateState(
      context: Context,
      isPlaying: Boolean,
      positionMs: Long,
      durationMs: Long,
      playbackRate: Double,
    ) {
      if (durationMs > 0 && pendingMetadata.durationMs <= 0) {
        pendingMetadata = pendingMetadata.copy(durationMs = durationMs)
        activeService?.postToPlayer { it.applyMetadata(pendingMetadata) }
      }
    }

    @JvmStatic
    fun stop(context: Context) {
      pendingSource = null
      val service = activeService
      if (service != null) {
        service.postToPlayer {
          try {
            it.player.stop()
            it.player.clearMediaItems()
          } catch (_: Throwable) {
          }
          it.stopSelf()
        }
      } else {
        context.applicationContext.stopService(
          Intent(context.applicationContext, PlaybackService::class.java),
        )
      }
    }

    private fun normalizeSource(source: String): String? {
      val value = source.trim()
      if (value.startsWith("content://")) return value
      if (value.startsWith("file://")) {
        val path = Uri.parse(value).path ?: return null
        return Uri.fromFile(File(path)).toString()
      }
      val file = File(value)
      return if (file.isAbsolute) Uri.fromFile(file).toString() else null
    }

    private fun withActiveService(block: (PlaybackService) -> Unit): Boolean {
      val service = activeService ?: return false
      service.postToPlayer(block)
      return true
    }

    private fun recordError(message: String, error: Throwable? = null): String {
      val detail = error?.message?.takeIf { it.isNotBlank() }
      val safe = if (detail == null) message else "$message: $detail"
      latestError = safe
      if (error == null) Log.e(TAG, safe) else Log.e(TAG, safe, error)
      return safe
    }
  }

  private lateinit var player: ExoPlayer
  private lateinit var mediaSession: MediaSession
  private val mainHandler = Handler(Looper.getMainLooper())
  private val lyricsTickRunnable = object : Runnable {
    override fun run() {
      if (!::player.isInitialized || activeService !== this@PlaybackService) return
      try {
        if (player.playbackState != Player.STATE_IDLE && LyricsSync.hasCues()) {
          LyricsSync.tick(applicationContext, player.currentPosition.coerceAtLeast(0))
        }
      } catch (_: Throwable) {
      }
      mainHandler.postDelayed(this, LYRICS_TICK_MS)
    }
  }
  private var foregroundPromoted = false

  private val sessionPlayer by lazy {
    object : ForwardingPlayer(player) {
      override fun play() {
        dispatch("play")
        super.play()
      }

      override fun pause() {
        dispatch("pause")
        super.pause()
      }

      override fun stop() {
        dispatch("stop")
        super.stop()
      }

      override fun seekTo(positionMs: Long) {
        dispatch("seek_to", positionMs.coerceAtLeast(0))
        super.seekTo(positionMs)
      }

      override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
        dispatch("seek_to", positionMs.coerceAtLeast(0))
        super.seekTo(mediaItemIndex, positionMs)
      }

      override fun seekToNext() {
        dispatch("next")
      }

      override fun seekToPrevious() {
        dispatch("previous")
      }

      override fun seekToNextMediaItem() {
        dispatch("next")
      }

      override fun seekToPreviousMediaItem() {
        dispatch("previous")
      }
    }
  }

  /**
   * Must run before ExoPlayer/FFmpeg construction. Those can take longer than Android's
   * startForegroundService timeout on mid-range phones (A71).
   */
  private fun promoteToForegroundNow() {
    if (foregroundPromoted) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val mgr = getSystemService(NotificationManager::class.java)
        if (mgr.getNotificationChannel(FG_CHANNEL) == null) {
          mgr.createNotificationChannel(
            NotificationChannel(FG_CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
              description = "Now playing"
              setSound(null, null)
              enableVibration(false)
              setShowBadge(false)
            },
          )
        }
      }
      val openApp = android.app.PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
      )
      val notif = NotificationCompat.Builder(this, FG_CHANNEL)
        .setContentTitle("NekoBeat")
        .setContentText("Starting…")
        .setSmallIcon(android.R.drawable.ic_media_play)
        .setContentIntent(openApp)
        .setOngoing(true)
        .setSilent(true)
        .setOnlyAlertOnce(true)
        .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()
      ServiceCompat.startForeground(
        this,
        FG_NOTIFICATION_ID,
        notif,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
          0
        },
      )
      foregroundPromoted = true
      Log.i(TAG, "Promoted to foreground immediately")
    } catch (error: Throwable) {
      Log.e(TAG, "Immediate startForeground failed", error)
      // Last resort without type flag
      try {
        val notif = NotificationCompat.Builder(this, FG_CHANNEL)
          .setContentTitle("NekoBeat")
          .setContentText("Playing")
          .setSmallIcon(android.R.drawable.ic_media_play)
          .setOngoing(true)
          .setSilent(true)
          .build()
        startForeground(FG_NOTIFICATION_ID, notif)
        foregroundPromoted = true
      } catch (inner: Throwable) {
        Log.e(TAG, "Fallback startForeground failed", inner)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    // Beat the FGS clock before any heavy native/decoder work.
    promoteToForegroundNow()

    val renderersFactory = DefaultRenderersFactory(this)
      .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
    player = ExoPlayer.Builder(this, renderersFactory)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(C.USAGE_MEDIA)
          .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
          .build(),
        true,
      )
      .setHandleAudioBecomingNoisy(true)
      .build()
      .also {
        it.addListener(object : Player.Listener {
          override fun onPlayerError(error: PlaybackException) {
            recordError(friendlyPlaybackError(error), error)
          }

          override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
              Player.STATE_READY, Player.STATE_BUFFERING -> {
                endedDispatchedForItem = false
              }
              Player.STATE_ENDED -> {
                if (!endedDispatchedForItem) {
                  endedDispatchedForItem = true
                  Log.i(TAG, "Track ended — requesting next")
                  dispatch("ended")
                }
              }
            }
          }

          override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            endedDispatchedForItem = false
          }
        })
      }
    mediaSession = MediaSession.Builder(this, sessionPlayer)
      .setSessionActivity(
        android.app.PendingIntent.getActivity(
          this,
          0,
          Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
          android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        ),
      )
      .build()
    activeService = this
    mainHandler.removeCallbacks(lyricsTickRunnable)
    mainHandler.post(lyricsTickRunnable)

    // Pick up a play that raced ahead of onCreate.
    pendingSource?.let { source ->
      pendingSource = null
      playSource(source)
    }
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = mediaSession

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    promoteToForegroundNow()
    val sourceFromIntent =
      if (intent?.action == ACTION_PLAY) intent.getStringExtra(EXTRA_SOURCE).orEmpty() else ""
    val source = sourceFromIntent.ifBlank { pendingSource.orEmpty() }
    if (source.isNotEmpty()) {
      pendingSource = null
      if (::player.isInitialized) {
        playSource(source)
      } else {
        pendingSource = source
      }
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(lyricsTickRunnable)
    if (activeService === this) activeService = null
    pendingSource = null
    foregroundPromoted = false
    LyricsSync.clear()
    LyricsNotification.clear(applicationContext)
    try {
      mediaSession.release()
    } catch (_: Throwable) {
    }
    try {
      player.release()
    } catch (_: Throwable) {
    }
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    LyricsSync.clear()
    LyricsNotification.clearOnAppClosed(applicationContext)
    try {
      if (::player.isInitialized) {
        player.stop()
        player.clearMediaItems()
      }
    } catch (_: Throwable) {
    }
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  private fun playSource(source: String) {
    if (source.isBlank() || !::player.isInitialized) return
    try {
      promoteToForegroundNow()
      endedDispatchedForItem = false
      val uri = Uri.parse(source)
      val item = MediaItem.Builder()
        .setUri(uri)
        .setMediaMetadata(buildMediaMetadata(pendingMetadata))
        .build()
      latestError = ""
      player.setMediaItem(item)
      player.prepare()
      player.play()
      Log.i(TAG, "playSource ok: $source")
    } catch (error: Throwable) {
      recordError("Unable to load local media", error)
    }
  }

  private fun friendlyPlaybackError(error: PlaybackException): String = when (error.errorCode) {
    PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND ->
      "This song file is missing. Remove it from the library or scan again"
    PlaybackException.ERROR_CODE_IO_NO_PERMISSION ->
      "NekoBeat lost access to this song. Grant music or folder permission again"
    PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
      "This audio format is not supported on this device"
    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
    PlaybackException.ERROR_CODE_DECODING_FAILED ->
      "The audio decoder could not play this file. The file may be damaged"
    PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES ->
      "This file's sample rate or channel layout exceeds this device's audio capability"
    else -> "Media3 could not play this song"
  }

  private fun applyMetadata(metadata: NativeMetadata) {
    if (!::player.isInitialized || player.mediaItemCount == 0) return
    val current = player.currentMediaItem ?: return
    player.replaceMediaItem(
      player.currentMediaItemIndex,
      current.buildUpon().setMediaMetadata(buildMediaMetadata(metadata)).build(),
    )
  }

  private fun buildMediaMetadata(metadata: NativeMetadata): MediaMetadata =
    MediaMetadata.Builder()
      .setTitle(metadata.title)
      .setArtist(metadata.artist)
      .setAlbumTitle(metadata.album)
      .setArtworkUri(metadata.artworkUrl.takeIf { it.isNotBlank() }?.let(Uri::parse))
      .setDurationMs(metadata.durationMs.takeIf { it > 0 })
      .build()

  private fun dispatch(action: String, positionMs: Long? = null) {
    PendingMediaActionStore.enqueue(this, action, positionMs)
    sendBroadcast(Intent(PendingMediaActionStore.BROADCAST_ACTION).setPackage(packageName))
  }

  private fun postToPlayer(block: (PlaybackService) -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block(this)
    else mainHandler.post { if (activeService === this) block(this) }
  }

  private fun readClock(): String {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      return clockJson()
    }
    var position = 0L
    var duration = 0L
    val latch = CountDownLatch(1)
    mainHandler.post {
      if (activeService === this && ::player.isInitialized) {
        position = player.currentPosition.coerceAtLeast(0)
        duration = player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0) ?: 0
      }
      latch.countDown()
    }
    if (!latch.await(500, TimeUnit.MILLISECONDS)) {
      recordError("Timed out reading Media3 clock")
    }
    return clockPayload(position, duration)
  }

  private fun clockJson(): String = clockPayload(
    player.currentPosition.coerceAtLeast(0),
    player.duration.takeIf { it != C.TIME_UNSET }?.coerceAtLeast(0) ?: 0,
  )

  private fun clockPayload(position: Long, duration: Long): String {
    val error = latestError
    if (error.isNotEmpty()) latestError = ""
    return JSONObject()
      .put("positionMs", position)
      .put("durationMs", duration)
      .put("sampledAtMs", SystemClock.elapsedRealtime())
      .put("error", error)
      .toString()
  }
}
