package ai.porthole.app.net

import ai.porthole.shared.LedgerState
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.ServerEvent
import ai.porthole.shared.ShownNotify
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The reconnect schedule runs in `kotlinx-coroutines-test` virtual time, the WebSocket itself on real OkHttp threads, so
 * every test pumps the test dispatcher by hand ([TestScope.await]) and never suspends while it waits for the network.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EventsSocketTest {
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private lateinit var origin: String
    private val serverSockets = LinkedBlockingQueue<WebSocket>()
    private val serverReceived = LinkedBlockingQueue<String>()
    private var socket: EventsSocket? = null

    private val events = mutableListOf<ServerEvent>()
    private val states = mutableListOf<Online>()

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
        origin = "http://${server.hostName}:${server.port}"
        machine = Machine("test", origin)
    }

    @After
    fun stopEverything() {
        socket?.stop()
        runCatching { server.close() } // a test may already have closed it
    }

    private fun upgrades(count: Int) {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSockets.add(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                serverReceived.add(text)
            }
        }
        repeat(count) { server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build()) }
    }

    private fun TestScope.open(
        ledger: NotifyLedger = NotifyLedger(),
        onEvent: (ServerEvent) -> Unit = { events += it },
    ): EventsSocket = EventsSocket(
        http = Http.create(),
        machine = machine,
        device = "bencell",
        ledger = ledger,
        scope = backgroundScope,
        onEvent = onEvent,
        onState = { states += it },
        urlFor = { since -> "$origin/v1/events?device=bencell&since=$since" },
    ).also { socket = it }

    private fun TestScope.await(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (true) {
            runCurrent()
            if (condition()) return
            check(System.nanoTime() < deadline) { "timed out waiting for: $what" }
            Thread.sleep(5)
        }
    }

    /** Lets any pending network work happen so a "nothing happened" assertion can mean something. */
    private fun TestScope.settle() {
        repeat(15) {
            runCurrent()
            Thread.sleep(10)
        }
    }

    /** Waits for something the server side produced; the app's coroutines only run when this pumps the test dispatcher. */
    private fun <T : Any> TestScope.take(what: String, poll: () -> T?): T {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (true) {
            runCurrent()
            poll()?.let { return it }
            check(System.nanoTime() < deadline) { "timed out waiting for: $what" }
            Thread.sleep(5)
        }
    }

    private fun TestScope.nextServerSocket(): WebSocket = take("server-side socket") { serverSockets.poll() }

    private fun TestScope.nextRequest(): RecordedRequest = take("upgrade request") { server.takeRequest(0, TimeUnit.MILLISECONDS) }

    private fun TestScope.nextServerText(): String = take("text frame at the server") { serverReceived.poll() }

    private fun notify(id: Long, itemId: String = "item-$id") =
        """{"type":"notify","id":$id,"itemId":"$itemId","title":"T","body":"B","options":[{"index":0,"label":"Yes"}]}"""

    private fun TestScope.closeFromServerAndAwaitDisconnect() {
        val before = states.size
        nextServerSocket().close(1000, "bye")
        await("disconnected after the server closed") { states.size > before && states.last() == Online.DISCONNECTED }
    }

    private fun TestScope.requestCount() = server.requestCount

    @Test
    fun theUpgradeCarriesTheExactOriginTheHeaderAndSinceZero() = runTest {
        upgrades(1)
        open().start()
        val request = nextRequest()
        assertEquals(origin, request.headers["Origin"])
        assertEquals("1", request.headers["X-Porthole"])
        assertEquals("/v1/events?device=bencell&since=0", request.target)
        assertEquals("GET", request.method)
        await("connected") { states == listOf(Online.CONNECTED) }
    }

    @Test
    fun aNotifyIsAckedAfterOnEventReturns() = runTest {
        upgrades(1)
        var ackAlreadySentInsideOnEvent = true
        val ledger = NotifyLedger()
        open(ledger) {
            ackAlreadySentInsideOnEvent = serverReceived.isNotEmpty()
            events += it
            if (it is ServerEvent.Notify) ledger.markShown(it.id, it.itemId)
        }.start()
        nextServerSocket().send(notify(7, "i1"))
        assertEquals("""{"type":"ack","id":7}""", nextServerText())
        await("ledger shows the ack") { ledger.state.unacked.isEmpty() }
        assertFalse("the ack went out before onEvent returned", ackAlreadySentInsideOnEvent)
        assertEquals(1, events.size)
        assertEquals(ServerEvent.Notify(7, "i1", "T", "B", listOf(ai.porthole.shared.NotifyOption(0, "Yes"))), events.single())
        assertEquals(7L, ledger.since())
    }

    @Test
    fun aNotifyTheConsumerFailedOnIsNotAckedAndTheSocketStaysOpen() = runTest {
        upgrades(1)
        var calls = 0
        open {
            calls++
            if (calls == 1) error("consumer blew up")
            events += it
        }.start()
        val serverSocket = nextServerSocket()
        serverSocket.send(notify(1))
        await("first event delivered") { calls == 1 }
        settle()
        assertTrue("no ack for a notify nobody handled", serverReceived.isEmpty())
        serverSocket.send(notify(2))
        assertEquals("""{"type":"ack","id":2}""", nextServerText())
        assertEquals(1, requestCount())
    }

    @Test
    fun aDuplicateNotifyTheLedgerAlreadySawIsAckedAgain() = runTest {
        upgrades(1)
        val ledger = NotifyLedger(LedgerState(highest = 7, shown = listOf(ShownNotify(7, "i1"))))
        open(ledger).start()
        assertEquals("/v1/events?device=bencell&since=7", nextRequest().target)
        nextServerSocket().send(notify(7, "i1"))
        assertEquals("""{"type":"ack","id":7}""", nextServerText())
    }

    @Test
    fun aServerCloseReconnectsAfterOneTwoAndFourSecondsAndAsksForSinceSeven() = runTest {
        upgrades(4)
        val ledger = NotifyLedger()
        open(ledger) {
            events += it
            if (it is ServerEvent.Notify) ledger.markShown(it.id, it.itemId)
        }.start()
        assertEquals("/v1/events?device=bencell&since=0", nextRequest().target)
        nextServerSocket().let { first ->
            first.send(notify(7, "i1"))
            assertEquals("""{"type":"ack","id":7}""", nextServerText())
            first
        }.close(1000, "bye")
        val firstDown = { states.size >= 2 && states.last() == Online.DISCONNECTED }
        await("first disconnect", firstDown)
        assertEquals(1, requestCount())

        advanceTimeBy(999)
        settle()
        assertEquals("no reconnect before 1 s", 1, requestCount())
        advanceTimeBy(1)
        await("reconnect at 1 s") { requestCount() == 2 }
        assertEquals("/v1/events?device=bencell&since=7", nextRequest().target)
        await("connected again") { states.last() == Online.CONNECTED }

        closeFromServerAndAwaitDisconnect()
        advanceTimeBy(1999)
        settle()
        assertEquals("no reconnect before 2 s more", 2, requestCount())
        advanceTimeBy(1)
        await("reconnect at 2 s") { requestCount() == 3 }
        await("connected a third time") { states.last() == Online.CONNECTED }

        closeFromServerAndAwaitDisconnect()
        advanceTimeBy(3999)
        settle()
        assertEquals("no reconnect before 4 s more", 3, requestCount())
        advanceTimeBy(1)
        await("reconnect at 4 s") { requestCount() == 4 }
    }

    @Test
    fun aMessageResetsTheBackoffSoTheNextReconnectWaitsOneSecondAgain() = runTest {
        upgrades(3)
        open().start()
        nextServerSocket().close(1000, "bye")
        await("first disconnect") { states.size >= 2 }
        advanceTimeBy(1000)
        await("second connection") { requestCount() == 2 }
        val second = nextServerSocket()
        second.send(notify(3))
        assertEquals("""{"type":"ack","id":3}""", nextServerText())
        second.close(1000, "bye")
        await("second disconnect") { states.size >= 4 && states.last() == Online.DISCONNECTED }
        advanceTimeBy(999)
        settle()
        assertEquals(2, requestCount())
        advanceTimeBy(1)
        await("third connection after 1 s, not 2 s") { requestCount() == 3 }
    }

    @Test
    fun anAckThatNeverWentOutIsResentFirstOnTheNextOpen() = runTest {
        upgrades(2)
        val ledger = NotifyLedger(LedgerState(highest = 5, shown = listOf(ShownNotify(5, "i5")), unacked = listOf(5)))
        open(ledger).start()
        assertEquals("/v1/events?device=bencell&since=5", nextRequest().target)
        val first = nextServerSocket()
        assertEquals("""{"type":"ack","id":5}""", nextServerText())
        await("ledger marks 5 acked") { ledger.state.unacked.isEmpty() }
        first.send(notify(6, "i6"))
        assertEquals("""{"type":"ack","id":6}""", nextServerText())
        // Simulate a lost ack: the ledger still has 6 open when the connection drops.
        ledger.markShown(6, "i6")
        val before = states.size
        first.close(1000, "bye")
        await("disconnected") { states.size > before && states.last() == Online.DISCONNECTED }
        advanceTimeBy(1000)
        await("reconnect") { requestCount() == 2 }
        assertEquals("/v1/events?device=bencell&since=6", nextRequest().target)
        assertEquals("""{"type":"ack","id":6}""", nextServerText())
    }

    @Test
    fun nudgeDuringAFourSecondWaitReconnectsAtOnce() = runTest {
        upgrades(4)
        open().start()
        // Nothing is ever sent, so the backoff is never reset: waits are 1 s, 2 s, 4 s.
        closeFromServerAndAwaitDisconnect()
        advanceTimeBy(1000)
        await("second connection") { requestCount() == 2 && states.last() == Online.CONNECTED }
        closeFromServerAndAwaitDisconnect()
        advanceTimeBy(2000)
        await("third connection") { requestCount() == 3 && states.last() == Online.CONNECTED }
        closeFromServerAndAwaitDisconnect()
        advanceTimeBy(1000)
        settle()
        assertEquals("still inside the 4 s wait", 3, requestCount())
        socket!!.nudge()
        await("reconnect without waiting") { requestCount() == 4 }
    }

    @Test
    fun nudgeWhileConnectedChangesNothing() = runTest {
        upgrades(1)
        open().start()
        await("connected") { states == listOf(Online.CONNECTED) }
        socket!!.nudge()
        settle()
        assertEquals(1, requestCount())
        assertEquals(listOf(Online.CONNECTED), states)
    }

    @Test
    fun aMalformedMessageAndAnUnknownEventAreDroppedWithoutClosingTheSocket() = runTest {
        upgrades(1)
        open().start()
        val serverSocket = nextServerSocket()
        serverSocket.send("this is not json")
        serverSocket.send("""{"type":"from-the-future","x":1}""")
        serverSocket.send("""{"type":"notify","id":"not-a-number"}""")
        serverSocket.send(notify(9, "i9"))
        assertEquals("""{"type":"ack","id":9}""", nextServerText())
        assertTrue("nothing else was acked", serverReceived.isEmpty())
        assertEquals(listOf(9L), events.map { (it as ServerEvent.Notify).id })
        assertEquals(1, requestCount())
        assertEquals(listOf(Online.CONNECTED), states)
    }

    @Test
    fun inboxAndSessionsEventsAreDeliveredWithoutAnAck() = runTest {
        upgrades(1)
        open().start()
        val serverSocket = nextServerSocket()
        serverSocket.send("""{"type":"sessions","tree":{"machines":[]}}""")
        serverSocket.send("""{"type":"inbox","items":[]}""")
        await("both events delivered") { events.size == 2 }
        assertTrue(events[0] is ServerEvent.Sessions)
        assertEquals(ServerEvent.Inbox(emptyList()), events[1])
        settle()
        assertTrue(serverReceived.isEmpty())
    }

    @Test
    fun stopClosesTheSocketReportsDisconnectedAndNeverReconnects() = runTest {
        upgrades(2)
        open().start()
        await("connected") { states == listOf(Online.CONNECTED) }
        val serverSocket = nextServerSocket()
        socket!!.stop()
        assertEquals(listOf(Online.CONNECTED, Online.DISCONNECTED), states)
        advanceTimeBy(60_000)
        settle()
        assertEquals(1, requestCount())
        // The server notices the client went away: sending now has no effect on the app.
        serverSocket.send(notify(1))
        settle()
        assertTrue(events.isEmpty())
    }

    @Test
    fun startingTwiceOpensOnlyOneConnection() = runTest {
        upgrades(2)
        val s = open()
        s.start()
        s.start()
        await("connected") { states == listOf(Online.CONNECTED) }
        settle()
        assertEquals(1, requestCount())
    }

    @Test
    fun aRefusedUpgradeIsRetriedWithBackoffAndStaysDisconnected() = runTest {
        repeat(2) { server.enqueue(MockResponse.Builder().code(503).build()) }
        open().start()
        await("first attempt") { requestCount() == 1 }
        settle()
        advanceTimeBy(999)
        settle()
        assertEquals(1, requestCount())
        advanceTimeBy(1)
        await("second attempt after 1 s") { requestCount() == 2 }
        assertTrue("never reported connected", states.none { it == Online.CONNECTED })
    }
}
