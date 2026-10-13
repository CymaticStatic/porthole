package ai.porthole.wear.ui

import ai.porthole.shared.Machine
import ai.porthole.shared.Routes
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.shared.WatchUsage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakePort(var reply: (WatchAnswer) -> WatchAnswerResult = { WatchAnswerResult(it.requestId, true, "Sent: Yes") }) : AnswerPort {
    val answered = mutableListOf<WatchAnswer>()
    var refreshes = 0
    var gate: CompletableDeferred<Unit>? = null

    override suspend fun answer(a: WatchAnswer): WatchAnswerResult {
        answered += a
        gate?.await()
        return reply(a)
    }

    override suspend fun refresh() {
        refreshes++
    }
}

private class FakeOpener(var ok: Boolean = true) : PhoneOpener {
    val opened = mutableListOf<String>()

    override suspend fun open(uri: String): Boolean {
        opened += uri
        return ok
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class InboxModelTest {
    private val origin = "https://desk.example.ts.net"

    private fun item(
        id: String,
        updatedAt: Long,
        options: List<String> = listOf("Yes", "No"),
        multi: Boolean = false,
        sessionId: String = "tmux:t:main:0.0",
    ) = WatchItem(
        origin = origin,
        machine = "desk",
        itemId = id,
        sessionId = sessionId,
        project = "porthole",
        title = "Title $id",
        question = "Question $id?",
        options = options,
        multi = multi,
        updatedAt = updatedAt,
    )

    private val now = 100 * 60_000L
    private var clockNow = now
    private val state = MutableStateFlow<WatchState?>(null)
    private val port = FakePort()
    private val opener = FakeOpener()
    private var ids = 0

    private fun model() = InboxModel(
        source = state,
        isStale = { at -> state.value?.let { at - it.updatedAt > 15 * 60_000L } ?: false },
        port = port,
        opener = opener,
        clock = { clockNow },
        requestIds = { "req-${++ids}" },
    )

    private fun publish(items: List<WatchItem>, updatedAt: Long = now, usage: List<WatchUsage> = emptyList()) {
        state.value = WatchState(updatedAt, items, usage)
    }

    @Test
    fun threeItemsListNewestFirst() {
        publish(listOf(item("old", 1_000), item("newest", 3_000), item("middle", 2_000)))

        val view = model().inbox()

        assertEquals(listOf("newest", "middle", "old"), view.items.map { it.itemId })
        assertNull(view.emptyMessage)
    }

    @Test
    fun emptyStateReadsNothingWaiting() {
        publish(emptyList())
        assertEquals("Nothing waiting", model().inbox().emptyMessage)
    }

    @Test
    fun noStateYetAlsoReadsNothingWaitingAndIsNotStale() {
        val view = model().inbox()

        assertEquals("Nothing waiting", view.emptyMessage)
        assertNull(view.updatedLine)
    }

    @Test
    fun freshStateHasNoUpdatedLine() {
        publish(listOf(item("a", 1)), updatedAt = now - 14 * 60_000L)
        assertNull(model().inbox().updatedLine)
    }

    @Test
    fun staleStateCarriesTheUpdatedLine() {
        publish(listOf(item("a", 1)), updatedAt = now - 3 * 60_000L - 16 * 60_000L)

        assertEquals("Updated 19 min ago", model().inbox().updatedLine)
    }

    @Test
    fun theUpdatedLineFollowsTheClock() {
        publish(listOf(item("a", 1)), updatedAt = now - 20 * 60_000L)
        val model = model()
        assertEquals("Updated 20 min ago", model.inbox().updatedLine)

        clockNow += 5 * 60_000L

        assertEquals("Updated 25 min ago", model.inbox().updatedLine)
    }

    @Test
    fun tappingOptionOneSendsTheChosenIndexOnceAndMovesToResult() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()

        val result = model.choose(model.item("i1")!!, 1)

        assertEquals(listOf<WatchAnswer>(WatchAnswer.Option("req-1", origin, "i1", listOf(1))), port.answered)
        assertEquals(ResultView(ok = true, message = "Sent: Yes"), result)
        assertEquals(result, model.result.value)
        assertFalse(model.busy.value)
    }

    @Test
    fun aRefusedAnswerShowsThePhonesReason() = runTest {
        publish(listOf(item("i1", 1_000)))
        port.reply = { WatchAnswerResult(it.requestId, false, "no such option") }
        val model = model()

        val result = model.choose(model.item("i1")!!, 0)

        assertEquals(ResultView(ok = false, message = "no such option"), result)
    }

    @Test
    fun anOptionIndexTheItemDoesNotHaveSendsNothing() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()

        assertNull(model.choose(model.item("i1")!!, 2))
        assertNull(model.choose(model.item("i1")!!, -1))

        assertTrue(port.answered.isEmpty())
    }

    @Test
    fun aSecondTapWhileTheFirstIsInFlightIsIgnored() = runTest {
        publish(listOf(item("i1", 1_000)))
        port.gate = CompletableDeferred()
        val model = model()
        val first = async { model.choose(model.item("i1")!!, 0) }
        runCurrent()
        assertTrue(model.busy.value)

        val second = model.choose(model.item("i1")!!, 1)
        port.gate!!.complete(Unit)

        assertNull(second)
        assertEquals(true, first.await()?.ok)
        assertEquals(1, port.answered.size)
        assertFalse(model.busy.value)
    }

    @Test
    fun multiSelectItemOffersNoOptionButtons() = runTest {
        publish(listOf(item("multi", 1_000, options = listOf("A", "B", "C"), multi = true)))
        val model = model()
        val multi = model.item("multi")!!

        assertEquals(emptyList<String>(), model.optionsOf(multi))
        assertNull(model.choose(multi, 0))
        assertTrue(port.answered.isEmpty())
    }

    @Test
    fun aSingleSelectItemOffersItsOptionsInOrder() {
        publish(listOf(item("i1", 1_000, options = listOf("Yes", "No", "Later"))))
        val model = model()

        assertEquals(listOf("Yes", "No", "Later"), model.optionsOf(model.item("i1")!!))
    }

    @Test
    fun stopSendsNothingUntilTheConfirmIsAccepted() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()
        val item = model.item("i1")!!

        assertNull(model.confirmStop(item))
        assertTrue(port.answered.isEmpty())

        model.requestStop(item)
        assertEquals("i1", model.stopPending.value)
        assertTrue(port.answered.isEmpty())

        val result = model.confirmStop(item)

        assertEquals(listOf<WatchAnswer>(WatchAnswer.Stop("req-1", origin, "tmux:t:main:0.0")), port.answered)
        assertEquals(true, result?.ok)
        assertNull(model.stopPending.value)
    }

    @Test
    fun cancellingTheConfirmSendsNothingAndAConfirmAfterwardsDoesNothing() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()
        val item = model.item("i1")!!

        model.requestStop(item)
        model.cancelStop()

        assertNull(model.stopPending.value)
        assertNull(model.confirmStop(item))
        assertTrue(port.answered.isEmpty())
    }

    @Test
    fun aConfirmForAnotherItemDoesNotStopThatItemsSession() = runTest {
        publish(listOf(item("i1", 1_000), item("i2", 2_000, sessionId = "tmux:t:other:1.0")))
        val model = model()

        model.requestStop(model.item("i1")!!)

        assertNull(model.confirmStop(model.item("i2")!!))
        assertTrue(port.answered.isEmpty())
        assertEquals("i1", model.stopPending.value)
    }

    @Test
    fun phoneNotConnectedShowsInTheHeaderUntilALaterSendReachesThePhone() = runTest {
        publish(listOf(item("i1", 1_000)))
        port.reply = { WatchAnswerResult(it.requestId, false, "Phone not connected") }
        val model = model()
        assertFalse(model.inbox().phoneNotConnected)

        model.choose(model.item("i1")!!, 0)

        assertTrue(model.inbox().phoneNotConnected)

        port.reply = { WatchAnswerResult(it.requestId, true, "Sent: Yes") }
        model.choose(model.item("i1")!!, 0)

        assertFalse(model.inbox().phoneNotConnected)
    }

    @Test
    fun aRefusalFromTheReachedPhoneIsNotPhoneNotConnected() = runTest {
        publish(listOf(item("i1", 1_000)))
        port.reply = { WatchAnswerResult(it.requestId, false, "Phone didn't answer") }
        val model = model()

        model.choose(model.item("i1")!!, 0)

        assertFalse(model.inbox().phoneNotConnected)
    }

    @Test
    fun openOnPhoneUriIsTheOpenLinkForTheChatRoute() {
        val item = item("i1", 1, sessionId = "tmux:t:main:0.0")

        val uri = InboxModel.openOnPhoneUri(item)

        assertEquals(Routes.openLink("https://desk.example.ts.net", "#/chat/desk/tmux%3At%3Amain%3A0.0"), uri)
        assertTrue(uri.startsWith("porthole://open?"))
        assertEquals(
            "https://desk.example.ts.net/#/chat/desk/tmux%3At%3Amain%3A0.0",
            Routes.parseOpenLink(uri, listOf(Machine("desk", "https://desk.example.ts.net"))),
        )
    }

    @Test
    fun openOnPhoneHandsTheUriToTheOpenerAndReportsTheOutcome() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()
        val item = model.item("i1")!!

        val ok = model.openOnPhone(item)

        assertEquals(listOf(InboxModel.openOnPhoneUri(item)), opener.opened)
        assertEquals(ResultView(ok = true, message = "Opened on phone"), ok)

        opener.ok = false
        val failed = model.openOnPhone(item)

        assertEquals(ResultView(ok = false, message = "Couldn't open on phone"), failed)
        assertEquals(failed, model.result.value)
    }

    @Test
    fun clearResultDropsTheResult() = runTest {
        publish(listOf(item("i1", 1_000)))
        val model = model()
        model.choose(model.item("i1")!!, 0)

        model.clearResult()

        assertNull(model.result.value)
    }

    @Test
    fun usageRowsShowPercentAndResetTime() {
        publish(
            items = emptyList(),
            usage = listOf(
                WatchUsage("desk", "5h", 72.4, "1970-01-01T03:00:00.000Z"),
                WatchUsage("laptop", "7d", 9.6, null),
            ),
        )
        clockNow = 100 * 60_000L // 01:40 UTC, so 80 min before the first reset

        val rows = model().usage().rows

        assertEquals(
            listOf(
                UsageRow("desk", "5-hour", "72%", "Resets in 1 h 20 min"),
                UsageRow("laptop", "7-day", "10%", null),
            ),
            rows,
        )
    }

    @Test
    fun usageResetInThePastReadsResettingNow() {
        publish(emptyList(), usage = listOf(WatchUsage("desk", "5h", 10.0, "1970-01-01T00:30:00Z")))

        assertEquals("Resetting now", model().usage().rows.single().reset)
    }

    @Test
    fun noUsageReadsNoUsageYet() {
        publish(emptyList())

        val usage = model().usage()

        assertTrue(usage.rows.isEmpty())
        assertEquals("No usage yet", usage.emptyMessage)
    }

    @Test
    fun refreshAsksThePhone() = runTest {
        model().refresh()

        assertEquals(1, port.refreshes)
    }
}
