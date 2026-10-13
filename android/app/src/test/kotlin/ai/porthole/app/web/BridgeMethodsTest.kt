package ai.porthole.app.web

import ai.porthole.app.share.PickedFile
import ai.porthole.app.voice.AudioFocus
import ai.porthole.app.voice.LastRecording
import ai.porthole.app.voice.Mic
import ai.porthole.app.voice.Recorder
import ai.porthole.app.voice.Speaker
import ai.porthole.app.voice.TtsEngine
import ai.porthole.shared.BridgeProtocol
import ai.porthole.shared.Machine
import android.app.Application
import android.content.Intent
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

private class FakeEngine : TtsEngine {
    override var listener: ((id: String, done: Boolean) -> Unit)? = null
    val spoken = CopyOnWriteArrayList<String>()
    var stops = 0

    override fun speak(text: String, id: String) {
        spoken.add(text)
        listener?.invoke(id, true)
    }

    override fun stop() {
        stops++
    }
}

private class FakeFocus : AudioFocus {
    override fun request() = Unit
    override fun abandon() = Unit
}

/** A microphone that never stops talking (so a recording only ends when something stops it). */
private class LoudMic(private val pauseMs: Long) : Mic {
    val reads = java.util.concurrent.atomic.AtomicInteger()

    override fun read(buf: ShortArray): Int {
        for (i in buf.indices) buf[i] = if (i % 2 == 0) 4_000 else -4_000
        if (pauseMs > 0) Thread.sleep(pauseMs)
        reads.incrementAndGet()
        return buf.size
    }

    override fun stop() = Unit
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BridgeMethodsTest {
    @get:Rule val tmp = TemporaryFolder()

    private val app: Application = ApplicationProvider.getApplicationContext()
    private val desk = Machine("desk", "https://desk.tailx.ts.net")
    private val lap = Machine("lap", "https://lap.tailx.ts.net")
    private val engine = FakeEngine()
    private val last = LastRecording()
    private val outbox = EventOutbox()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val picks = CopyOnWriteArrayList<Pair<String, Machine>>()
    private var micGranted = true
    private var micAsked = 0
    private var pickResult: PickedFile? = null
    private var recorders = 0
    private var maxDataBytes = Long.MAX_VALUE
    private var micPauseMs = 1L
    private var mic: LoudMic? = null

    private lateinit var methods: BridgeMethods

    @Before
    fun setUp() {
        methods = BridgeMethods(
            context = app,
            machines = { listOf(desk, lap) },
            outbox = outbox,
            scope = scope,
            pick = { source, machine ->
                picks.add(source to machine)
                pickResult
            },
            micPermission = {
                micAsked++
                micGranted
            },
            speaker = Speaker(engine, FakeFocus()),
            lastRecording = last,
            newRecorder = {
                recorders++
                Recorder(LoudMic(micPauseMs).also { mic = it }, File(tmp.root, "voice"), minOf(maxDataBytes, 19_200_000L))
            },
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun args(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

    private fun reply(caller: Machine, method: String, args: JsonObject = JsonObject(emptyMap())): Reply =
        runBlocking { methods.call(caller, BridgeProtocol.Parsed.Call(JsonPrimitive(7), method, args)) }

    private fun obj(r: Reply) = Json.parseToJsonElement(r.text).jsonObject

    private fun ok(r: Reply): JsonElement {
        val o = obj(r)
        assertTrue("expected ok but got ${r.text}", o["ok"]!!.jsonPrimitive.boolean)
        assertEquals(JsonPrimitive(7), o["id"])
        return o["result"]!!
    }

    private fun errorOf(r: Reply): String {
        val o = obj(r)
        assertFalse("expected an error but got ${r.text}", o["ok"]!!.jsonPrimitive.boolean)
        assertEquals(JsonPrimitive(7), o["id"])
        return o["error"]!!.jsonPrimitive.content
    }

    private fun <T : Any> eventually(what: String, block: () -> T?): T {
        val end = System.nanoTime() + 10_000_000_000L
        while (System.nanoTime() < end) {
            block()?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun wavOf(r: JsonElement): ByteArray = Base64.getDecoder().decode(r.jsonObject["wav"]!!.jsonPrimitive.content)

    private fun assertWav(bytes: ByteArray) {
        assertEquals("RIFF", String(bytes, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(bytes, 8, 4, Charsets.US_ASCII))
    }

    /** The page's frame is there: events go out at once and are collected here. */
    private fun openFrame(): CopyOnWriteArrayList<JsonObject> {
        val sent = CopyOnWriteArrayList<JsonObject>()
        outbox.onMessage { sent.add(Json.parseToJsonElement(it).jsonObject) }
        return sent
    }

    private fun voiceFiles() = File(tmp.root, "voice").listFiles()?.toList().orEmpty()

    // --- machines, speech ---------------------------------------------------------------------------------------

    @Test
    fun machinesListsNameAndOrigin() {
        val result = ok(reply(desk, "machines")) as JsonArray
        assertEquals(
            buildJsonArray {
                add(buildJsonObject { put("name", "desk"); put("origin", "https://desk.tailx.ts.net") })
                add(buildJsonObject { put("name", "lap"); put("origin", "https://lap.tailx.ts.net") })
            },
            result,
        )
    }

    @Test
    fun speakReadsEveryUtteranceAndReportsFinished() {
        val result = ok(reply(desk, "speak", args("utterances" to buildJsonArray { add("one"); add("two") })))
        assertEquals(buildJsonObject { put("finished", true) }, result)
        assertEquals(listOf("one", "two"), engine.spoken.toList())
    }

    @Test
    fun speakAcceptsTwentyOneShortUtterances() {
        val list = buildJsonArray { repeat(21) { add("line $it") } }
        assertEquals(buildJsonObject { put("finished", true) }, ok(reply(desk, "speak", args("utterances" to list))))
        assertEquals(21, engine.spoken.size)
    }

    @Test
    fun speakRefusesMoreThanOneHundredThousandBytesInTotal() {
        val big = "x".repeat(50_500)
        val list = buildJsonArray { add(big); add(big) } // 101 000 bytes
        errorOf(reply(desk, "speak", args("utterances" to list)))
        assertTrue("nothing was spoken", engine.spoken.isEmpty())
    }

    @Test
    fun speakWithoutUtterancesIsRefused() {
        errorOf(reply(desk, "speak"))
        assertTrue(engine.spoken.isEmpty())
    }

    @Test
    fun stopSpeakingReturnsNullAndSilencesTheEngine() {
        assertEquals(JsonNull, ok(reply(desk, "stopSpeaking")))
        assertEquals(1, engine.stops)
    }

    // --- recording ----------------------------------------------------------------------------------------------

    @Test
    fun stopRecordingReturnsTheWavAndTheFileGoesOnlyAfterTheReplyIsPosted() {
        assertEquals(JsonNull, ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false)))))
        eventually("the recorder to start") { voiceFiles().firstOrNull() }
        eventually("the microphone to be read") { if ((mic?.reads?.get() ?: 0) >= 3) true else null }

        val stopped = reply(desk, "stopRecording")
        val wav = wavOf(ok(stopped))
        assertWav(wav)
        assertTrue("a real clip, not only a header", wav.size > 44)
        assertEquals("the file stays until the reply is posted", 1, voiceFiles().size)

        stopped.onPosted()
        assertTrue("the file is gone afterwards", voiceFiles().isEmpty())
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    @Test
    fun startRecordingAsksForTheMicrophoneAndRefusesWithoutIt() {
        micGranted = false
        assertEquals("Microphone permission denied", errorOf(reply(desk, "startRecording")))
        assertEquals(1, micAsked)
        assertEquals("no recorder was made", 0, recorders)
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    @Test
    fun stopRecordingWithNothingRecordingAndNothingKeptFails() {
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    @Test
    fun aRecordingThatEndedByItselfCanBeFetchedAgainUntilTheReplyIsPosted() {
        maxDataBytes = 16_000L * 2 // one second: the cap ends it
        micPauseMs = 0
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))
        val kept = eventually("the recording to end by itself") { last.current() }

        val first = reply(desk, "stopRecording")
        val second = reply(desk, "stopRecording")
        assertArrayEquals(kept.file.readBytes(), wavOf(ok(first)))
        assertArrayEquals("a second call before the reply hook has run returns it again", wavOf(ok(first)), wavOf(ok(second)))

        first.onPosted()
        assertFalse(kept.file.exists())
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    @Test
    fun aRecordingThatEndsByItselfIsEmittedAndClearedOnceTheEventIsSent() {
        val sent = openFrame()
        maxDataBytes = 16_000L * 2
        micPauseMs = 0
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))

        val event = eventually("the recordingStopped event") { sent.firstOrNull() }
        assertEquals("recordingStopped", event["event"]!!.jsonPrimitive.content)
        assertWav(wavOf(event["data"]!!))
        eventually("the kept recording to be cleared") { if (last.current() == null) true else null }
        assertTrue(voiceFiles().isEmpty())
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    @Test
    fun anEventQueuedForTheNextPageIsKeptUntilAMessageArrivesAndStopRecordingStillWorks() {
        maxDataBytes = 16_000L * 2
        micPauseMs = 0
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))
        eventually("the recording to end by itself") { last.current() }

        // The page was reloaded: nothing could be sent, so the recording is still there for stopRecording.
        val r = reply(desk, "stopRecording")
        assertWav(wavOf(ok(r)))
        val sent = openFrame()
        eventually("the queued event to go out") { sent.firstOrNull() }
        assertNull("the event's delivery cleared it", last.current())
    }

    @Test
    fun aLateFlushOfAnOldEventDoesNotDeleteANewerRecording() {
        maxDataBytes = 16_000L * 2
        micPauseMs = 0
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))
        val first = eventually("first recording") { last.current() }
        eventually("its event to be queued") { if (outbox.pendingCount() == 1) true else null }
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false)))) // discards the first
        assertFalse(first.file.exists())
        val second = eventually("second recording") { last.current()?.takeIf { it.file != first.file } }

        val survivedFirstDelivery = CopyOnWriteArrayList<Boolean>()
        outbox.onMessage {
            // Called once per queued event; the second call happens after the first event's onSent ran.
            survivedFirstDelivery.add(second.file.exists())
        }
        assertEquals(2, survivedFirstDelivery.size)
        assertTrue("the old event's delivery must leave the newer recording alone", survivedFirstDelivery[1])
        assertFalse("the newer event's own delivery clears it", second.file.exists())
    }

    @Test
    fun startRecordingDiscardsAKeptRecording() {
        val keptFile = tmp.newFile("kept.wav").also { it.writeBytes(ByteArray(64)) }
        last.keep(ai.porthole.app.voice.Recording(keptFile, "limit"))

        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))
        assertFalse(keptFile.exists())
        assertNull(last.current())
        reply(desk, "stopRecording").onPosted()
    }

    @Test
    fun goingToTheBackgroundEndsARecordingAndSendsWhatWasRecorded() {
        val sent = openFrame()
        ok(reply(desk, "startRecording", args("autoStop" to JsonPrimitive(false))))
        eventually("the recorder to start") { voiceFiles().firstOrNull() }

        methods.onBackground()

        val event = eventually("the recordingStopped event") { sent.firstOrNull() }
        assertEquals("recordingStopped", event["event"]!!.jsonPrimitive.content)
        assertWav(wavOf(event["data"]!!))
        assertEquals("Not recording", errorOf(reply(desk, "stopRecording")))
    }

    // --- pickFile -----------------------------------------------------------------------------------------------

    @Test
    fun pickFileUploadsToTheMachineOfTheCallingOrigin() {
        pickResult = PickedFile("/home/ben/uploads/a.jpg", "a.jpg")
        val fromDesk = ok(reply(desk, "pickFile", args("source" to JsonPrimitive("photo"))))
        val fromLap = ok(reply(lap, "pickFile", args("source" to JsonPrimitive("camera"))))

        assertEquals(listOf("photo" to desk, "camera" to lap), picks.toList())
        assertEquals(buildJsonObject { put("path", "/home/ben/uploads/a.jpg"); put("name", "a.jpg") }, fromDesk)
        assertEquals(fromDesk, fromLap)
    }

    @Test
    fun pickFileCancelledIsNull() {
        pickResult = null
        assertEquals(JsonNull, ok(reply(desk, "pickFile", args("source" to JsonPrimitive("file")))))
    }

    @Test
    fun pickFileRefusesClipboardAndOtherSources() {
        errorOf(reply(desk, "pickFile", args("source" to JsonPrimitive("clipboard"))))
        errorOf(reply(desk, "pickFile"))
        assertTrue("no picker was opened", picks.isEmpty())
    }

    // --- openExternal -------------------------------------------------------------------------------------------

    private fun started(): Intent? = shadowOf(app).nextStartedActivity

    @Test
    fun openExternalNotificationSettingsOpensTheAppsNotificationSettings() {
        assertEquals(JsonNull, ok(reply(desk, "openExternal", args("url" to JsonPrimitive("porthole://notification-settings")))))
        val intent = started()!!
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, intent.action)
        assertEquals("ai.porthole.app", intent.getStringExtra(Settings.EXTRA_APP_PACKAGE))
    }

    @Test
    fun openExternalHttpsOpensACustomTab() {
        assertEquals(JsonNull, ok(reply(desk, "openExternal", args("url" to JsonPrimitive("https://example.com/docs?q=1")))))
        val intent = started()!!
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("https://example.com/docs?q=1", intent.dataString)
        assertTrue("it is a Custom Tab", intent.hasExtra("android.support.customtabs.extra.SESSION"))
    }

    @Test
    fun openExternalRefusesEverythingElse() {
        for (url in listOf("porthole://other", "http://x", "javascript:alert(1)", "intent://x#Intent;end", "file:///etc/passwd")) {
            errorOf(reply(desk, "openExternal", args("url" to JsonPrimitive(url))))
        }
        errorOf(reply(desk, "openExternal"))
        assertNull("nothing was started", started())
    }

    // --- everything else ----------------------------------------------------------------------------------------

    @Test
    fun anUnknownMethodIncludingOpenSettingsIsNotAllowed() {
        assertEquals("Bridge method not allowed: openSettings", errorOf(reply(desk, "openSettings")))
        assertEquals("Bridge method not allowed: nope", errorOf(reply(desk, "nope")))
    }
}
