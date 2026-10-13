package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyPlannerTest {
    private val m = Machine("desk", "https://desk.example.ts.net")
    private fun n(opts: Int, title: String = "t", body: String = "b", itemId: String = "item-1") =
        ServerEvent.Notify(1, itemId, title, body, List(opts) { NotifyOption(it, "o$it") })

    @Test fun twoOrThreeOptionsGiveAtMostTwoAnswerButtons() {
        assertEquals(listOf("o0", "o1"), NotifyPlanner.plan(n(2), m).answers.map { it.label })
        assertEquals(listOf("o0", "o1"), NotifyPlanner.plan(n(3), m).answers.map { it.label })
    }

    @Test fun otherCountsGiveOpenOnly() {
        for (k in listOf(0, 1, 4, 6)) assertEquals(emptyList<NotifyOption>(), NotifyPlanner.plan(n(k), m).answers)
    }

    @Test fun textIsCutToSpecLimits() {
        val p = NotifyPlanner.plan(n(0, "x".repeat(200), "y".repeat(500)), m)
        assertEquals(80, p.title.length); assertEquals('…', p.title.last())
        assertEquals(200, p.body.length); assertEquals('…', p.body.last())
        assertEquals("x".repeat(79), p.title.dropLast(1))
    }

    @Test fun textWithinLimitsIsKept() {
        val p = NotifyPlanner.plan(n(0, "x".repeat(80), "y".repeat(200)), m)
        assertEquals("x".repeat(80), p.title)
        assertEquals("y".repeat(200), p.body)
    }

    @Test fun cutNeverSplitsASurrogatePair() {
        // 78 letters then an emoji (2 chars): a cut at 79 would leave a lone high surrogate.
        val title = "x".repeat(78) + "\uD83D\uDE00" + "z".repeat(50)
        val p = NotifyPlanner.plan(n(0, title), m)
        assertTrue(p.title.length <= 80)
        assertEquals('…', p.title.last())
        assertTrue(!Character.isHighSurrogate(p.title[p.title.length - 2]))
        assertEquals("x".repeat(78) + "…", p.title)
    }

    @Test fun sameItemReplacesItsNotification() {
        assertEquals(NotifyPlanner.plan(n(2), m).id, NotifyPlanner.plan(n(3), m).id)
        assertEquals("https://desk.example.ts.net", NotifyPlanner.plan(n(2), m).tag)
    }

    @Test fun differentItemsGetDifferentIds() {
        assertTrue(NotifyPlanner.plan(n(0, itemId = "a"), m).id != NotifyPlanner.plan(n(0, itemId = "b"), m).id)
        assertEquals("item-1".hashCode(), NotifyPlanner.plan(n(0), m).id)
    }

    @Test fun planCarriesMachineNameAndIdentifiers() {
        val p = NotifyPlanner.plan(ServerEvent.Notify(42, "q-9", "T", "B", emptyList()), m)
        assertEquals("desk", p.subText)
        assertEquals("q-9", p.itemId)
        assertEquals(42L, p.notifyId)
    }
}
