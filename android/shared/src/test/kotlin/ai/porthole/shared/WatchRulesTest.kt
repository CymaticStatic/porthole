package ai.porthole.shared

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WatchRulesTest {
    private val desk = Machine("desk", "https://desk.example.ts.net")
    private val lap = Machine("lap", "https://lap.example.ts.net")

    private fun q(text: String = "Yes or no?", multi: Boolean = false) =
        Question("q", 1, text, listOf("Yes", "No"), multi, 2, true)

    private fun item(
        id: String,
        updatedAt: Long,
        column: String = "needs-you",
        archivedAt: Long? = null,
        question: Question? = q(),
        machine: String = "desk",
    ) = InboxItem(
        id, "key-$id", "tmux:t:main:$id", machine, "proj", "omp", column, "Title $id", "body",
        question, null, 1, updatedAt, null, archivedAt,
    )

    @Test fun onlyUnarchivedNeedsYouRemainNewestFirstAcrossMachines() {
        val s = WatchRules.build(
            500,
            mapOf(
                desk to listOf(
                    item("a", 10), item("b", 40), item("w", 99, column = "working"),
                    item("d", 98, column = "done"), item("x", 97, archivedAt = 5),
                ),
                lap to listOf(item("c", 30, machine = "lap"), item("m", 20, question = q(multi = true), machine = "lap")),
            ),
            emptyMap(),
        )
        assertEquals(listOf("b", "c", "m", "a"), s.items.map { it.itemId })
        assertEquals(500L, s.updatedAt)
        assertEquals(listOf(desk.origin, lap.origin, lap.origin, desk.origin), s.items.map { it.origin })
        assertEquals(listOf("desk", "lap", "lap", "desk"), s.items.map { it.machine })
    }

    @Test fun multiSelectItemHasNoOptionsButKeepsItsQuestion() {
        val s = WatchRules.build(1, mapOf(desk to listOf(item("m", 1, question = q("Pick some", multi = true)))), emptyMap())
        val it = s.items.single()
        assertEquals(emptyList<String>(), it.options)
        assertTrue(it.multi)
        assertEquals("Pick some", it.question)
    }

    @Test fun singleSelectKeepsOptionsAndIdentifiers() {
        val it = WatchRules.build(1, mapOf(desk to listOf(item("a", 1))), emptyMap()).items.single()
        assertEquals(listOf("Yes", "No"), it.options)
        assertEquals(false, it.multi)
        assertEquals("a", it.itemId)
        assertEquals("tmux:t:main:a", it.sessionId)
        assertEquals("proj", it.project)
        assertEquals("Title a", it.title)
        assertEquals(1L, it.updatedAt)
    }

    @Test fun itemWithoutQuestionHasNullQuestionAndNoOptions() {
        val it = WatchRules.build(1, mapOf(desk to listOf(item("a", 1, question = null))), emptyMap()).items.single()
        assertEquals(null, it.question)
        assertEquals(emptyList<String>(), it.options)
        assertEquals(false, it.multi)
    }

    @Test fun fortyItemsGiveThirtyNewest() {
        val list = (1..40).map { item("i$it", it.toLong()) }
        val s = WatchRules.build(1, mapOf(desk to list), emptyMap())
        assertEquals(30, s.items.size)
        assertEquals("i40", s.items.first().itemId)
        assertEquals("i11", s.items.last().itemId)
    }

    @Test fun questionTextIsCutToThreeHundredCharacters() {
        val long = WatchRules.build(1, mapOf(desk to listOf(item("a", 1, question = q("z".repeat(1000))))), emptyMap())
            .items.single().question!!
        assertEquals(300, long.length)
        assertEquals('…', long.last())
        val exact = WatchRules.build(1, mapOf(desk to listOf(item("a", 1, question = q("z".repeat(300))))), emptyMap())
            .items.single().question!!
        assertEquals("z".repeat(300), exact)
    }

    @Test fun hugeQuestionStillEncodesUnderTheByteLimit() {
        val s = WatchRules.build(1, mapOf(desk to listOf(item("a", 1, question = q("é".repeat(100_000))))), emptyMap())
        assertEquals(1, s.items.size)
        assertTrue(s.encode().size < WatchRules.MAX_BYTES)
    }

    @Test fun itemsAreDroppedFromTheEndWhenTheStateIsTooBig() {
        // 30 items whose option lists alone are about 5 kB each: 150 kB, over the 90 000-byte limit.
        val bigOptions = List(50) { "option-" + "o".repeat(90) }
        val list = (1..30).map {
            item("i$it", it.toLong(), question = Question("q", 1, "?", bigOptions, false, 50, true))
        }
        val s = WatchRules.build(1, mapOf(desk to list), emptyMap())
        assertTrue(s.encode().size <= WatchRules.MAX_BYTES)
        assertTrue(s.items.isNotEmpty() && s.items.size < 30)
        assertEquals("i30", s.items.first().itemId)
        assertEquals((30 downTo 30 - s.items.size + 1).map { "i$it" }, s.items.map { it.itemId })
    }

    @Test fun usageWindowsWithAPercentAreKept() {
        val u = Usage(
            listOf(
                UsageWindow("5h", 72.5, JsonPrimitive("2026-10-13T20:00:00Z"), "ok"),
                UsageWindow("7d", null, null, "unknown"),
                UsageWindow("opus", 10.0, JsonNull, null),
                UsageWindow("epoch", 5.0, JsonPrimitive(1_700_000_000), null),
            ),
        )
        val s = WatchRules.build(1, emptyMap(), mapOf(desk to u, lap to Usage(listOf(UsageWindow("5h", 3.0)))))
        assertEquals(
            listOf(
                WatchUsage("desk", "5h", 72.5, "2026-10-13T20:00:00Z"),
                WatchUsage("desk", "opus", 10.0, null),
                WatchUsage("desk", "epoch", 5.0, "1700000000"),
                WatchUsage("lap", "5h", 3.0, null),
            ),
            s.usage,
        )
    }

    @Test fun emptyInputsGiveAnEmptyState() {
        assertEquals(WatchState(7, emptyList(), emptyList()), WatchRules.build(7, emptyMap(), emptyMap()))
    }

    @Test fun builtStateRoundTrips() {
        val s = WatchRules.build(9, mapOf(desk to listOf(item("a", 1))), mapOf(desk to Usage(listOf(UsageWindow("5h", 1.0)))))
        assertEquals(s, WatchState.decode(s.encode()))
    }
}
