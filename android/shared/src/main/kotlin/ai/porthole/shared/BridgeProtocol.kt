package ai.porthole.shared

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URISyntaxException

/**
 * The JSON the page and the native side exchange over `PortholeNative` (mirror of `web/src/net/bridge.js`):
 * requests `{id, method, args}`, replies `{id, ok:true, result}` or `{id, ok:false, error}`, events `{event, data}`.
 */
object BridgeProtocol {
    /** Exactly the methods the page's `ALLOWED` set can send. */
    val METHODS: Set<String> = setOf(
        "machines", "speak", "stopSpeaking", "startRecording", "stopRecording", "pickFile", "openExternal", "openSettings",
    )

    const val MAX_MESSAGE_CHARS = 262_144

    /** The page's own limit for one `speak` call: total UTF-8 bytes of every utterance. */
    const val MAX_SPEAK_BYTES = 100_000

    const val NOTIFICATION_SETTINGS_URL = "porthole://notification-settings"

    private val PICK_SOURCES = setOf("camera", "photo", "file")
    private val SETTINGS_SCREENS = mapOf("machines" to SettingsScreen.MACHINES, "battery" to SettingsScreen.BATTERY)

    sealed interface Parsed {
        data class Call(val id: JsonElement, val method: String, val args: JsonObject) : Parsed
        data class Bad(val id: JsonElement?, val reason: String) : Parsed
    }

    sealed interface ExternalTarget {
        data class Https(val url: String) : ExternalTarget
        data object NotificationSettings : ExternalTarget
    }

    /** The two native settings screens the page can open with `openSettings`. */
    enum class SettingsScreen { MACHINES, BATTERY }

    fun parse(text: String): Parsed {
        if (text.length > MAX_MESSAGE_CHARS) return Parsed.Bad(null, "Message too large")
        val root = try {
            Json.parseToJsonElement(text)
        } catch (_: Exception) {
            return Parsed.Bad(null, "Not JSON")
        }
        if (root !is JsonObject) return Parsed.Bad(null, "Not an object")
        val id = (root["id"] as? JsonPrimitive)?.takeIf { it !is JsonNull }
            ?: return Parsed.Bad(null, "Missing id")
        val method = (root["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: return Parsed.Bad(id, "Missing method")
        if (method !in METHODS) return Parsed.Bad(id, "Bridge method not allowed: $method")
        val args = when (val a = root["args"]) {
            null -> JsonObject(emptyMap())
            is JsonObject -> a
            else -> return Parsed.Bad(id, "args must be an object")
        }
        return Parsed.Call(id, method, args)
    }

    fun ok(id: JsonElement, result: JsonElement): String = buildJsonObject {
        put("id", id)
        put("ok", true)
        put("result", result)
    }.toString()

    fun error(id: JsonElement, message: String): String = buildJsonObject {
        put("id", id)
        put("ok", false)
        put("error", message)
    }.toString()

    fun event(name: String, data: JsonElement): String = buildJsonObject {
        put("event", name)
        put("data", data)
    }.toString()

    fun speakArgs(args: JsonObject): Result<List<String>> {
        val list = args["utterances"] as? JsonArray ?: return Result.failure(IllegalArgumentException("utterances must be a list"))
        if (list.isEmpty()) return Result.failure(IllegalArgumentException("utterances is empty"))
        val out = ArrayList<String>(list.size)
        var bytes = 0L
        for (el in list) {
            val p = el as? JsonPrimitive
            if (p == null || !p.isString) return Result.failure(IllegalArgumentException("utterances must be strings"))
            val s = p.content
            if (s.isEmpty()) return Result.failure(IllegalArgumentException("empty utterance"))
            bytes += utf8Length(s)
            if (bytes > MAX_SPEAK_BYTES) return Result.failure(IllegalArgumentException("Text too long to speak"))
            out.add(s)
        }
        return Result.success(out)
    }

    fun autoStopArg(args: JsonObject): Boolean {
        val p = args["autoStop"] as? JsonPrimitive ?: return false
        return if (p.isString) false else p.booleanOrNull ?: false
    }

    fun pickArgs(args: JsonObject): Result<String> {
        val p = args["source"] as? JsonPrimitive
        val s = if (p != null && p.isString) p.content else null
        return if (s != null && s in PICK_SOURCES) Result.success(s)
        else Result.failure(IllegalArgumentException("source must be camera, photo or file"))
    }

    fun settingsArgs(args: JsonObject): Result<SettingsScreen> {
        val p = args["screen"] as? JsonPrimitive
        val s = if (p != null && p.isString) p.content else null
        return SETTINGS_SCREENS[s]?.let { Result.success(it) }
            ?: Result.failure(IllegalArgumentException("screen must be machines or battery"))
    }

    fun externalArgs(args: JsonObject): Result<ExternalTarget> {
        val p = args["url"] as? JsonPrimitive
        val url = (if (p != null && p.isString) p.content else null)
            ?: return Result.failure(IllegalArgumentException("url is required"))
        if (url == NOTIFICATION_SETTINGS_URL) return Result.success(ExternalTarget.NotificationSettings)
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            return Result.failure(IllegalArgumentException("Bad url"))
        }
        if (uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty()) {
            return Result.success(ExternalTarget.Https(url))
        }
        return Result.failure(IllegalArgumentException("URL not allowed"))
    }

    private fun utf8Length(s: String): Int {
        var n = 0
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c.code < 0x80 -> n += 1
                c.code < 0x800 -> n += 2
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { n += 4; i++ }
                else -> n += 3
            }
            i++
        }
        return n
    }
}
