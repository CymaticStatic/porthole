package ai.porthole.app.net

import ai.porthole.shared.AnswerOutcome
import ai.porthole.shared.Machine
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HostClientTest {
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private lateinit var origin: String
    private val host = HostClient(Http.create())

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
        origin = "http://${server.hostName}:${server.port}"
        machine = Machine("test", origin)
    }

    @After
    fun stopServer() {
        runCatching { server.close() } // a test may already have closed it
    }

    private fun reply(code: Int, body: String = "") {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
    }

    private fun next(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS)!!

    private fun answer(): AnswerOutcome = runBlocking { host.answer(machine, "item-1", listOf(1), "Yes") }

    @Test
    fun answerPostsTheOptionIndexesAsJson() {
        reply(200, """{"status":"sent","reason":"ok"}""")
        assertEquals(AnswerOutcome.Sent("Yes"), answer())
        val request = next()
        assertEquals("POST", request.method)
        assertEquals("/v1/inbox/item-1/answer", request.target)
        assertEquals("application/json", request.headers["Content-Type"])
        assertEquals("""{"optionIndexes":[1]}""", request.body!!.utf8())
    }

    @Test
    fun answerPercentEncodesTheItemId() {
        reply(200, """{"status":"sent"}""")
        runBlocking { host.answer(machine, "tmux:t 1/2", listOf(0)) }
        assertEquals("/v1/inbox/tmux%3At%201%2F2/answer", next().target)
    }

    @Test
    fun answerMaps409ToRefusedWithHostdsReason() {
        reply(409, """{"status":"refused","reason":"question closed"}""")
        assertEquals(AnswerOutcome.Refused("question closed"), answer())
    }

    @Test
    fun answerMaps404ToGone() {
        reply(404, """{"error":"no such item"}""")
        assertEquals(AnswerOutcome.Gone, answer())
    }

    @Test
    fun answerMaps500ToFailed() {
        reply(500, "boom")
        assertTrue(answer() is AnswerOutcome.Failed)
    }

    @Test
    fun answerMapsAnUnparseable200ToFailed() {
        reply(200, "not json")
        assertTrue(answer() is AnswerOutcome.Failed)
    }

    @Test
    fun answerMapsASocketClosedMidRequestToFailed() {
        // OkHttp retries a dropped connection once, so the retry meets the second closing response.
        repeat(3) { server.enqueue(MockResponse.Builder().onRequestStart(SocketEffect.CloseSocket()).build()) }
        assertTrue(answer() is AnswerOutcome.Failed)
    }

    @Test
    fun answerMapsAnUnreachableServerToFailed() {
        server.close()
        assertTrue(answer() is AnswerOutcome.Failed)
    }

    @Test
    fun keysPostsEscToThePercentEncodedSessionPath() {
        reply(200, """{"ok":true}""")
        val result = runBlocking { host.keys(machine, "tmux:t:main:0.0", listOf("Esc")) }
        assertTrue(result.isSuccess)
        val request = next()
        assertEquals("POST", request.method)
        assertEquals("/v1/sessions/tmux%3At%3Amain%3A0.0/keys", request.target)
        assertEquals("""{"keys":["Esc"]}""", request.body!!.utf8())
        assertEquals("application/json", request.headers["Content-Type"])
    }

    @Test
    fun keysFailsOnAnErrorStatus() {
        reply(404, """{"error":"no such session"}""")
        val failure = runBlocking { host.keys(machine, "s", listOf("Esc")) }.exceptionOrNull()
        assertEquals(404, (failure as HostException).code)
    }

    @Test
    fun uploadPostsMultipartFieldFileWithNameAndMime() {
        reply(200, """{"path":"/tmp/porthole/shot.png"}""")
        val result = runBlocking {
            host.upload(machine, "shot.png", "image/png", "PNGBYTES".toRequestBody())
        }
        assertEquals("/tmp/porthole/shot.png", result.getOrThrow().path)
        val request = next()
        assertEquals("POST", request.method)
        assertEquals("/v1/uploads", request.target)
        assertTrue(request.headers["Content-Type"]!!.startsWith("multipart/form-data; boundary="))
        val body = request.body!!.utf8()
        assertTrue(body, body.contains("""Content-Disposition: form-data; name="file"; filename="shot.png""""))
        assertTrue(body, body.contains("Content-Type: image/png"))
        assertTrue(body, body.contains("PNGBYTES"))
    }

    @Test
    fun uploadFailsWhenHostdSays413() {
        reply(413, """{"error":"too big"}""")
        val failure = runBlocking {
            host.upload(machine, "big.bin", "application/octet-stream", "x".toRequestBody())
        }.exceptionOrNull()
        assertEquals(413, (failure as HostException).code)
    }

    @Test
    fun machineParsesNameAndDevice() {
        reply(
            200,
            """{"name":"bendesk-omarchy","version":"1","authMode":"tailscale","you":{"device":"bencell","via":"serve"},"features":{}}""",
        )
        val info = runBlocking { host.machine(machine) }.getOrThrow()
        assertEquals("bendesk-omarchy", info.name)
        assertEquals("bencell", info.you!!.device)
        val request = next()
        assertEquals("GET", request.method)
        assertEquals("/v1/machine", request.target)
    }

    @Test
    fun machineFailsOnAnUnreachableServer() {
        server.close()
        assertTrue(runBlocking { host.machine(machine) }.isFailure)
    }

    @Test
    fun usageParsesWindowsAndFailsWhenFeatureIsOff() {
        reply(200, """{"windows":[{"id":"5h","usedPercent":72,"resetsAt":"x","status":"ok"}],"readAt":1}""")
        reply(404, """{"error":"off"}""")
        val usage = runBlocking { host.usage(machine) }.getOrThrow()
        assertEquals(72.0, usage.windows.single().usedPercent!!, 0.0)
        assertEquals("/v1/usage", next().target)
        assertEquals(404, (runBlocking { host.usage(machine) }.exceptionOrNull() as HostException).code)
    }

    @Test
    fun inboxParsesTheItems() {
        reply(
            200,
            """{"items":[{"id":"i1","key":"k","sessionId":"tmux:a:0","machine":"desk","project":"p","kind":"question",
            "column":"needs-you","title":"Proceed?","body":"b","createdAt":1,"updatedAt":2}]}""",
        )
        val items = runBlocking { host.inbox(machine) }.getOrThrow()
        assertEquals(listOf("i1"), items.map { it.id })
        assertEquals("needs-you", items.single().column)
        assertEquals("/v1/inbox", next().target)
    }

    @Test
    fun everyRequestCarriesPortholeAndOriginAndNoCredentials() {
        server.enqueue(MockResponse.Builder().code(200).addHeader("Set-Cookie", "sid=1; Path=/").body("""{"name":"m"}""").build())
        reply(200, """{"status":"sent"}""")
        reply(200, "{}")
        reply(200, """{"windows":[]}""")
        reply(200, """{"items":[]}""")
        reply(200, """{"path":"/p"}""")
        runBlocking {
            host.machine(machine)
            host.answer(machine, "i", listOf(0))
            host.keys(machine, "s", listOf("Esc"))
            host.usage(machine)
            host.inbox(machine)
            host.upload(machine, "a.txt", "text/plain", "a".toRequestBody())
        }
        repeat(6) {
            val request = next()
            assertEquals(request.requestLine, "1", request.headers["X-Porthole"])
            assertEquals(request.requestLine, origin, request.headers["Origin"])
            assertNull(request.requestLine, request.headers["Authorization"])
            assertNull("the first reply's Set-Cookie must not come back: " + request.requestLine, request.headers["Cookie"])
        }
    }
}
