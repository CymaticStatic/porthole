package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun doublesFromOneSecondAndCapsAtFifteen() {
        val b = Backoff()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 15_000L, 15_000L, 15_000L), List(7) { b.nextDelayMs() })
    }
    @Test fun resetAfterSuccessStartsAgainAtOne() {
        val b = Backoff(); repeat(5) { b.nextDelayMs() }; b.reset()
        assertEquals(1_000L, b.nextDelayMs())
    }
    @Test fun nudgeRetriesNowThenRestartsTheSchedule() {
        val b = Backoff(); repeat(4) { b.nextDelayMs() }
        assertEquals(0L, b.nudge())
        assertEquals(1_000L, b.nextDelayMs())
    }
    @Test fun manyFailuresNeverOverflow() {
        val b = Backoff(); repeat(10_000) { b.nextDelayMs() }
        assertEquals(15_000L, b.nextDelayMs())
    }
    @Test fun customCapIsHonoured() {
        val b = Backoff(capMs = 3_000)
        assertEquals(listOf(1_000L, 2_000L, 3_000L, 3_000L), List(4) { b.nextDelayMs() })
    }
}
