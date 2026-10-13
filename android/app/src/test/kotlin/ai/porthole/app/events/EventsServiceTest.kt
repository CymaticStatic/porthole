package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.net.EventsSocket
import ai.porthole.app.net.Http
import ai.porthole.app.net.Online
import ai.porthole.shared.Machine
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.os.Looper
import java.util.concurrent.TimeUnit
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowConnectivityManager
import org.robolectric.shadows.ShadowNetwork

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EventsServiceTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val nm get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private val network get() = shadowOf(context.getSystemService(ConnectivityManager::class.java)) as ShadowConnectivityManager
    private lateinit var server: MockWebServer
    private lateinit var hub: ConnectionHub
    private var controller: ServiceController<EventsService>? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        Graph.init(context, http = Http.create())
        for (m in Graph.machines.machines.value) Graph.machines.remove(m.name) // the two defaults would need a network
        hub = ConnectionHub(
            Graph.machines,
            Graph.host,
            LedgerStore(context),
            Notifier.shared(),
            Graph.appScope,
        ) { machine, device, ledger, scope, onEvent, onState ->
            EventsSocket(
                Graph.http, machine, device, ledger, scope, onEvent, onState,
                urlFor = { since -> "http://${server.hostName}:${server.port}/v1/events?device=$device&since=$since" },
            )
        }
        Graph.provide(ConnectionHub::class.java, hub)
    }

    @After
    fun tearDown() {
        controller?.let { runCatching { it.destroy() } }
        Graph.reset()
        runCatching { server.close() }
    }

    private fun addMachine(): Machine {
        val added = Graph.machines.add("desk", "https://desk.tailafe04c.ts.net").getOrThrow().single()
        context.getSharedPreferences("machine_devices", Context.MODE_PRIVATE).edit().putString(added.origin, "bencell").commit()
        return added
    }

    private fun accept() {
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = Unit
        }).build())
    }

    private fun startService(): EventsService {
        val c = Robolectric.buildService(EventsService::class.java).create().startCommand(0, 1)
        controller = c
        return c.get()
    }

    private fun awaitTrue(what: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (true) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            check(System.nanoTime() < deadline) { "timed out waiting for: $what" }
            Thread.sleep(10)
        }
    }

    private fun connectionTitle(): String? =
        nm.getNotification(Notifier.CONNECTION_ID)?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()

    @Test
    fun startingPostsTheConnectionNoticeAsARemoteMessagingForegroundService() {
        val service = startService()

        val shadow = shadowOf(service)
        assertEquals(Notifier.CONNECTION_ID, shadow.lastForegroundNotificationId)
        val n = shadow.lastForegroundNotification
        assertEquals(Notifier.CHANNEL_CONNECTION, n.channelId)
        assertTrue(n.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING, service.foregroundServiceType)
    }

    @Test
    fun withNoMachinesTheNoticeSaysSo() {
        val service = startService()

        assertEquals(
            "Porthole is connected: no machines",
            shadowOf(service).lastForegroundNotification.extras.getCharSequence(Notification.EXTRA_TITLE).toString(),
        )
    }

    @Test
    fun startingTheServiceOpensTheSocketOfEveryConfiguredMachine() {
        val m = addMachine()
        accept()

        startService()

        awaitTrue("a socket for the machine") { hub.online.value.containsKey(m.origin) }
        awaitTrue("the machine to connect") { hub.online.value[m.origin] == Online.CONNECTED }
        assertEquals("/v1/events?device=bencell&since=0", server.takeRequest(5, TimeUnit.SECONDS)!!.target)
    }

    @Test
    fun theNoticeFollowsTheConnectionState() {
        addMachine()
        accept()

        startService()

        awaitTrue("connected notice") { connectionTitle() == "Porthole is connected: 1 machine" }
    }

    @Test
    fun theNoticeSaysReconnectingWhenTheMachineIsUnreachable() {
        addMachine()
        server.close()

        startService()

        awaitTrue("reconnecting notice") { connectionTitle() == "Porthole is reconnecting" }
    }

    @Test
    fun aMachineAddedWhileRunningGetsASocket() {
        startService()
        assertTrue(hub.online.value.isEmpty())
        accept()

        val m = addMachine()

        awaitTrue("the new machine to connect") { hub.online.value[m.origin] == Online.CONNECTED }
    }

    @Test
    fun startingTwiceKeepsOneSocketAndOneNetworkCallback() {
        val m = addMachine()
        accept()
        accept()
        val c = Robolectric.buildService(EventsService::class.java).create()
        controller = c
        c.startCommand(0, 1).startCommand(0, 2)

        awaitTrue("connected") { hub.online.value[m.origin] == Online.CONNECTED }
        Thread.sleep(200)
        assertEquals(1, server.requestCount)
        assertEquals(1, network.networkCallbacks.size)
    }

    @Test
    fun destroyingTheServiceClosesEverySocketAndUnregistersTheNetworkCallback() {
        val m = addMachine()
        accept()
        val service = startService()
        awaitTrue("connected") { hub.online.value[m.origin] == Online.CONNECTED }
        assertEquals(1, network.networkCallbacks.size)

        controller!!.destroy()
        controller = null

        assertTrue(hub.online.value.isEmpty())
        assertTrue(network.networkCallbacks.isEmpty())
        assertNull(hub.inbox.value[m.origin])
        assertTrue(service.lifecycle.currentState == androidx.lifecycle.Lifecycle.State.DESTROYED)
    }

    @Test
    fun startAndStopAreTheForegroundStartAndPlainStopOfTheService() {
        EventsService.start(context)
        val started = shadowOf(context).nextStartedService
        assertEquals(EventsService::class.java.name, started.component!!.className)

        EventsService.stop(context)
        val stopped = shadowOf(context).nextStoppedService
        assertEquals(EventsService::class.java.name, stopped.component!!.className)
    }

    @Test
    fun whileStayConnectedIsOffStartDoesNothingAndTurningItOnStartsTheService() {
        BackgroundPref(context).enabled = false
        EventsService.start(context)
        assertNull("an app launch must not start it", shadowOf(context).nextStartedService)

        EventsService.setStayConnected(context, true)
        assertTrue(BackgroundPref(context).enabled)
        assertEquals(EventsService::class.java.name, shadowOf(context).nextStartedService.component!!.className)
    }

    @Test
    fun turningStayConnectedOffStopsTheServiceKeepsTheChoiceAndStartStaysQuiet() {
        EventsService.setStayConnected(context, false)
        assertEquals(EventsService::class.java.name, shadowOf(context).nextStoppedService.component!!.className)
        assertNull(shadowOf(context).nextStartedService)

        assertTrue("the choice outlives the app: a new reader sees it off", !BackgroundPref(context).enabled)
        EventsService.start(context)
        BootPolicy.startFromBoot(context)
        assertNull(shadowOf(context).nextStartedService)
    }

    @Test
    fun stayConnectedIsOnByDefault() {
        assertTrue(BackgroundPref(context).enabled)
    }

    @Test
    fun aNewDefaultNetworkMakesTheWatcherCallItsAction() {
        var nudges = 0
        val watcher = NetworkWatcher(context) { nudges++ }
        watcher.start()
        watcher.start() // a second start must not register a second callback
        assertEquals(1, network.networkCallbacks.size)

        network.networkCallbacks.single().onAvailable(ShadowNetwork.newInstance(1))

        assertEquals(1, nudges)
        watcher.stop()
        assertTrue(network.networkCallbacks.isEmpty())
        watcher.stop() // stopping twice is harmless
    }
}
