package ai.porthole.app.relay

import ai.porthole.app.MachineStore
import ai.porthole.shared.InboxItem
import ai.porthole.shared.MachineList
import ai.porthole.shared.WatchState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WatchRelayTest {
    private val desk = MachineList.defaults[0]
    private lateinit var store: MachineStore
    private val hostd = FakeHostd()
    private val wear = FakeWear()
    private val inbox = MutableStateFlow<Map<String, List<InboxItem>>>(emptyMap())
    private var percent = 40

    @Before
    fun setUp() {
        store = MachineStore(RuntimeEnvironment.getApplication())
        store.remove(MachineList.defaults[1].name)
        hostd.respond = { request ->
            check(request.url.endsWith("/v1/usage")) { "unexpected request ${request.url}" }
            200 to """{"windows":[{"id":"five_hour","usedPercent":$percent,"resetsAt":"2026-10-13T20:00:00Z","status":"ok"}]}"""
        }
    }

    private fun TestScope.relay() = WatchRelay(
        ctx = RuntimeEnvironment.getApplication(),
        inbox = inbox,
        host = hostd.client,
        machines = store,
        wear = wear,
        scope = backgroundScope,
        now = { currentTime },
    )

    private fun states(): List<WatchState> = wear.puts.map { checkNotNull(WatchState.decode(it)) }

    private fun usageRequests() = hostd.requestsTo("/v1/usage").size

    private suspend fun TestScope.pass(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    @Test
    fun startingWithAWatchPushesTheNeedsYouItemsAndTheUsageOnce() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a"), needsYou("w", column = "working")))

        relay().start()
        runCurrent()

        val pushed = states()
        assertEquals(1, pushed.size)
        assertEquals(listOf("a"), pushed[0].items.map { it.itemId })
        assertEquals(desk.origin, pushed[0].items[0].origin)
        assertEquals(listOf(40.0), pushed[0].usage.map { it.usedPercent })
        assertEquals(1, usageRequests())
    }

    @Test
    fun anInboxChangeThatLeavesTheWatchViewTheSameIsNotPushedButANewItemIs() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()

        inbox.value = mapOf(desk.origin to listOf(needsYou("a"), needsYou("w", column = "working")))
        runCurrent()
        assertEquals("a working item is invisible to the watch", 1, wear.puts.size)

        inbox.value = mapOf(desk.origin to listOf(needsYou("a"), needsYou("b", updatedAt = 9)))
        runCurrent()

        assertEquals(2, wear.puts.size)
        assertEquals(listOf("b", "a"), states().last().items.map { it.itemId })
        assertEquals("an inbox change does not re-read usage", 1, usageRequests())
    }

    @Test
    fun nothingIsReadOrPushedWhileNoWatchIsConnectedAndEverythingFollowsOnceOneIs() = runTest {
        wear.nodes = emptyList()
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()
        pass(5 * 60_000)
        pass(5 * 60_000)

        assertEquals(0, wear.puts.size)
        assertEquals(0, usageRequests())

        wear.nodes = listOf("watch-1")
        pass(5 * 60_000)

        assertEquals(1, wear.puts.size)
        assertEquals(1, usageRequests())
        assertEquals(listOf("a"), states()[0].items.map { it.itemId })
    }

    @Test
    fun usageIsReadEveryFiveMinutesAndPushedOnlyWhenItChanges() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()
        assertEquals(1, usageRequests())

        pass(4 * 60_000 + 59_000)
        assertEquals("not before five minutes", 1, usageRequests())

        percent = 55
        pass(1_000)
        assertEquals(2, usageRequests())
        assertEquals(listOf(40.0, 55.0), states().map { it.usage.single().usedPercent })

        pass(5 * 60_000)
        assertEquals("third read at ten minutes", 3, usageRequests())
        assertEquals("same usage, same items: no push", 2, wear.puts.size)
    }

    @Test
    fun aQuietConnectedPhoneStillRewritesTheStateWhenTheLastWriteIsTenMinutesOld() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()

        pass(5 * 60_000)
        assertEquals(1, wear.puts.size)
        pass(5 * 60_000)

        assertEquals(2, wear.puts.size)
        assertEquals(states()[0].items, states()[1].items)
        assertEquals(10 * 60_000L, states()[1].updatedAt - states()[0].updatedAt)
    }

    @Test
    fun aRefreshMessageReadsUsageAndPushesAtOnceEvenWhenNothingChanged() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        val relay = relay()
        relay.start()
        runCurrent()
        pass(30_000)

        relay.refresh()
        runCurrent()

        assertEquals(2, wear.puts.size)
        assertEquals(2, usageRequests())
        assertEquals(30_000L, states()[1].updatedAt - states()[0].updatedAt)
    }

    @Test
    fun aRefreshWhileStoppedDoesNothing() = runTest {
        val relay = relay()
        relay.refresh()
        runCurrent()

        assertEquals(0, wear.puts.size)
        assertEquals(0, usageRequests())
    }

    @Test
    fun aFailedWriteIsRetriedAtTheNextWakeEvenThoughNothingChangedSince() = runTest {
        wear.failPut = true
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()
        assertEquals(0, wear.puts.size)

        wear.failPut = false
        pass(5 * 60_000)

        assertEquals(1, wear.puts.size)
        assertEquals(listOf("a"), states()[0].items.map { it.itemId })
    }

    @Test
    fun aMachineWhoseUsageCallFailsKeepsItsLastWindows() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        relay().start()
        runCurrent()
        hostd.respond = { throw java.io.IOException("offline") }

        inbox.value = mapOf(desk.origin to listOf(needsYou("a"), needsYou("b", updatedAt = 9)))
        pass(5 * 60_000)

        assertEquals(2, usageRequests())
        assertTrue(wear.puts.size >= 2)
        assertEquals(listOf(40.0), states().last().usage.map { it.usedPercent })
        assertEquals(listOf("b", "a"), states().last().items.map { it.itemId })
    }

    @Test
    fun stopEndsTheObservingAndThePolling() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        val relay = relay()
        relay.start()
        runCurrent()
        relay.stop()

        inbox.value = mapOf(desk.origin to listOf(needsYou("a"), needsYou("b", updatedAt = 9)))
        pass(30 * 60_000)

        assertEquals(1, wear.puts.size)
        assertEquals(1, usageRequests())
    }

    @Test
    fun startingTwiceRunsOneRelay() = runTest {
        inbox.value = mapOf(desk.origin to listOf(needsYou("a")))
        val relay = relay()
        relay.start()
        relay.start()
        runCurrent()
        pass(5 * 60_000)

        assertEquals("one usage poll per tick, one write", 2, usageRequests())
        assertEquals(1, wear.puts.size)
    }
}
