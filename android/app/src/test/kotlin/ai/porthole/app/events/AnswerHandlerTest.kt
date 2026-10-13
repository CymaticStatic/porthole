package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.shared.AnswerOutcome
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyPlan
import ai.porthole.shared.NotifyPlanner
import ai.porthole.shared.Routes
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AnswerHandlerTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val shadow get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private lateinit var notifier: Notifier
    private lateinit var handler: AnswerHandler
    private lateinit var plan: NotifyPlan

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        machine = Machine("test", "http://${server.hostName}:${server.port}")
        notifier = Notifier(context)
        handler = AnswerHandler(HostClient(Http.create()), notifier) { _, _ -> "#/inbox" }
        plan = NotifyPlanner.plan(notifyEvent(4, "item-a", title = "Proceed with the plan?"), machine)
        notifier.show(plan, "#/inbox")
    }

    @After
    fun tearDown() {
        Graph.reset()
        runCatching { server.close() }
    }

    private fun reply(code: Int, body: String) {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
    }

    private fun shownText(): String =
        shadow.getNotification(plan.tag, plan.id).extras.getCharSequence(Notification.EXTRA_TEXT).toString()

    private fun Notification.actionTitles() = actions.orEmpty().map { it.title.toString() }

    private fun answer(index: Int = 0, label: String = "Yes") =
        runBlocking { handler.answer(machine, "item-a", index, label, plan) }

    @Test
    fun aSentAnswerPostsTheOptionIndexAndTheNotificationBecomesSentWithOnlyOpen() {
        reply(200, """{"status":"sent"}""")

        assertEquals(AnswerOutcome.Sent("Yes"), answer(0, "Yes"))

        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/v1/inbox/item-a/answer", request.target)
        assertEquals("""{"optionIndexes":[0]}""", request.body!!.utf8())
        assertEquals(1, shadow.size())
        assertEquals("Sent: Yes", shownText())
        val n = shadow.getNotification(plan.tag, plan.id)
        assertEquals(listOf("Open"), n.actionTitles())
        assertEquals("Proceed with the plan?", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
    }

    @Test
    fun theSecondOptionPostsItsOwnIndex() {
        reply(200, """{"status":"sent"}""")

        assertEquals(AnswerOutcome.Sent("No"), answer(1, "No"))

        assertEquals("""{"optionIndexes":[1]}""", server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8())
        assertEquals("Sent: No", shownText())
    }

    @Test
    fun aRefusedAnswerShowsHostdsReason() {
        reply(409, """{"status":"refused","reason":"question closed"}""")

        assertEquals(AnswerOutcome.Refused("question closed"), answer())

        assertEquals("Not sent: question closed", shownText())
        assertEquals(listOf("Open"), shadow.getNotification(plan.tag, plan.id).actionTitles())
    }

    @Test
    fun aGoneItemShowsThatTheQuestionIsGone() {
        reply(404, """{"error":"no such item"}""")

        assertEquals(AnswerOutcome.Gone, answer())

        assertEquals("This question is gone", shownText())
    }

    @Test
    fun aServerErrorShowsCouldntSend() {
        reply(500, "boom")

        assertTrue(answer() is AnswerOutcome.Failed)

        assertEquals("Couldn't send. Open Porthole to try again", shownText())
    }

    @Test
    fun anUnreachableMachineShowsCouldntSend() {
        server.close()

        assertEquals(AnswerOutcome.Failed("No connection"), answer())

        assertEquals("Couldn't send. Open Porthole to try again", shownText())
    }

    @Test
    fun aHangingRequestIsGivenUpAfterTheTimeoutAndTheNotificationSaysSo() {
        server.enqueue(MockResponse.Builder().code(200).body("""{"status":"sent"}""").headersDelay(20, TimeUnit.SECONDS).build())

        val started = System.nanoTime()
        val outcome = runBlocking { handler.answerWithin(300, machine, "item-a", 0, "Yes", plan) }
        val tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)

        assertEquals(AnswerOutcome.Failed("Timed out"), outcome)
        assertTrue("returned after $tookMs ms", tookMs < 5_000)
        assertEquals("Couldn't send. Open Porthole to try again", shownText())
        assertEquals(listOf("Open"), shadow.getNotification(plan.tag, plan.id).actionTitles())
    }

    @Test
    fun anAnswerThatArrivesInTimeIsNotTreatedAsATimeout() {
        reply(200, """{"status":"sent"}""")

        assertEquals(AnswerOutcome.Sent("Yes"), runBlocking { handler.answerWithin(5_000, machine, "item-a", 0, "Yes", plan) })
        assertEquals("Sent: Yes", shownText())
    }

    @Test
    fun theConfirmationsOpenActionGoesToTheRouteTheHandlerWasGiven() {
        val chat = AnswerHandler(HostClient(Http.create()), notifier) { m, item -> "#/chat/${Routes.segment(m.name)}/$item" }
        reply(200, """{"status":"sent"}""")

        runBlocking { chat.answer(machine, "item-a", 0, "Yes", plan) }

        val open = shadowOf(shadow.getNotification(plan.tag, plan.id).actions[0].actionIntent).savedIntent
        assertEquals(Routes.openLink(machine.origin, "#/chat/test/item-a"), open.data.toString())
    }

    // The receiver end: the real PendingIntent of a button, handed to AnswerReceiver the way Android does.

    private fun startGraph(): Machine {
        // hostd answers over https on a tailnet name; the test sends every request to the local server instead.
        val local = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val r = chain.request()
                chain.proceed(r.newBuilder().url(r.url.newBuilder().scheme("http").host(server.hostName).port(server.port).build()).build())
            }
            .build()
        Graph.init(context, http = Http(local))
        return Graph.machines.machines.value.first()
    }

    private fun tap(m: Machine, position: Int): Intent {
        val p = NotifyPlanner.plan(notifyEvent(9, "item-r", title = "Run the tests?"), m)
        Notifier.shared().show(p, "#/inbox")
        return shadowOf(shadow.getNotification(p.tag, p.id).actions[1 + position].actionIntent).savedIntent
    }

    private fun awaitNotification(tag: String, id: Int, text: String): Notification {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val n = shadow.getNotification(tag, id)
            if (n?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() == text) return n
            Thread.sleep(10)
        }
        throw AssertionError("no notification with text '$text'; got ${shadow.getNotification(tag, id)?.extras?.getCharSequence(Notification.EXTRA_TEXT)}")
    }

    @Test
    fun tappingYesOnTheNotificationAnswersAndTheResultReplacesTheQuestion() {
        val m = startGraph()
        reply(200, """{"status":"sent"}""")
        val intent = tap(m, 0)
        assertEquals(Intents.ACTION_ANSWER, intent.action)

        AnswerReceiver().onReceive(context, intent)

        val n = awaitNotification(m.origin, "item-r".hashCode(), "Sent: Yes")
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/v1/inbox/item-r/answer", request.target)
        assertEquals("""{"optionIndexes":[0]}""", request.body!!.utf8())
        assertEquals("Run the tests?", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(m.name, n.extras.getCharSequence(Notification.EXTRA_SUB_TEXT).toString())
        assertEquals(listOf("Open"), n.actionTitles())
    }

    @Test
    fun tappingNoSendsTheSecondOption() {
        val m = startGraph()
        reply(409, """{"status":"refused","reason":"not waiting"}""")

        AnswerReceiver().onReceive(context, tap(m, 1))

        awaitNotification(m.origin, "item-r".hashCode(), "Not sent: not waiting")
        assertEquals("""{"optionIndexes":[1]}""", server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8())
    }

    @Test
    fun anAnswerForAMachineThatWasRemovedJustDismissesTheNotification() {
        startGraph()
        val gone = Machine("gone", "https://gone.tailafe04c.ts.net")
        val intent = tap(gone, 0)
        assertNotNull(shadow.getNotification(gone.origin, "item-r".hashCode()))

        AnswerReceiver().onReceive(context, intent)

        assertNull(shadow.getNotification(gone.origin, "item-r".hashCode()))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun anAnswerIntentWithoutAnOptionIndexDoesNothing() {
        val m = startGraph()
        val intent = tap(m, 0).apply { removeExtra(Intents.EXTRA_INDEX) }

        AnswerReceiver().onReceive(context, intent)

        Thread.sleep(200)
        assertEquals(0, server.requestCount)
        assertEquals(listOf("Open", "Yes", "No"), shadow.getNotification(m.origin, "item-r".hashCode()).actionTitles())
    }
}
