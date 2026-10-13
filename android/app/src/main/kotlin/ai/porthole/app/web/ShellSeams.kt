package ai.porthole.app.web

import android.webkit.WebView
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/**
 * Reads the page's list of open chats (`localStorage` key `porthole:open`) for the share hand-off. A seam, so tests
 * can answer without a real WebView; `MainActivity` takes the instance from `Graph.once`.
 */
fun interface OpenListReader {
    fun read(webView: WebView, done: (String?) -> Unit)
}

/**
 * The real reader. It runs one fixed, read-only script with `evaluateJavascript`; nothing from the page or from the
 * share is put into the script, and the page cannot call back into the app through it.
 */
object RealOpenListReader : OpenListReader {
    private const val SCRIPT = "localStorage.getItem('porthole:open')"

    override fun read(webView: WebView, done: (String?) -> Unit) {
        webView.evaluateJavascript(SCRIPT) { done(decodeJsString(it)) }
    }
}

/** `evaluateJavascript` hands back JSON: `null`, or a string literal. The text inside the literal, or `null`. */
internal fun decodeJsString(raw: String?): String? {
    if (raw == null) return null
    val value = try {
        Json.parseToJsonElement(raw)
    } catch (_: SerializationException) {
        return null
    }
    return (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content
}

/** Makes the [WebMessageRegistry] for a WebView; a seam, because Robolectric has no WebView that supports the bridge. */
fun interface WebMessageRegistryFactory {
    fun create(webView: WebView): WebMessageRegistry
}
