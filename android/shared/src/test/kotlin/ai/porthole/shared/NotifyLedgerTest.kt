package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyLedgerTest {
    @Test fun newIdIsFresh() {
        assertEquals(Arrival.FRESH, NotifyLedger().arrival(1, "a"))
    }

    @Test fun shownThenDuplicateAndUnacked() {
        val l = NotifyLedger()
        l.markShown(5, "a")
        assertEquals(Arrival.DUPLICATE, l.arrival(5, "a"))
        assertEquals(5L, l.since())
        assertEquals(listOf(5L), l.pendingAcks())
        assertEquals(Arrival.FRESH, l.arrival(6, "a"))
    }

    @Test fun ackedStaysDuplicate() {
        val l = NotifyLedger()
        l.markShown(5, "a")
        l.markAcked(5)
        assertTrue(l.pendingAcks().isEmpty())
        assertEquals(Arrival.DUPLICATE, l.arrival(5, "a"))
        assertEquals(5L, l.since())
    }

    @Test fun keepsNewestTwoHundredPairsAndTheMaximum() {
        val l = NotifyLedger()
        for (i in 1L..250L) l.markShown(i, "i$i")
        assertEquals(200, l.state.shown.size)
        assertEquals(51L, l.state.shown.first().id)
        assertEquals(250L, l.state.shown.last().id)
        assertEquals(250L, l.since())
        assertEquals(Arrival.DUPLICATE, l.arrival(250, "i250"))
        assertEquals(Arrival.DUPLICATE, l.arrival(51, "i51"))
        assertEquals(Arrival.COUNTER_RESET, l.arrival(50, "i50"))
    }

    @Test fun lowerIdDoesNotLowerSince() {
        val l = NotifyLedger()
        l.markShown(10, "a")
        l.markShown(7, "b")
        assertEquals(10L, l.since())
    }

    @Test fun counterReset() {
        val l = NotifyLedger()
        l.markShown(900, "a")
        assertEquals(Arrival.COUNTER_RESET, l.arrival(1, "b"))
        assertEquals(Arrival.COUNTER_RESET, l.arrival(1, "a"))
        assertEquals(Arrival.COUNTER_RESET, l.arrival(900, "b"))
        assertEquals(Arrival.DUPLICATE, l.arrival(900, "a"))
        l.reset()
        assertEquals(0L, l.since())
        assertTrue(l.pendingAcks().isEmpty())
        assertEquals(Arrival.FRESH, l.arrival(1, "b"))
        assertEquals(emptyList<ShownNotify>(), l.state.shown)
        assertEquals(emptyList<String>(), l.state.needsYou)
    }

    @Test fun needsYouNotificationIsCancelledOnceWhenItLeavesNeedsYou() {
        val l = NotifyLedger()
        l.markShown(1, "q"); l.noteNeedsYou("q")
        assertEquals(emptyList<String>(), l.onInbox(setOf("q")))
        assertEquals(listOf("q"), l.onInbox(emptySet()))
        assertEquals(emptyList<String>(), l.onInbox(emptySet()))
    }

    @Test fun turnFinishedNoticeIsNeverCancelled() {
        val l = NotifyLedger()
        l.markShown(2, "t")
        assertEquals(emptyList<String>(), l.onInbox(emptySet()))
        assertEquals(emptyList<String>(), l.onInbox(emptySet()))
    }

    @Test fun notificationShownBeforeItsInboxRowArrivedIsTrackedThenCancelled() {
        val l = NotifyLedger()
        l.markShown(3, "r")
        assertEquals(emptyList<String>(), l.onInbox(setOf("r")))
        assertEquals(listOf("r"), l.onInbox(emptySet()))
    }

    @Test fun onlyTheLeavingItemIsCancelled() {
        val l = NotifyLedger()
        l.markShown(1, "a"); l.noteNeedsYou("a")
        l.markShown(2, "b"); l.noteNeedsYou("b")
        assertEquals(listOf("a"), l.onInbox(setOf("b")))
        assertEquals(listOf("b"), l.onInbox(setOf("c")))
    }

    @Test fun needsYouKeepsNewestTwoHundred() {
        val l = NotifyLedger()
        for (i in 1..250) l.noteNeedsYou("i$i")
        assertEquals(200, l.state.needsYou.size)
        assertEquals("i51", l.state.needsYou.first())
        assertEquals("i250", l.state.needsYou.last())
    }

    @Test fun stateSurvivesAReload() {
        val l = NotifyLedger()
        l.markShown(4, "a"); l.noteNeedsYou("a")
        val again = NotifyLedger(l.state)
        assertEquals(Arrival.DUPLICATE, again.arrival(4, "a"))
        assertEquals(listOf("a"), again.onInbox(emptySet()))
    }
}
