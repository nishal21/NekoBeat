package com.nishal21.nekobeat

import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thin wrapper over SpotiFLAC-Mobile gomobile AAR (`gobackend.Gobackend`).
 * Called from Rust via JNI. Built-in providers are retired — extensions required.
 */
object SpotiFlacMobile {
  private const val TAG = "SpotiFlacMobile"
  private val ready = AtomicBoolean(false)
  private var lastInitError: String? = "not initialized"

  @JvmStatic
  fun isAvailable(): Boolean {
    return try {
      Class.forName("gobackend.Gobackend")
      true
    } catch (_: Throwable) {
      false
    }
  }

  @JvmStatic
  fun lastError(): String = lastInitError ?: ""

  @JvmStatic
  fun ensureInitialized(filesDirPath: String): String {
    if (ready.get()) {
      return """{"ok":true,"already":true}"""
    }
    synchronized(this) {
      if (ready.get()) {
        return """{"ok":true,"already":true}"""
      }
      if (!isAvailable()) {
        lastInitError = "gobackend.aar missing — build with scripts/build-gobackend-aar.sh"
        return """{"ok":false,"error":"$lastInitError"}"""
      }
      return try {
        val root = File(filesDirPath)
        val extDir = File(root, "spotiflac_ext")
        val dataDir = File(root, "spotiflac_data")
        val repoCache = File(root, "spotiflac_repo")
        extDir.mkdirs()
        dataDir.mkdirs()
        repoCache.mkdirs()

        val gobackend = Class.forName("gobackend.Gobackend")
        invokeStatic(gobackend, "initExtensionSystem", arrayOf(String::class.java, String::class.java), extDir.absolutePath, dataDir.absolutePath)
        invokeStatic(gobackend, "initExtensionRepoJSON", arrayOf(String::class.java), repoCache.absolutePath)

        // Official community registry (SpotiFLAC-Extension).
        val registry =
          System.getenv("NEKOBEAT_SPOTIFLAC_EXT_REGISTRY")
            ?: "https://raw.githubusercontent.com/spotiflacapp/SpotiFLAC-Extension/main/registry.json"
        invokeStatic(gobackend, "setRepoRegistryURLJSON", arrayOf(String::class.java), registry)

        // Load any already-downloaded packages.
        invokeStatic(gobackend, "loadExtensionsFromDir", arrayOf(String::class.java), extDir.absolutePath)

        ready.set(true)
        lastInitError = null
        Log.i(TAG, "Initialized ext=$extDir data=$dataDir registry=$registry")
        """{"ok":true,"extensions_dir":"${extDir.absolutePath}","registry":"$registry"}"""
      } catch (t: Throwable) {
        lastInitError = t.message ?: t.toString()
        Log.e(TAG, "Init failed", t)
        """{"ok":false,"error":${jsonString(lastInitError!!)}}"""
      }
    }
  }

  @JvmStatic
  fun bootstrapDefaultExtensions(filesDirPath: String): String {
    val init = ensureInitialized(filesDirPath)
    if (init.contains("\"ok\":false")) return init
    return try {
      val gobackend = Class.forName("gobackend.Gobackend")
      val root = File(filesDirPath)
      val extDir = File(root, "spotiflac_ext")
      val marker = File(root, "spotiflac_data/.nekobeat_ext_bootstrapped")
      if (marker.exists()) {
        return """{"ok":true,"skipped":true,"reason":"already bootstrapped"}"""
      }

      // Minimal set: metadata + common download providers (HiFi + YT Music fallback).
      val defaults = listOf(
        "spotify-web",
        "tidal-web",
        "qobuz-web",
        "deezer",
        "amazon",
        "ytmusic-spotiflac",
      )
      val installed = mutableListOf<String>()
      val errors = mutableListOf<String>()
      for (id in defaults) {
        try {
          val path = invokeStatic(
            gobackend,
            "downloadRepoExtensionJSON",
            arrayOf(String::class.java, String::class.java),
            id,
            extDir.absolutePath,
          ) as? String
          if (path.isNullOrBlank()) {
            errors.add("$id: empty path")
            continue
          }
          invokeStatic(gobackend, "loadExtensionFromPath", arrayOf(String::class.java), path)
          invokeStatic(gobackend, "setExtensionEnabledByID", arrayOf(String::class.java, Boolean::class.javaPrimitiveType!!), id, true)
          installed.add(id)
        } catch (t: Throwable) {
          errors.add("$id: ${t.message}")
          Log.w(TAG, "bootstrap $id failed", t)
        }
      }

      // Prefer lossless providers, then YouTube Music.
      val priority = """["tidal-web","qobuz-web","deezer","amazon","ytmusic-spotiflac"]"""
      try {
        invokeStatic(gobackend, "setProviderPriorityJSON", arrayOf(String::class.java), priority)
      } catch (t: Throwable) {
        errors.add("priority: ${t.message}")
      }

      if (installed.isNotEmpty()) {
        marker.parentFile?.mkdirs()
        marker.writeText(installed.joinToString(","))
      }
      """{"ok":true,"installed":${installed.joinToString(prefix="[", postfix="]") { jsonString(it) }},"errors":${errors.joinToString(prefix="[", postfix="]") { jsonString(it) }}}"""
    } catch (t: Throwable) {
      Log.e(TAG, "bootstrap failed", t)
      """{"ok":false,"error":${jsonString(t.message ?: t.toString())}}"""
    }
  }

  @JvmStatic
  fun downloadByStrategy(requestJson: String): String {
    return try {
      val gobackend = Class.forName("gobackend.Gobackend")
      val result = invokeStatic(gobackend, "downloadByStrategy", arrayOf(String::class.java), requestJson)
      result?.toString() ?: """{"success":false,"error":"null response"}"""
    } catch (t: Throwable) {
      Log.e(TAG, "downloadByStrategy failed", t)
      """{"success":false,"error":${jsonString(t.message ?: t.toString())}}"""
    }
  }

  @JvmStatic
  fun getProgress(): String {
    return try {
      val gobackend = Class.forName("gobackend.Gobackend")
      invokeStatic(gobackend, "getAllDownloadProgress")?.toString() ?: "{}"
    } catch (t: Throwable) {
      """{"error":${jsonString(t.message ?: t.toString())}}"""
    }
  }

  @JvmStatic
  fun cancelDownload(itemId: String) {
    try {
      val gobackend = Class.forName("gobackend.Gobackend")
      invokeStatic(gobackend, "cancelDownload", arrayOf(String::class.java), itemId)
    } catch (t: Throwable) {
      Log.w(TAG, "cancelDownload failed", t)
    }
  }

  @JvmStatic
  fun installExtensionFromPath(filePath: String): String {
    return try {
      val gobackend = Class.forName("gobackend.Gobackend")
      invokeStatic(gobackend, "loadExtensionFromPath", arrayOf(String::class.java), filePath)?.toString()
        ?: """{"error":"null"}"""
    } catch (t: Throwable) {
      """{"error":${jsonString(t.message ?: t.toString())}}"""
    }
  }

  @JvmStatic
  fun installExtensionById(filesDirPath: String, extensionId: String): String {
    val init = ensureInitialized(filesDirPath)
    if (init.contains("\"ok\":false")) return init
    return try {
      val gobackend = Class.forName("gobackend.Gobackend")
      val extDir = File(filesDirPath, "spotiflac_ext")
      val path = invokeStatic(
        gobackend,
        "downloadRepoExtensionJSON",
        arrayOf(String::class.java, String::class.java),
        extensionId,
        extDir.absolutePath,
      ) as? String ?: return """{"ok":false,"error":"download returned empty"}"""
      val loaded = invokeStatic(gobackend, "loadExtensionFromPath", arrayOf(String::class.java), path)
      invokeStatic(gobackend, "setExtensionEnabledByID", arrayOf(String::class.java, Boolean::class.javaPrimitiveType!!), extensionId, true)
      """{"ok":true,"path":${jsonString(path)},"loaded":$loaded}"""
    } catch (t: Throwable) {
      """{"ok":false,"error":${jsonString(t.message ?: t.toString())}}"""
    }
  }

  private fun invokeStatic(
    clazz: Class<*>,
    name: String,
    paramTypes: Array<Class<*>> = emptyArray(),
    vararg args: Any?,
  ): Any? {
    val method = clazz.getMethod(name, *paramTypes)
    return method.invoke(null, *args)
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
