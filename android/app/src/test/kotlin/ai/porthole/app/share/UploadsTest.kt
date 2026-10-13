package ai.porthole.app.share

import ai.porthole.app.net.Http
import ai.porthole.app.net.HostClient
import ai.porthole.shared.Machine
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UploadsTest {
    private val limit = 1_024L
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private lateinit var resolver: ContentResolver
    private val uploads = Uploads(HostClient(Http.create()), limit)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        machine = Machine("test", "http://${server.hostName}:${server.port}")
        resolver = ApplicationProvider.getApplicationContext<Context>().contentResolver
        TestShareProvider.entries.clear()
        Robolectric.setupContentProvider(TestShareProvider::class.java, TestShareProvider.AUTHORITY)
    }

    @After
    fun tearDown() {
        runCatching { server.close() }
    }

    private fun reply(code: Int = 200, body: String = """{"path":"/home/ben/uploads/x"}""") {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
    }

    private fun next(): RecordedRequest = server.takeRequest(5, TimeUnit.SECONDS)!!

    private fun put(key: String, entry: TestShareProvider.Entry): Uri {
        TestShareProvider.entries[key] = entry
        return TestShareProvider.uri(key)
    }

    private fun send(uri: Uri) = runBlocking { uploads.send(machine, uri, resolver) }

    /** A stream with no end, registered for a uri no provider serves: only a limit can stop reading it. */
    private fun endless(path: String): Uri {
        val uri = Uri.parse("content://nobody/$path")
        shadowOf(resolver).registerInputStream(uri, object : InputStream() {
            override fun read(): Int = 0
            override fun read(b: ByteArray, off: Int, len: Int): Int = len
        })
        return uri
    }

    @Test
    fun multipartBodyCarriesTheDisplayNameMimeAndBytes() {
        reply()
        val uri = put("1", TestShareProvider.Entry("report.pdf", "application/pdf", "hello bytes".toByteArray()))
        assertEquals("/home/ben/uploads/x", send(uri).getOrThrow().path)
        val request = next()
        assertEquals("POST", request.method)
        assertEquals("/v1/uploads", request.target)
        assertTrue(request.headers["Content-Type"]!!.startsWith("multipart/form-data"))
        assertEquals("1", request.headers["X-Porthole"])
        val body = request.body!!.utf8()
        assertTrue(body, body.contains("""name="file"; filename="report.pdf""""))
        assertTrue(body, body.contains("Content-Type: application/pdf"))
        assertTrue(body, body.contains("hello bytes"))
    }

    @Test
    fun uploadAlsoReturnsTheNameTheFileWentUnder() {
        reply()
        val uri = put("2", TestShareProvider.Entry("IMG_0042.jpg", "image/jpeg", ByteArray(10)))
        val done = runBlocking { uploads.upload(machine, uri, resolver) }.getOrThrow()
        assertEquals(Uploaded("/home/ben/uploads/x", "IMG_0042.jpg"), done)
    }

    @Test
    fun aFileWithoutMetadataUsesTheUriNameAndOctetStream() {
        reply()
        val uri = put("notes.txt", TestShareProvider.Entry(null, null, "abc".toByteArray(), reportSize = false))
        send(uri).getOrThrow()
        val body = next().body!!.utf8()
        assertTrue(body, body.contains("""filename="notes.txt""""))
        assertTrue(body, body.contains("Content-Type: application/octet-stream"))
    }

    @Test
    fun aFileOfExactlyTheLimitIsUploaded() {
        reply()
        val uri = put("3", TestShareProvider.Entry("full.bin", "application/octet-stream", ByteArray(limit.toInt()), reportSize = false))
        assertTrue(send(uri).isSuccess)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aStreamPastTheLimitFailsTooBigAndNoCompleteRequestReachesTheServer() {
        reply() // a complete request would be answered 200, so success here would show the limit did not stop it
        val result = send(endless("big.bin"))
        val e = result.exceptionOrNull()
        assertTrue(e.toString(), e is TooLarge)
        assertEquals("Too big: 50 MB limit", e!!.message)
        assertNull(server.takeRequest(1, TimeUnit.SECONDS))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aFileWhoseReportedSizeIsOverTheLimitIsRefusedBeforeAnyRequest() {
        reply()
        val uri = put("4", TestShareProvider.Entry("big.bin", "application/octet-stream", ByteArray(limit.toInt() + 1)))
        val e = send(uri).exceptionOrNull()
        assertTrue(e.toString(), e is TooLarge)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun aFileThatLiesAboutItsSizeIsStillStoppedWhileStreaming() {
        reply()
        val uri = put("5", TestShareProvider.Entry("liar.bin", "application/octet-stream", ByteArray(limit.toInt() + 1), reportSize = false))
        val e = send(uri).exceptionOrNull()
        assertTrue(e.toString(), e is TooLarge)
        assertNull(server.takeRequest(1, TimeUnit.SECONDS))
    }

    @Test
    fun hostdsOwn413ReadsTheSame() {
        reply(413, """{"error":"too big"}""")
        val uri = put("6", TestShareProvider.Entry("a.bin", null, ByteArray(10)))
        val e = send(uri).exceptionOrNull()
        assertTrue(e.toString(), e is TooLarge)
        assertEquals("Too big: 50 MB limit", e!!.message)
    }

    @Test
    fun anotherServerErrorKeepsItsOwnMessage() {
        reply(500, "boom")
        val uri = put("7", TestShareProvider.Entry("a.bin", null, ByteArray(10)))
        val e = send(uri).exceptionOrNull()
        assertNotNull(e)
        assertTrue(e.toString(), e is IOException && e !is TooLarge)
        assertEquals("HTTP 500", e!!.message)
    }

    @Test
    fun aUriNobodyServesFailsWithoutARequest() {
        reply()
        val e = send(TestShareProvider.uri(TestShareProvider.DENIED)).exceptionOrNull()
        assertEquals("Couldn't read the file", e!!.message)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun sharedTextIsUploadedAsATextFile() {
        reply()
        val done = runBlocking { uploads.sendText(machine, "https://example.com/a?b=c") }.getOrThrow()
        assertEquals("shared-text.txt", done.name)
        val body = next().body!!.utf8()
        assertTrue(body, body.contains("""filename="shared-text.txt""""))
        assertTrue(body, body.contains("Content-Type: text/plain; charset=utf-8"))
        assertTrue(body, body.contains("https://example.com/a?b=c"))
    }

    @Test
    fun sharedTextPastTheLimitIsRefused() {
        reply()
        val e = runBlocking { uploads.sendText(machine, "x".repeat(limit.toInt() + 1)) }.exceptionOrNull()
        assertTrue(e.toString(), e is TooLarge)
        assertEquals(0, server.requestCount)
    }
}
