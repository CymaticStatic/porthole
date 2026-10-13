package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.net.EventsSocket
import ai.porthole.app.net.Http
import ai.porthole.app.net.Online
import ai.porthole.shared.Machine
import ai.porthole.shared.Routes
import ai.porthole.shared.Wire
import android.app.NotificationManager
import android.content.Context
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The hub against a real [EventsSocket] and a local WebSocket server (the machines' https origins are never contacted). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ConnectionHubTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val nm get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private lateinit var server: MockWebServer
    private lateinit var hub: ConnectionHub
    private lateinit var ledgers: LedgerStore
    private val serverSockets = LinkedBlockingQueue<WebSocket>()
    private val serverReceived = CopyOnWriteArrayList<String>()
    private val serverClosed = CopyOnWriteArrayList<WebSocket>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        Graph.init(context, http = Http.create())
        for (m in Graph.machines.machines.value) Graph.machines.remove(m.name) // the two defaults would need a network
        ledgers = LedgerStore(context)
        hub = ConnectionHub(Graph.machines, Graph.host, ledgers, Notifier.shared(), Graph.appScope) { machine, device, ledger, scope, onEvent, onState ->
            EventsSocket(
                Graph.http, machine, device, ledger, scope, onEvent, onState,
                urlFor = { since -> "http://${server.hostName}:${server.port}/v1/events?device=$device&since=$since" },
            )
        }
    }

    @After
    fun tearDown() {
        hub.stop()
        Graph.reset()
        runCatching { server.close() }
    }

    private fun accept(count: Int = 1) {
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                serverSockets.add(webSocket)
            }

            // the app ends a socket with cancel(), which the server sees as a failure, not a close frame
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                serverClosed.add(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                serverReceived.add(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                serverClosed.add(webSocket)
                webSocket.close(1000, null)
            }
        }
        repeat(count) { server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build()) }
    }

    private fun add(name: String): Machine {
        val added = Graph.machines.add(name, "https://$name.tailafe04c.ts.net").getOrThrow().first { it.name == name }
        context.getSharedPreferences("machine_devices", Context.MODE_PRIVATE).edit().putString(added.origin, "bencell").commit()
        return added
    }

    private fun await(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!condition()) {
            check(System.nanoTime() < deadline) { "timed out waiting for: $what" }
            Thread.sleep(10)
        }
    }

    private fun serverSocket(): WebSocket = serverSockets.poll(10, TimeUnit.SECONDS) ?: error("no socket reached the server")

    private fun notify(id: Long, itemId: String) =
        """{"type":"notify","id":$id,"itemId":"$itemId","title":"Proceed?","body":"Body","options":[{"index":0,"label":"Yes"},{"index":1,"label":"No"}]}"""

    private fun inboxJson(vararg ids: String) = """{"type":"inbox","items":[""" + ids.joinToString(",") {
        """{"id":"$it","key":"$it","sessionId":"tmux:/run/t.sock:main:0.0","machine":"desk","project":"p","kind":"question","column":"needs-you","title":"T","body":"b","createdAt":1,"updatedAt":2}"""
    } + "]}"

    private fun shown(m: Machine, itemId: String) = nm.getNotification(m.origin, itemId.hashCode())

    @Test
    fun aNotifyIsShownAndThenAcked() {
        val m = add("desk")
        accept()
        hub.start()

        serverSocket().send(notify(1, "a"))

        await("notification") { shown(m, "a") != null }
        await("ack") { serverReceived.contains(Wire.ack(1)) }
        assertEquals(listOf("Open", "Yes", "No"), shown(m, "a").actions.map { it.title.toString() })
    }

    @Test
    fun aRepeatedNotifyIsAckedAgainButNotShownAgain() {
        val m = add("desk")
        accept()
        hub.start()
        val socket = serverSocket()
        socket.send(notify(1, "a"))
        await("first ack") { serverReceived.size == 1 }
        context.getSystemService(NotificationManager::class.java).cancel(m.origin, "a".hashCode()) // the user swiped it away

        socket.send(notify(1, "a"))

        await("second ack") { serverReceived.size == 2 }
        assertEquals(listOf(Wire.ack(1), Wire.ack(1)), serverReceived.toList())
        assertNull(shown(m, "a"))
    }

    @Test
    fun theInboxOfEachMachineIsPublishedByOriginAndGivesTheNextNotifyItsChatRoute() {
        val m = add("desk")
        accept()
        hub.start()
        val socket = serverSocket()

        socket.send(inboxJson("a"))

        await("inbox") { hub.inbox.value[m.origin]?.map { it.id } == listOf("a") }
        socket.send(notify(2, "a"))
        await("notification") { shown(m, "a") != null }
        val open = shadowOf(shown(m, "a").actions[0].actionIntent).savedIntent
        assertEquals(
            Routes.openLink(m.origin, "#/chat/desk/tmux%3A%2Frun%2Ft.sock%3Amain%3A0.0"),
            open.data.toString(),
        )
    }

    @Test
    fun aNotifyForAnItemNotInTheInboxOpensTheInbox() {
        val m = add("desk")
        accept()
        hub.start()
        val socket = serverSocket()
        socket.send(inboxJson("other"))
        await("inbox") { hub.inbox.value[m.origin] != null }

        socket.send(notify(1, "a"))

        await("notification") { shown(m, "a") != null }
        assertEquals(Routes.openLink(m.origin, "#/inbox"), shadowOf(shown(m, "a").actions[0].actionIntent).savedIntent.data.toString())
    }

    @Test
    fun anItemThatLeavesTheNeedsYouListLosesItsNotification() {
        val m = add("desk")
        accept()
        hub.start()
        val socket = serverSocket()
        socket.send(inboxJson("a"))
        await("inbox") { hub.inbox.value[m.origin] != null }
        socket.send(notify(1, "a"))
        await("notification") { shown(m, "a") != null }

        socket.send("""{"type":"inbox","items":[]}""")

        await("notification removed") { shown(m, "a") == null }
    }

    @Test
    fun everyMachineIsOnlineUnderItsOwnOrigin() {
        val desk = add("desk")
        val lap = add("lap")
        accept(2)

        hub.start()

        await("both connected") { hub.online.value == mapOf(desk.origin to Online.CONNECTED, lap.origin to Online.CONNECTED) }
    }

    @Test
    fun startingTwiceOpensOneSocketPerMachine() {
        val m = add("desk")
        accept(2)

        hub.start()
        hub.start()

        await("connected") { hub.online.value[m.origin] == Online.CONNECTED }
        Thread.sleep(200)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun removingAMachineClosesItsSocketAndForgetsItsStateAndLedger() {
        val m = add("desk")
        accept()
        hub.start()
        val socket = serverSocket()
        socket.send(inboxJson("a"))
        socket.send(notify(7, "a"))
        await("ack") { serverReceived.contains(Wire.ack(7)) }
        await("inbox") { hub.inbox.value[m.origin] != null }

        Graph.machines.remove("desk")

        await("socket closed at the server") { serverClosed.isNotEmpty() }
        await("flows cleared") { hub.online.value.isEmpty() && hub.inbox.value.isEmpty() }
        assertEquals(0L, LedgerStore(context).ledger(m.origin).since())
    }

    @Test
    fun aMachineAddedLaterGetsASocketWithoutRestartingTheHub() {
        hub.start()
        accept()

        val m = add("desk")

        await("connected") { hub.online.value[m.origin] == Online.CONNECTED }
    }

    @Test
    fun renamingAMachineReopensItsSocketButKeepsItsLedger() {
        val m = add("desk")
        accept(2)
        hub.start()
        val socket = serverSocket()
        socket.send(notify(5, "a"))
        await("ack") { serverReceived.contains(Wire.ack(5)) }

        Graph.machines.rename("desk", "den")

        await("a second upgrade") { server.requestCount == 2 }
        await("connected again") { hub.online.value[m.origin] == Online.CONNECTED }
        assertEquals("/v1/events?device=bencell&since=0", server.takeRequest(5, TimeUnit.SECONDS)!!.target)
        assertEquals("/v1/events?device=bencell&since=5", server.takeRequest(5, TimeUnit.SECONDS)!!.target)
        assertNotNull(shown(m, "a")) // not wiped by the rename
    }

    @Test
    fun theLedgerIsSavedSoANewProcessKnowsWhatWasShownAndAcked() {
        val m = add("desk")
        accept()
        hub.start()
        serverSocket().send(notify(3, "a"))
        await("ack") { serverReceived.contains(Wire.ack(3)) }

        hub.stop() // closing a machine saves the ledger, which now includes the ack

        val reloaded = LedgerStore(context).ledger(m.origin)
        assertEquals(3L, reloaded.since())
        assertTrue(reloaded.pendingAcks().isEmpty())
    }

    @Test
    fun stoppingTheHubClosesEverySocketAndEmptiesTheFlows() {
        val m = add("desk")
        accept()
        hub.start()
        await("connected") { hub.online.value[m.origin] == Online.CONNECTED }

        hub.stop()

        await("closed at the server") { serverClosed.isNotEmpty() }
        assertTrue(hub.online.value.isEmpty())
    }
}
