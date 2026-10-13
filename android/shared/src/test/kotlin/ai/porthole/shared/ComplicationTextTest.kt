package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComplicationTextTest {
    private fun item(n: Int) = WatchItem("o", "m", "i$n", "s", "p", "t", null, emptyList(), false, n.toLong())
    private fun state(items: Int = 0, vararg pct: Double) = WatchState(
        1, List(items) { item(it) }, pct.mapIndexed { i, p -> WatchUsage("m", "w$i", p, null) },
    )

    @Test fun waitingCountsItems() {
        assertEquals(ComplicationText.Short("3", "waiting", "3 waiting"), ComplicationText.waiting(state(3)))
        assertEquals(ComplicationText.Short("0", "waiting", "0 waiting"), ComplicationText.waiting(state(0)))
    }

    @Test fun waitingWithoutStateIsZero() {
        assertEquals(ComplicationText.Short("0", "waiting", "0 waiting"), ComplicationText.waiting(null))
    }

    @Test fun usagePicksTheHighestWindow() {
        val r = ComplicationText.usage(state(0, 40.0, 72.0))!!
        assertEquals(72f, r.value, 0f)
        assertEquals("72%", r.text)
        assertEquals("Highest Claude usage 72 percent", r.description)
    }

    @Test fun usageIsClampedToZeroAndHundred() {
        val hi = ComplicationText.usage(state(0, 130.0))!!
        assertEquals(100f, hi.value, 0f); assertEquals("100%", hi.text)
        val lo = ComplicationText.usage(state(0, -5.0))!!
        assertEquals(0f, lo.value, 0f); assertEquals("0%", lo.text)
    }

    @Test fun usageRoundsForTheText() {
        val r = ComplicationText.usage(state(0, 72.6))!!
        assertEquals("73%", r.text)
        assertEquals(72.6f, r.value, 0.001f)
    }

    @Test fun usageIsNullWithoutWindows() {
        assertNull(ComplicationText.usage(state(2)))
        assertNull(ComplicationText.usage(null))
    }
}
