package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchStateTest {
    private val item = WatchItem(
        "https://desk.example.ts.net", "desk", "i1", "tmux:t:main:0.0", "porthole", "Allow edit?",
        "Run the tests? é ✓", listOf("Yes", "No"), false, 1_700_000_000_000,
    )
    private val state = WatchState(
        1_700_000_001_000,
        listOf(item, item.copy(itemId = "i2", question = null, options = emptyList(), multi = true)),
        listOf(WatchUsage("desk", "5h", 72.5, "2026-10-13T20:00:00Z"), WatchUsage("desk", "7d", 10.0, null)),
    )

    @Test fun stateRoundTrips() {
        assertEquals(state, WatchState.decode(state.encode()))
        val empty = WatchState(1, emptyList(), emptyList())
        assertEquals(empty, WatchState.decode(empty.encode()))
    }

    @Test fun badBytesDecodeToNull() {
        assertNull(WatchState.decode("x".toByteArray()))
        assertNull(WatchState.decode(ByteArray(0)))
        assertNull(WatchState.decode("""{"updatedAt":1}""".toByteArray()))
    }

    @Test fun answersRoundTripWithTheirRequestId() {
        val option = WatchAnswer.Option("r1", "https://desk.example.ts.net", "i1", listOf(1))
        val stop = WatchAnswer.Stop("r2", "https://desk.example.ts.net", "tmux:t:main:0.0")
        assertEquals(option, WatchAnswer.decode(option.encode()))
        assertEquals(stop, WatchAnswer.decode(stop.encode()))
        assertEquals("r1", WatchAnswer.decode(option.encode())?.requestId)
        assertEquals("r2", WatchAnswer.decode(stop.encode())?.requestId)
    }

    @Test fun answerJsonCarriesTheTypeDiscriminator() {
        val text = WatchAnswer.Option("r1", "o", "i", listOf(0, 2)).encode().toString(Charsets.UTF_8)
        assertTrue(text, text.contains("\"type\""))
        assertTrue(text, text.contains("\"optionIndexes\":[0,2]"))
        assertTrue(WatchAnswer.decode(text.toByteArray()) is WatchAnswer.Option)
    }

    @Test fun badAnswerBytesDecodeToNull() {
        assertNull(WatchAnswer.decode("nope".toByteArray()))
        assertNull(WatchAnswer.decode("""{"type":"other","requestId":"r"}""".toByteArray()))
        assertNull(WatchAnswerResult.decode("nope".toByteArray()))
    }

    @Test fun answerResultRoundTrips() {
        val r = WatchAnswerResult("r1", true, "Sent: Yes")
        assertEquals(r, WatchAnswerResult.decode(r.encode()))
        assertNotNull(WatchAnswerResult.decode(WatchAnswerResult("r2", false, "Phone not connected").encode()))
    }

    @Test fun pathsAreTheAgreedOnes() {
        assertEquals("/porthole/state", WatchPaths.STATE)
        assertEquals("/porthole/answer", WatchPaths.ANSWER)
        assertEquals("/porthole/answer-result", WatchPaths.ANSWER_RESULT)
        assertEquals("/porthole/refresh", WatchPaths.REFRESH)
        assertEquals("porthole_phone", WatchPaths.PHONE_CAPABILITY)
    }
}
