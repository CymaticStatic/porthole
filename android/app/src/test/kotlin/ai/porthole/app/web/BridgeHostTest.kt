package ai.porthole.app.web

import ai.porthole.app.share.PickedFile
import ai.porthole.app.voice.AudioFocus
import ai.porthole.app.voice.LastRecording
import ai.porthole.app.voice.Recorder
import ai.porthole.app.voice.Recording
import ai.porthole.app.voice.Speaker
import ai.porthole.app.voice.TtsEngine
import ai.porthole.shared.Machine
import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.WebViewCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class FakeRegistry(var supported: Boolean = true) : WebMessageRegistry {
    val log = mutableListOf<String>()
    val rules = mutableListOf<Set<String>>()

    override fun supported() = supported

    override fun add(originRules: Set<String>, listener: WebViewCompat.WebMessageListener) {
        log.add("add")
        rules.add(originRules)
    }

    override fun remove() {
        log.add("remove")
    }
}

private class QuietEngine : TtsEngine {
    override var listener: ((id: String, done: Boolean) -> Unit)? = null
    override var errorListener: ((id: String) -> Unit)? = null
    override fun speak(text: String, id: String) = Unit
    override fun stop() = Unit
}

private class QuietFocus : AudioFocus {
    override fun request() = Unit
    override fun abandon() = Unit
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BridgeHostTest {
    @get:Rule val tmp = TemporaryFolder()

    private val app: Application = ApplicationProvider.getApplicationContext()
    private val desk = Machine("desk", "https://desk.tailx.ts.net")
    private val lap = Machine("lap", "https://lap.tailx.ts.net")
    private var list = listOf(desk, lap)
    private val registry = FakeRegistry()
    private val outbox = EventOutbox()
    private val last = LastRecording()
    private val picks = mutableListOf<Pair<String, Machine>>()
    private val methods = BridgeMethods(
        context = app,
        machines = { list },
        outbox = outbox,
        scope = CoroutineScope(Dispatchers.Unconfined),
        pick = { source, machine ->
            picks.add(source to machine)
            PickedFile("/p", "n")
        },
        micPermission = { true },
        speaker = Speaker(QuietEngine(), QuietFocus()),
        lastRecording = last,
        newRecorder = { error("no recorder in this test") },
    )
    private val host = BridgeHost(registry, { list }, methods, outbox, CoroutineScope(Dispatchers.Unconfined))
    private val replies = java.util.concurrent.CopyOnWriteArrayList<String>()
    private val post: (String) -> Unit = { replies.add(it) }

    private fun call(id: Int, method: String, args: String = "{}") = """{"id":$id,"method":"$method","args":$args}"""

    // --- listener registration ----------------------------------------------------------------------------------

    @Test
    fun installRegistersExactlyTheMachineOriginsAndReinstallingReplacesThem() {
        assertTrue(host.install())
        assertEquals(listOf(setOf("https://desk.tailx.ts.net", "https://lap.tailx.ts.net")), registry.rules)

        list = listOf(lap)
        assertTrue(host.install())

        assertEquals(listOf("add", "remove", "add"), registry.log)
        assertEquals(setOf("https://lap.tailx.ts.net"), registry.rules.last())
    }

    @Test
    fun installWithoutAnyMachineRemovesTheListenerAndAddsNone() {
        host.install()
        list = emptyList()
        assertTrue(host.install())
        assertEquals(listOf("add", "remove"), registry.log)
    }

    @Test
    fun aWebViewWithoutTheFeatureGetsNoBridgeAndInstallSaysSo() {
        registry.supported = false
        assertFalse(host.install())
        assertTrue(registry.log.isEmpty())
    }

    // --- messages -----------------------------------------------------------------------------------------------

    @Test
    fun aCallFromAMachineIsAnsweredToThatFrame() {
        host.handle("https://desk.tailx.ts.net", true, call(3, "machines"), post)

        val reply = Json.parseToJsonElement(replies.single()).jsonObject
        assertEquals("3", reply["id"]!!.jsonPrimitive.content)
        assertTrue(reply["ok"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun theCallingMachineIsTheOneWhoseOriginSentTheMessage() {
        host.handle("https://lap.tailx.ts.net", true, call(1, "pickFile", """{"source":"photo"}"""), post)
        host.handle("https://desk.tailx.ts.net/", true, call(2, "pickFile", """{"source":"file"}"""), post)

        assertEquals(listOf("photo" to lap, "file" to desk), picks)
        assertEquals(2, replies.size)
    }

    @Test
    fun messagesFromSubFramesOtherOriginsOrNoOriginAreIgnoredWithoutAReply() {
        host.handle("https://desk.tailx.ts.net", false, call(1, "machines"), post)
        host.handle("https://evil.example", true, call(2, "machines"), post)
        host.handle("https://desk.tailx.ts.net:8443", true, call(3, "machines"), post)
        host.handle("http://desk.tailx.ts.net", true, call(4, "machines"), post)
        host.handle(null, true, call(5, "machines"), post)

        assertTrue(replies.isEmpty())
        outbox.emit(EventOutbox.NETWORK, Json.parseToJsonElement("""{"online":true}"""))
        assertEquals("an ignored sender never became the event target", 1, outbox.pendingCount())
    }

    @Test
    fun anUnknownMethodAndBrokenMessagesAnswerWithAnError() {
        host.handle("https://desk.tailx.ts.net", true, call(9, "readFile"), post)
        host.handle("https://desk.tailx.ts.net", true, """{"id":10,"method":42}""", post)
        host.handle("https://desk.tailx.ts.net", true, "not json", post) // no id to answer

        assertEquals(2, replies.size)
        val first = Json.parseToJsonElement(replies[0]).jsonObject
        assertFalse(first["ok"]!!.jsonPrimitive.boolean)
        assertEquals("Bridge method not allowed: readFile", first["error"]!!.jsonPrimitive.content)
        assertFalse(Json.parseToJsonElement(replies[1]).jsonObject["ok"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun theFramesPosterBecomesTheEventTargetAndQueuedEventsFlushInOrder() {
        outbox.emit(EventOutbox.SHARE, Json.parseToJsonElement("""{"path":"/a"}"""))
        outbox.emit(EventOutbox.NETWORK, Json.parseToJsonElement("""{"online":true}"""))

        host.handle("https://desk.tailx.ts.net", true, call(1, "machines"), post)

        assertEquals(3, replies.size)
        assertEquals("share", Json.parseToJsonElement(replies[0]).jsonObject["event"]!!.jsonPrimitive.content)
        assertEquals("network", Json.parseToJsonElement(replies[1]).jsonObject["event"]!!.jsonPrimitive.content)
        assertNotNull("the reply comes after the events", Json.parseToJsonElement(replies[2]).jsonObject["id"])
    }

    @Test
    fun aReplyThatCouldNotBePostedDoesNotRunItsDeliveryHook() {
        val file = File(tmp.root, "a.wav").also { it.writeBytes("RIFFxxxxWAVE".toByteArray()) }
        last.keep(Recording(file, "limit"))

        val attempted = CountDownLatch(1)
        host.handle("https://desk.tailx.ts.net", true, call(1, "stopRecording")) {
            attempted.countDown()
            throw IllegalStateException("frame gone")
        }
        assertTrue(attempted.await(10, TimeUnit.SECONDS))
        Thread.sleep(200)
        assertTrue("the recording is kept for the next ask", file.exists())

        host.handle("https://desk.tailx.ts.net", true, call(2, "stopRecording"), post)
        val end = System.nanoTime() + 10_000_000_000L
        while (file.exists() && System.nanoTime() < end) Thread.sleep(10)
        assertFalse("posted, so the recording is cleared", file.exists())
        assertEquals(1, replies.size)
    }
}
