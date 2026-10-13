package ai.porthole.app.relay

import ai.porthole.shared.Machine
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.shared.WatchUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayLogicTest {
    private val desk = Machine("desk", "https://desk.example.ts.net")
    private val laptop = Machine("laptop", "https://laptop.example.ts.net")

    private fun item(id: String, updatedAt: Long = 10) = WatchItem(
        origin = desk.origin,
        machine = "desk",
        itemId = id,
        sessionId = "tmux:s:$id",
        project = "proj",
        title = "Title $id",
        question = "Proceed?",
        options = listOf("Yes", "No"),
        multi = false,
        updatedAt = updatedAt,
    )

    private fun usage(percent: Double) = WatchUsage("desk", "five_hour", percent, null)

    private fun state(updatedAt: Long, items: List<WatchItem>, usage: List<WatchUsage> = emptyList()) =
        WatchState(updatedAt, items, usage)

    @Test
    fun theFirstStateIsAlwaysPushed() {
        assertTrue(RelayLogic.shouldPush(null, state(1, emptyList())))
    }

    @Test
    fun sameItemsAndUsageWithANewUpdatedAtAreNotPushed() {
        val prev = state(1_000, listOf(item("a"), item("b")), listOf(usage(40.0)))
        val next = state(999_000, listOf(item("a"), item("b")), listOf(usage(40.0)))

        assertFalse(RelayLogic.shouldPush(prev, next))
    }

    @Test
    fun aNewItemIsPushed() {
        val prev = state(1, listOf(item("a")))
        val next = state(2, listOf(item("a"), item("b")))

        assertTrue(RelayLogic.shouldPush(prev, next))
    }

    @Test
    fun aRemovedItemIsPushed() {
        assertTrue(RelayLogic.shouldPush(state(1, listOf(item("a"), item("b"))), state(2, listOf(item("a")))))
    }

    @Test
    fun anItemWhoseOwnUpdatedAtChangedIsPushed() {
        assertTrue(RelayLogic.shouldPush(state(1, listOf(item("a", 10))), state(1, listOf(item("a", 11)))))
    }

    @Test
    fun changedUsageIsPushedAndTheSameUsageIsNot() {
        val prev = state(1, listOf(item("a")), listOf(usage(40.0)))

        assertTrue(RelayLogic.shouldPush(prev, state(2, listOf(item("a")), listOf(usage(41.0)))))
        assertFalse(RelayLogic.shouldPush(prev, state(2, listOf(item("a")), listOf(usage(40.0)))))
    }

    @Test
    fun anOptionAnswerBecomesAnAnswerCallOnTheMachineWithThatOrigin() {
        val a = WatchAnswer.Option("r1", laptop.origin, "item-9", listOf(1))

        assertEquals(RelayCall.Answer(laptop, "item-9", listOf(1)), RelayLogic.answerToCall(a, listOf(desk, laptop)))
    }

    @Test
    fun anOptionAnswerForAnUnknownOriginIsNull() {
        val a = WatchAnswer.Option("r1", "https://gone.example.ts.net", "item-9", listOf(0))

        assertNull(RelayLogic.answerToCall(a, listOf(desk, laptop)))
    }

    @Test
    fun aStopAnswerBecomesAStopCallAndAnUnknownOriginIsNullToo() {
        val known = WatchAnswer.Stop("r2", desk.origin, "tmux:s:1")
        val unknown = WatchAnswer.Stop("r3", "https://gone.example.ts.net", "tmux:s:1")

        assertEquals(RelayCall.Stop(desk, "tmux:s:1"), RelayLogic.answerToCall(known, listOf(desk, laptop)))
        assertNull(RelayLogic.answerToCall(unknown, listOf(desk, laptop)))
    }
}
