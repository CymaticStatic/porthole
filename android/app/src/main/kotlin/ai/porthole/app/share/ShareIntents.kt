package ai.porthole.app.share

import ai.porthole.shared.Routes
import android.content.Intent
import android.net.Uri
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Reads what another app shared (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`) and routes it to a chat. */
object ShareIntents {
    private const val INBOX = "#/inbox"

    /**
     * The shared files, in order, without repeats: `EXTRA_STREAM` first, then the `ClipData` items (Android puts the
     * same uri in both). Only `content:` uris count: a `file:` uri sent by another app would be opened with this app's
     * own permissions, which would let it read the app's private files.
     */
    fun uris(intent: Intent): List<Uri> {
        val found = LinkedHashSet<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(found::add)
            Intent.ACTION_SEND_MULTIPLE ->
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let(found::addAll)
            else -> return emptyList()
        }
        val clip = intent.clipData
        if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(found::add)
        return found.filter { it.scheme == "content" }
    }

    /** The shared text (a link, a note), or `null` when there is none: `EXTRA_TEXT`, else a text-only `ClipData` item. */
    fun text(intent: Intent): String? {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
        intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }?.let { return it }
        val clip = intent.clipData ?: return null
        for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i)
            if (item.uri == null) item.text?.toString()?.takeIf { it.isNotBlank() }?.let { return it }
        }
        return null
    }

    /**
     * Design decision 6: the route of the last chat open on [machineName]. [openListJson] is the page's
     * `porthole:open` value, a JSON array (newest first) of `{machine, sessionId, view}`. Anything that is not such an
     * array, or holds no `chat` entry for the machine, gives `#/inbox`, where the page shows its chat picker.
     */
    fun lastChatRoute(openListJson: String?, machineName: String): String {
        val list = try {
            Json.parseToJsonElement(openListJson ?: return INBOX) as? JsonArray ?: return INBOX
        } catch (_: SerializationException) {
            return INBOX
        } catch (_: IllegalArgumentException) {
            return INBOX
        }
        for (entry in list) {
            val o = entry as? JsonObject ?: continue
            if (o.text("view") != "chat" || o.text("machine") != machineName) continue
            val session = o.text("sessionId") ?: continue
            return "#/chat/" + Routes.segment(machineName) + "/" + Routes.segment(session)
        }
        return INBOX
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
