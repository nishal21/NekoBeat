package com.nishal21.nekobeat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Harmonoid-style lyrics notification: BigTextStyle with the current line.
 * Separate from MediaStyle playback (WebView MediaSession still owns controls).
 */
object LyricsNotification {
  private const val CHANNEL_ID = "com.nishal21.nekobeat.lyrics"
  private const val NOTIF_ID = 2408

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Lyrics",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows the current lyric line while music plays"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    mgr.createNotificationChannel(channel)
  }

  @JvmStatic
  fun show(context: Context, title: String, artist: String, line: String) {
    ensureChannel(context)
    val body = if (line.isBlank()) "…" else line
    val currentLine = body
      .lineSequence()
      .firstOrNull { it.startsWith("▶ ") }
      ?.removePrefix("▶ ")
      ?: body.lineSequence().firstOrNull().orEmpty().ifBlank { "…" }
    val notif = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(title.ifBlank { "NekoBeat" })
      .setContentText(currentLine)
      .setSubText(artist)
      .setStyle(
        NotificationCompat.BigTextStyle()
          .bigText(body)
          .setBigContentTitle(title.ifBlank { "NekoBeat" })
          .setSummaryText(artist),
      )
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID, notif)
    } catch (e: SecurityException) {
      android.util.Log.w("NekoBeat", "Lyrics notification permission missing", e)
    }
  }

  @JvmStatic
  fun clear(context: Context) {
    NotificationManagerCompat.from(context).cancel(NOTIF_ID)
  }
}
