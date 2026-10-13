package ai.porthole.app.web

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventOutboxTest {
    private val sent = ArrayList<String>()
    private val poster: (String) -> Unit = { sent.add(it) }

    private fun obj(key: String, value: String): JsonObject = buildJsonObject { put(key, value) }
    private fun online(value: Boolean): JsonObject = buildJsonObject { put("online", value) }

    @Test
    fun anEventBeforeAnyMessageIsNotSent() {
        val outbox = EventOutbox()
        outbox.emit("share", obj("path", "/a"))
        assertTrue(sent.isEmpty())
    }

    @Test
    fun theQueueIsSentOnceAndInOrderWhenTheFirstMessageArrives() {
        val outbox = EventOutbox()
        outbox.emit("share", obj("path", "/a"))
        outbox.emit("share", obj("path", "/b"))
        outbox.onMessage(poster)
        assertEquals(listOf("""{"event":"share","data":{"path":"/a"}}""", """{"event":"share","data":{"path":"/b"}}"""), sent)
        outbox.onMessage(poster)
        assertEquals(2, sent.size)
    }

    @Test
    fun anEventAfterTheFirstMessageGoesOutAtOnce() {
        val outbox = EventOutbox()
        outbox.onMessage(poster)
        outbox.emit("recordingStopped", obj("wav", "AAAA"))
        assertEquals(listOf("""{"event":"recordingStopped","data":{"wav":"AAAA"}}"""), sent)
    }

    @Test
    fun aNewFrameMakesTheNextEmitWaitAgain() {
        val outbox = EventOutbox()
        outbox.onMessage(poster)
        outbox.onNewFrame()
        outbox.emit("share", obj("path", "/c"))
        assertTrue(sent.isEmpty())
        outbox.onMessage(poster)
        assertEquals(1, sent.size)
    }

    @Test
    fun onlyTheNewestQueuedNetworkValueIsDelivered() {
        val outbox = EventOutbox()
        outbox.emit("network", online(true))
        outbox.emit("share", obj("path", "/a"))
        outbox.emit("network", online(false))
        outbox.emit("network", online(true))
        outbox.onMessage(poster)
        assertEquals(
            listOf(
                """{"event":"share","data":{"path":"/a"}}""",
                """{"event":"network","data":{"online":true}}""",
            ),
            sent,
        )
    }

    @Test
    fun networkValuesAreNotDroppedWhenTheFrameIsReady() {
        val outbox = EventOutbox()
        outbox.onMessage(poster)
        outbox.emit("network", online(true))
        outbox.emit("network", online(false))
        assertEquals(2, sent.size)
    }

    @Test
    fun onSentRunsOnceAndOnlyWhenTheMessageIsReallySent() {
        val outbox = EventOutbox()
        var calls = 0
        outbox.emit("recordingStopped", obj("wav", "x")) { calls++ }
        assertEquals(0, calls)
        outbox.onMessage(poster)
        assertEquals(1, calls)
        outbox.onMessage(poster)
        assertEquals(1, calls)
    }

    @Test
    fun onSentRunsAfterThePostWhenTheFrameIsReady() {
        val outbox = EventOutbox()
        outbox.onMessage(poster)
        var sentWhenCalled = -1
        outbox.emit("share", obj("path", "/a")) { sentWhenCalled = sent.size }
        assertEquals(1, sentWhenCalled)
    }

    @Test
    fun aPostThatFailsKeepsTheEventAndSkipsOnSentUntilTheNextFrame() {
        val outbox = EventOutbox()
        var calls = 0
        outbox.onMessage { throw IllegalStateException("proxy closed") }
        outbox.emit("recordingStopped", obj("wav", "x")) { calls++ }
        assertEquals(0, calls)
        outbox.onNewFrame()
        outbox.onMessage(poster)
        assertEquals(1, sent.size)
        assertEquals(1, calls)
        assertEquals(JsonPrimitive("x"), (kotlinx.serialization.json.Json.parseToJsonElement(sent[0]) as JsonObject).let { (it["data"] as JsonObject)["wav"] })
    }
}
