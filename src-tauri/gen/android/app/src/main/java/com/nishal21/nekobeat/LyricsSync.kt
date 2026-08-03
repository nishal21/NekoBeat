package com.nishal21.nekobeat

import android.content.Context
import org.json.JSONArray
import kotlin.math.max
import kotlin.math.min

/**
 * Timed lyric cues driven by ExoPlayer position so the lyrics notification
 * keeps updating while the WebView is backgrounded or the lyrics panel is closed.
 */
object LyricsSync {
  data class Cue(val timeMs: Long, val text: String)

  @Volatile
  private var title: String = ""
  @Volatile
  private var artist: String = ""
  @Volatile
  private var offsetMs: Long = 0
  @Volatile
  private var cues: List<Cue> = emptyList()
  @Volatile
  private var lastIndex: Int = -2

  @JvmStatic
  fun setCues(title: String, artist: String, cuesJson: String, offsetMs: Long) {
    this.title = title.ifBlank { "NekoBeat" }
    this.artist = artist
    this.offsetMs = offsetMs
    this.lastIndex = -2
    this.cues = parseCues(cuesJson)
  }

  @JvmStatic
  fun setOffset(offsetMs: Long) {
    this.offsetMs = offsetMs
    this.lastIndex = -2
  }

  @JvmStatic
  fun clear() {
    cues = emptyList()
    lastIndex = -2
    title = ""
    artist = ""
    offsetMs = 0
  }

  fun hasCues(): Boolean = cues.isNotEmpty()

  /** Call from the player thread with the current media position. */
  fun tick(context: Context, positionMs: Long) {
    val list = cues
    if (list.isEmpty()) return

    val adj = positionMs - offsetMs
    var idx = -1
    for (i in list.indices) {
      if (adj >= list[i].timeMs) idx = i else break
    }
    if (idx == lastIndex) return
    lastIndex = idx
    if (idx < 0) return

    val from = max(0, idx - 2)
    val to = min(list.lastIndex, idx + 2)
    val payload = buildString {
      for (i in from..to) {
        if (isNotEmpty()) append('\n')
        if (i == idx) append("▶ ")
        append(list[i].text.trim().ifBlank { "…" })
      }
    }
    LyricsNotification.show(context, title, artist, payload)
  }

  private fun parseCues(raw: String): List<Cue> {
    if (raw.isBlank()) return emptyList()
    return try {
      val arr = JSONArray(raw)
      val out = ArrayList<Cue>(arr.length())
      for (i in 0 until arr.length()) {
        val obj = arr.optJSONObject(i) ?: continue
        val text = obj.optString("text").ifBlank { obj.optString("line") }.trim()
        if (text.isEmpty()) continue
        val t = when {
          obj.has("t") -> obj.optLong("t")
          obj.has("timeMs") -> obj.optLong("timeMs")
          obj.has("time_ms") -> obj.optLong("time_ms")
          else -> continue
        }
        out.add(Cue(t.coerceAtLeast(0), text))
      }
      out.sortedBy { it.timeMs }
    } catch (_: Exception) {
      emptyList()
    }
  }
}
