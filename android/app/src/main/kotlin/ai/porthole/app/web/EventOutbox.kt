package ai.porthole.app.web

import ai.porthole.shared.BridgeProtocol
import kotlinx.serialization.json.JsonElement

/**
 * Native-to-page events (`network`, `share`, `recordingStopped`). The page can only be reached through the reply proxy
 * of a message it has posted, so a fresh page (new process, or `ShareActivity` relaunching `MainActivity`) has no proxy
 * yet: events wait here until [onMessage] hands over the poster of the current main frame, then go out in order.
 *
 * [onNewFrame] (a main-frame load started) forgets the poster: the old frame's proxy belongs to a page that is gone.
 * Of several waiting `network` events only the newest is kept. `onSent` runs once, after the message was really posted.
 */
class EventOutbox {
    private class Item(val name: String, val data: JsonElement, val onSent: () -> Unit)

    private var post: ((String) -> Unit)? = null
    private val queue = ArrayList<Item>()

    /** Sends at once when the current frame has posted a message, otherwise queues. */
    @Synchronized
    fun emit(name: String, data: JsonElement, onSent: () -> Unit = {}) {
        val item = Item(name, data, onSent)
        if (!trySend(item)) enqueue(item)
    }

    /** The page's main frame posted a message: [post] reaches it from now on. Flushes the queue in order. */
    @Synchronized
    fun onMessage(post: (String) -> Unit) {
        this.post = post
        while (queue.isNotEmpty()) {
            if (!trySend(queue.first())) return
            queue.removeAt(0)
        }
    }

    /** A new main frame is loading: nothing can be posted until it posts a message. */
    @Synchronized
    fun onNewFrame() {
        post = null
    }

    /** How many events wait for a page to post a message. */
    @Synchronized
    fun pendingCount(): Int = queue.size

    private fun trySend(item: Item): Boolean {
        val send = post ?: return false
        try {
            send(BridgeProtocol.event(item.name, item.data))
        } catch (_: Exception) {
            // The frame's proxy is gone (the page navigated away): keep the event for the next frame.
            post = null
            return false
        }
        item.onSent()
        return true
    }

    private fun enqueue(item: Item) {
        if (item.name == NETWORK) queue.removeAll { it.name == NETWORK }
        queue.add(item)
    }

    companion object {
        const val NETWORK = "network"
        const val SHARE = "share"
        const val RECORDING_STOPPED = "recordingStopped"
    }
}
