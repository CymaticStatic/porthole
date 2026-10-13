package ai.porthole.app.relay

import ai.porthole.app.Graph
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.Routes
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchPaths
import com.google.android.gms.wearable.MessageEvent
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RelayListenerServiceTest {
    private val desk = Machine("desk", DESK_ORIGIN)
    private val hostd = FakeHostd()
    private val wear = FakeWear()
    private var inbox: Map<String, List<InboxItem>> = mapOf(DESK_ORIGIN to listOf(needsYou("item-a")))
    private var refreshes = 0
    private lateinit var handler: RelayHandler

    private class Message(
        private val path: String,
        private val data: ByteArray,
        private val node: String,
    ) : MessageEvent {
        override fun getRequestId() = 1
        override fun getPath() = path
        override fun getData() = data
        override fun getSourceNodeId() = node
    }

    @Before
    fun setUp() {
        Graph.init(RuntimeEnvironment.getApplication(), host = hostd.client)
        handler = RelayHandler(hostd.client, wear, { listOf(desk) }, { inbox }) { refreshes++ }
        Graph.provide(RelayHandler::class.java, handler)
    }

    @After
    fun tearDown() = Graph.reset()

    private fun service() = Robolectric.setupService(RelayListenerService::class.java)

    private fun send(path: String, bytes: ByteArray, node: String = "watch-1") =
        service().onMessageReceived(Message(path, bytes, node))

    private fun sendAnswer(a: WatchAnswer, node: String = "watch-1") = send(WatchPaths.ANSWER, a.encode(), node)

    private fun onlyReply(): WatchAnswerResult {
        assertEquals("exactly one reply", 1, wear.replies.size)
        return checkNotNull(WatchAnswerResult.decode(wear.replies[0].bytes))
    }

    @Test
    fun anAnswerMessageCallsAnswerOnceAndRepliesWithTheOutcomeTextAndTheSameRequestId() {
        hostd.respond = { 200 to """{"status":"sent"}""" }

        sendAnswer(WatchAnswer.Option("req-7", DESK_ORIGIN, "item-a", listOf(1)), node = "watch-9")

        assertEquals(1, hostd.seen.size)
        val request = hostd.seen[0]
        assertEquals("POST", request.method)
        assertEquals(Routes.answer(DESK_ORIGIN, "item-a"), request.url)
        assertEquals("""{"optionIndexes":[1]}""", request.body)
        val reply = wear.replies.single()
        assertEquals("watch-9", reply.nodeId)
        assertEquals(WatchPaths.ANSWER_RESULT, reply.path)
        assertEquals(WatchAnswerResult("req-7", ok = true, message = "Sent: No"), WatchAnswerResult.decode(reply.bytes))
    }

    @Test
    fun aRefusedAnswerRepliesNotOkWithHostdsReason() {
        hostd.respond = { 409 to """{"status":"refused","reason":"question closed"}""" }

        sendAnswer(WatchAnswer.Option("req-8", DESK_ORIGIN, "item-a", listOf(0)))

        assertEquals(WatchAnswerResult("req-8", ok = false, message = "Not sent: question closed"), onlyReply())
    }

    @Test
    fun aGoneQuestionAndADeadNetworkReplyNotOkWithTheirOwnText() {
        hostd.respond = { 404 to """{"error":"gone"}""" }
        sendAnswer(WatchAnswer.Option("req-9", DESK_ORIGIN, "item-a", listOf(0)))
        assertEquals(WatchAnswerResult("req-9", ok = false, message = "This question is gone"), onlyReply())

        wear.replies.clear()
        hostd.respond = { throw IOException("no route to host") }
        sendAnswer(WatchAnswer.Option("req-10", DESK_ORIGIN, "item-a", listOf(0)))
        assertEquals(
            WatchAnswerResult("req-10", ok = false, message = "Couldn't send. Open Porthole to try again"),
            onlyReply(),
        )
    }

    @Test
    fun aStopMessageSendsEscToTheSessionAndRepliesOk() {
        hostd.respond = { 200 to """{"ok":true}""" }

        sendAnswer(WatchAnswer.Stop("req-11", DESK_ORIGIN, "tmux:s:item-a"))

        assertEquals(1, hostd.seen.size)
        val request = hostd.seen[0]
        assertEquals("POST", request.method)
        assertEquals(Routes.keys(DESK_ORIGIN, "tmux:s:item-a"), request.url)
        assertEquals("""{"keys":["Esc"]}""", request.body)
        assertEquals(WatchAnswerResult("req-11", ok = true, message = "Sent: Stop"), onlyReply())
    }

    @Test
    fun aFailedStopRepliesNotOk() {
        hostd.respond = { 502 to """{"error":"tmux"}""" }

        sendAnswer(WatchAnswer.Stop("req-12", DESK_ORIGIN, "tmux:s:item-a"))

        val result = onlyReply()
        assertEquals("req-12", result.requestId)
        assertFalse(result.ok)
        assertEquals("Couldn't send. Open Porthole to try again", result.message)
    }

    @Test
    fun anAnswerForAMachineThePhoneDoesNotKnowCallsNothingAndRepliesNotOk() {
        sendAnswer(WatchAnswer.Option("req-13", "https://gone.example.ts.net", "item-a", listOf(0)))

        assertTrue("no hostd call", hostd.seen.isEmpty())
        assertEquals(
            WatchAnswerResult("req-13", ok = false, message = RelayHandler.UNKNOWN_MACHINE),
            onlyReply(),
        )
    }

    @Test
    fun theSentLabelIsTheOptionTextAndFallsBackWhenTheItemIsNoLongerInTheInbox() = runBlocking {
        hostd.respond = { 200 to """{"status":"sent"}""" }

        handler.onMessage("watch-1", WatchPaths.ANSWER, WatchAnswer.Option("r1", DESK_ORIGIN, "item-a", listOf(0)).encode())
        inbox = emptyMap()
        handler.onMessage("watch-1", WatchPaths.ANSWER, WatchAnswer.Option("r2", DESK_ORIGIN, "item-a", listOf(0)).encode())

        val messages = wear.replies.map { checkNotNull(WatchAnswerResult.decode(it.bytes)).message }
        assertEquals(listOf("Sent: Yes", "Sent: answer"), messages)
    }

    @Test
    fun anAnswerThatCannotBeRepliedToDoesNotThrow() = runBlocking {
        hostd.respond = { 200 to """{"status":"sent"}""" }
        wear.failReply = true

        handler.onMessage("watch-1", WatchPaths.ANSWER, WatchAnswer.Option("r1", DESK_ORIGIN, "item-a", listOf(0)).encode())

        assertEquals(1, hostd.seen.size)
        assertTrue(wear.replies.isEmpty())
    }

    @Test
    fun bytesThatAreNotAnAnswerAreIgnoredWithoutAReply() {
        send(WatchPaths.ANSWER, "not json".toByteArray())

        assertTrue(hostd.seen.isEmpty())
        assertTrue(wear.replies.isEmpty())
        assertEquals(0, refreshes)
    }

    @Test
    fun aRefreshMessageRunsTheRefreshOnceAndCallsNothing() {
        send(WatchPaths.REFRESH, ByteArray(0))

        assertEquals(1, refreshes)
        assertTrue(hostd.seen.isEmpty())
        assertTrue(wear.replies.isEmpty())
    }

    @Test
    fun aMessageOnAnotherPathIsIgnored() {
        send("/porthole/other", WatchAnswer.Stop("r", DESK_ORIGIN, "s").encode())

        assertTrue(hostd.seen.isEmpty())
        assertTrue(wear.replies.isEmpty())
        assertEquals(0, refreshes)
    }
}
