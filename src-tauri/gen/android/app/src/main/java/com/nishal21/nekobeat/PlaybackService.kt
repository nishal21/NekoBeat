package com.nishal21.nekobeat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.Executors

data class PendingMediaAction(val action: String, val positionMs: Long?)

/**
 * Process-local action mailbox. Actions are persisted before broadcast so media buttons still
 * reach the WebView after Android recreates MainActivity.
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
    for (i in 0 until actions.length()) {
      val item = actions.optJSONObject(i) ?: continue
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

/**
 * Android owns only the MediaSession and notification. Rust/GStreamer remains the audio engine.
 */
class PlaybackService : Service() {
  companion object {
    private const val CHANNEL_ID = "com.nishal21.nekobeat.playback"
    private const val NOTIFICATION_ID = 2407
    private const val ACTION_START = "com.nishal21.nekobeat.playback.START"
    private const val ACTION_UPDATE_METADATA = "com.nishal21.nekobeat.playback.METADATA"
    private const val ACTION_UPDATE_STATE = "com.nishal21.nekobeat.playback.STATE"
    private const val ACTION_STOP = "com.nishal21.nekobeat.playback.STOP"

    @JvmStatic
    fun start(context: Context) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, PlaybackService::class.java).setAction(ACTION_START),
      )
    }

    @JvmStatic
    fun updateMetadata(
      context: Context,
      title: String,
      artist: String,
      album: String,
      artworkUrl: String,
      durationMs: Long,
    ) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, PlaybackService::class.java)
          .setAction(ACTION_UPDATE_METADATA)
          .putExtra("title", title)
          .putExtra("artist", artist)
          .putExtra("album", album)
          .putExtra("artworkUrl", artworkUrl)
          .putExtra("durationMs", durationMs),
      )
    }

    @JvmStatic
    fun updateState(
      context: Context,
      isPlaying: Boolean,
      positionMs: Long,
      durationMs: Long,
      playbackRate: Double,
    ) {
      ContextCompat.startForegroundService(
        context,
        Intent(context, PlaybackService::class.java)
          .setAction(ACTION_UPDATE_STATE)
          .putExtra("isPlaying", isPlaying)
          .putExtra("positionMs", positionMs)
          .putExtra("durationMs", durationMs)
          .putExtra("playbackRate", playbackRate),
      )
    }

    @JvmStatic
    fun stop(context: Context) {
      context.stopService(Intent(context, PlaybackService::class.java))
    }
  }

  private lateinit var mediaSession: MediaSessionCompat
  private val artworkExecutor = Executors.newSingleThreadExecutor()
  private var title = "NekoBeat"
  private var artist = ""
  private var album = ""
  private var artworkUrl = ""
  private var artwork: Bitmap? = null
  private var isPlaying = false
  private var positionMs = 0L
  private var durationMs = 0L
  private var playbackRate = 1f

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    mediaSession = MediaSessionCompat(this, "NekoBeatPlayback").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = dispatch("play")
        override fun onPause() = dispatch("pause")
        override fun onSkipToPrevious() = dispatch("previous")
        override fun onSkipToNext() = dispatch("next")
        override fun onSeekTo(pos: Long) = dispatch("seek_to", pos.coerceAtLeast(0))
        override fun onStop() = dispatch("stop")
      })
      isActive = true
    }
    publishMetadata()
    publishPlaybackState()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    MediaButtonReceiver.handleIntent(mediaSession, intent)
    when (intent?.action) {
      ACTION_UPDATE_METADATA -> {
        title = intent.getStringExtra("title").orEmpty().ifBlank { "NekoBeat" }
        artist = intent.getStringExtra("artist").orEmpty()
        album = intent.getStringExtra("album").orEmpty()
        durationMs = intent.getLongExtra("durationMs", durationMs).coerceAtLeast(0)
        val nextArtworkUrl = intent.getStringExtra("artworkUrl").orEmpty()
        if (nextArtworkUrl != artworkUrl) {
          artworkUrl = nextArtworkUrl
          artwork = null
          loadArtwork(nextArtworkUrl)
        }
        publishMetadata()
      }
      ACTION_UPDATE_STATE -> {
        isPlaying = intent.getBooleanExtra("isPlaying", false)
        positionMs = intent.getLongExtra("positionMs", positionMs).coerceAtLeast(0)
        durationMs = intent.getLongExtra("durationMs", durationMs).coerceAtLeast(0)
        playbackRate = intent.getDoubleExtra("playbackRate", playbackRate.toDouble())
          .takeIf { it.isFinite() }
          ?.coerceIn(0.5, 2.0)
          ?.toFloat()
          ?: 1f
        publishPlaybackState()
      }
      ACTION_STOP -> {
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
    }
    startForeground(NOTIFICATION_ID, buildNotification())
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    artworkExecutor.shutdownNow()
    mediaSession.isActive = false
    mediaSession.release()
    super.onDestroy()
  }

  private fun dispatch(action: String, seekPositionMs: Long? = null) {
    PendingMediaActionStore.enqueue(this, action, seekPositionMs)
    sendBroadcast(
      Intent(PendingMediaActionStore.BROADCAST_ACTION)
        .setPackage(packageName),
    )
  }

  private fun publishMetadata() {
    val builder = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
    artwork?.let {
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
      builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
    }
    mediaSession.setMetadata(builder.build())
    refreshNotification()
  }

  private fun publishPlaybackState() {
    val actions = PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_SEEK_TO or
      PlaybackStateCompat.ACTION_STOP
    mediaSession.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(
          if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          if (durationMs > 0) positionMs.coerceAtMost(durationMs) else positionMs,
          if (isPlaying) playbackRate else 0f,
          SystemClock.elapsedRealtime(),
        )
        .build(),
    )
    refreshNotification()
  }

  private fun buildNotification(): Notification {
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val previousIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
      this,
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS,
    )
    val playPauseIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
      this,
      if (isPlaying) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY,
    )
    val nextIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
      this,
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title)
      .setContentText(artist.ifBlank { album.ifBlank { "NekoBeat" } })
      .setSubText(album)
      .setLargeIcon(artwork)
      .setContentIntent(contentIntent)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setOngoing(true)
      .addAction(android.R.drawable.ic_media_previous, "Previous", previousIntent)
      .addAction(
        if (isPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
        if (isPlaying) "Pause" else "Play",
        playPauseIntent,
      )
      .addAction(android.R.drawable.ic_media_next, "Next", nextIntent)
      .setStyle(
        MediaStyle()
          .setMediaSession(mediaSession.sessionToken)
          .setShowActionsInCompactView(0, 1, 2),
      )
      .build()
  }

  private fun refreshNotification() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    try {
      manager.notify(NOTIFICATION_ID, buildNotification())
    } catch (error: SecurityException) {
      // Android 13+: playback may start before the user grants notification permission.
      android.util.Log.w("NekoBeat", "Playback notification permission missing", error)
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Playback",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Playback controls for NekoBeat"
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      },
    )
  }

  private fun loadArtwork(url: String) {
    if (url.isBlank()) return
    artworkExecutor.execute {
      val bitmap = try {
        when {
          url.startsWith("http://") || url.startsWith("https://") ->
            URL(url).openConnection().apply {
              connectTimeout = 5000
              readTimeout = 5000
            }.getInputStream().use { BitmapFactory.decodeStream(it) }
          url.startsWith("content:") ->
            contentResolver.openInputStream(Uri.parse(url))?.use { BitmapFactory.decodeStream(it) }
          url.startsWith("file:") ->
            BitmapFactory.decodeFile(Uri.parse(url).path)
          else -> BitmapFactory.decodeFile(File(url).absolutePath)
        }
      } catch (e: Exception) {
        android.util.Log.w("NekoBeat", "Media artwork load failed", e)
        null
      }
      if (bitmap != null) {
        android.os.Handler(mainLooper).post {
          if (artworkUrl == url) {
            artwork = bitmap
            publishMetadata()
          }
        }
      }
    }
  }

  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
  }
}
