package com.nishal21.nekobeat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.text.Html
import android.text.Spanned
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlin.math.max
import kotlin.math.min

/**
 * Lyrics notification: BigText with nearby lines, current line bold, NekoBeat accent.
 * Swipe to dismiss. Cleared when the app is removed from Recents.
 */
object LyricsNotification {
  const val CHANNEL_ID = "com.nishal21.nekobeat.lyrics"
  const val NOTIF_ID = 2408
  const val ACTION_HIDE = "com.nishal21.nekobeat.lyrics.HIDE"
  const val ACTION_DISMISSED = "com.nishal21.nekobeat.lyrics.DISMISSED"

  @Volatile
  private var visible = true
  @Volatile
  private var lastSongKey = ""
  @Volatile
  private var lastPayload = ""

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val existing = mgr.getNotificationChannel(CHANNEL_ID)
    if (existing != null && existing.importance < NotificationManager.IMPORTANCE_DEFAULT) {
      mgr.deleteNotificationChannel(CHANNEL_ID)
    } else if (existing != null) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      "NekoBeat Lyrics",
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Live lyric lines while music plays"
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
      lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    }
    mgr.createNotificationChannel(channel)
  }

  private fun cleanLine(raw: String): String =
    raw.trim()
      .removePrefix("▶ ")
      .removePrefix("▶")
      .trim()
      .ifBlank { "…" }

  private fun htmlRaw(markup: String): Spanned =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      Html.fromHtml(markup, Html.FROM_HTML_MODE_LEGACY)
    } else {
      @Suppress("DEPRECATION")
      Html.fromHtml(markup)
    }

  @JvmStatic
  fun show(context: Context, title: String, artist: String, line: String) {
    val songKey = "${title.trim()}\u0000${artist.trim()}"
    if (songKey != lastSongKey) {
      lastSongKey = songKey
      visible = true
      lastPayload = ""
    }
    if (!visible) return

    // Skip identical redraws to keep JNI / notify lag-free
    val payload = "$songKey\u0000$line"
    if (payload == lastPayload) return
    lastPayload = payload

    ensureChannel(context)

    val lines = line
      .lineSequence()
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toList()
      .ifEmpty { listOf(line.ifBlank { "…" }) }

    val currentIdx = lines.indexOfFirst { it.startsWith("▶") }.let { if (it >= 0) it else (lines.size / 2) }
    val current = cleanLine(lines.getOrNull(currentIdx).orEmpty())

    val from = max(0, currentIdx - 2)
    val to = min(lines.lastIndex, currentIdx + 2)
    val bigMarkup = buildString {
      for (i in from..to) {
        if (isNotEmpty()) append("<br>")
        val text = Html.escapeHtml(cleanLine(lines[i]))
        if (i == currentIdx) {
          append("<br><b>")
          append(text)
          append("</b><br>")
        } else {
          append(text)
        }
      }
    }

    val song = title.ifBlank { "NekoBeat" }
    val who = artist.trim()
    val appCtx = context.applicationContext

    val hidePending = PendingIntent.getBroadcast(
      appCtx,
      0,
      Intent(appCtx, LyricsHideReceiver::class.java).setAction(ACTION_HIDE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val dismissPending = PendingIntent.getBroadcast(
      appCtx,
      1,
      Intent(appCtx, LyricsHideReceiver::class.java).setAction(ACTION_DISMISSED),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val openApp = PendingIntent.getActivity(
      appCtx,
      2,
      Intent(appCtx, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val notif = NotificationCompat.Builder(appCtx, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setColor(Color.parseColor("#F3AD24"))
      .setContentTitle(song)
      .setContentText(current)
      .setSubText(who.ifBlank { "NekoBeat" })
      .setContentIntent(openApp)
      .setStyle(
        NotificationCompat.BigTextStyle()
          .setBigContentTitle(htmlRaw("<b>${Html.escapeHtml(song)}</b>"))
          .bigText(htmlRaw(bigMarkup))
          .setSummaryText(who.ifBlank { "NekoBeat" }),
      )
      .addAction(0, "Hide", hidePending)
      .setDeleteIntent(dismissPending)
      .setOngoing(false) // swipe to dismiss
      .setAutoCancel(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .build()

    try {
      NotificationManagerCompat.from(appCtx).notify(NOTIF_ID, notif)
    } catch (e: SecurityException) {
      android.util.Log.w("NekoBeat", "Lyrics notification permission missing", e)
    }
  }

  @JvmStatic
  fun clear(context: Context) {
    lastPayload = ""
    NotificationManagerCompat.from(context.applicationContext).cancel(NOTIF_ID)
  }

  /** App removed from Recents / process teardown — always clear. */
  @JvmStatic
  fun clearOnAppClosed(context: Context) {
    visible = true
    lastPayload = ""
    lastSongKey = ""
    clear(context)
  }

  @JvmStatic
  fun hideForSession(context: Context) {
    visible = false
    lastPayload = ""
    clear(context)
  }

  @JvmStatic
  fun resetVisibility() {
    visible = true
  }
}

class LyricsHideReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      LyricsNotification.ACTION_HIDE,
      LyricsNotification.ACTION_DISMISSED,
      -> LyricsNotification.hideForSession(context.applicationContext)
    }
  }
}
