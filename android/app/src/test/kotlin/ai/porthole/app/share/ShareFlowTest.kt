package ai.porthole.app.share

import ai.porthole.app.Intents
import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.shared.Machine
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShareFlowTest {
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val uploads = Uploads(HostClient(Http.create()), 1_024)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        machine = Machine("desk", "http://${server.hostName}:${server.port}")
        TestShareProvider.entries.clear()
        Robolectric.setupContentProvider(TestShareProvider::class.java, TestShareProvider.AUTHORITY)
        ShareHandoff.take()
    }

    @After
    fun tearDown() {
        runCatching { server.close() }
        ShareHandoff.take()
    }

    private fun reply(path: String) {
        server.enqueue(MockResponse.Builder().code(200).body("""{"path":"$path"}""").build())
    }

    private fun put(key: String, name: String, size: Int) =
        TestShareProvider.uri(key).also {
            TestShareProvider.entries[key] = TestShareProvider.Entry(name, "image/png", ByteArray(size))
        }

    @Test
    fun everyFileBecomesOneEventInOrderWithTheMachineAndOrigin() {
        reply("/up/1")
        reply("/up/2")
        val r = runBlocking {
            uploads.shareAll(machine, listOf(put("a", "a.png", 5), put("b", "b.png", 6)), "ignored caption", context.contentResolver)
        }
        assertNull(r.failure)
        assertEquals(
            listOf(
                ShareEvent("/up/1", "a.png", "desk", machine.origin),
                ShareEvent("/up/2", "b.png", "desk", machine.origin),
            ),
            r.events,
        )
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aFileThatFailsDoesNotStopTheOthers() {
        reply("/up/ok")
        val r = runBlocking {
            uploads.shareAll(machine, listOf(put("big", "big.png", 2_000), put("ok", "ok.png", 5)), null, context.contentResolver)
        }
        assertTrue(r.failure.toString(), r.failure is TooLarge)
        assertEquals(listOf(ShareEvent("/up/ok", "ok.png", "desk", machine.origin)), r.events)
    }

    @Test
    fun textOnlyIsUploadedAsASharedTextFile() {
        reply("/up/t")
        val r = runBlocking { uploads.shareAll(machine, emptyList(), "https://example.com", context.contentResolver) }
        assertEquals(listOf(ShareEvent("/up/t", "shared-text.txt", "desk", machine.origin)), r.events)
    }

    @Test
    fun nothingToSendGivesNoEventsAndNoFailure() {
        val r = runBlocking { uploads.shareAll(machine, emptyList(), null, context.contentResolver) }
        assertTrue(r.events.isEmpty())
        assertNull(r.failure)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun handoffTakeReturnsEverythingOnceAndClearsIt() {
        val first = ShareEvent("/p/1", "a", "desk", "https://desk.example.ts.net")
        val second = ShareEvent("/p/2", "b", "desk", "https://desk.example.ts.net")
        ShareHandoff.put(listOf(first))
        ShareHandoff.put(listOf(second))
        assertEquals(listOf(first, second), ShareHandoff.pending)
        assertEquals(listOf(first, second), ShareHandoff.take())
        assertEquals(emptyList<ShareEvent>(), ShareHandoff.take())
        assertEquals(emptyList<ShareEvent>(), ShareHandoff.pending)
    }

    @Test
    fun drainToHandsTheSinkTheEventsOnlyWhenThereAreSome() {
        val got = mutableListOf<List<ShareEvent>>()
        ShareHandoff.drainTo { got += it }
        assertTrue(got.isEmpty())
        val e = ShareEvent("/p/1", "a", "desk", "https://desk.example.ts.net")
        ShareHandoff.put(listOf(e))
        ShareHandoff.drainTo { got += it }
        ShareHandoff.drainTo { got += it }
        assertEquals(listOf(listOf(e)), got)
    }

    @Test
    fun mainIntentNamesMainActivityAndCarriesTheShareFlagAndOrigin() {
        val intent = ShareActivity.mainIntent(context, "https://desk.example.ts.net")
        assertEquals("ai.porthole.app.web.MainActivity", intent.component!!.className)
        assertEquals(context.packageName, intent.component!!.packageName)
        assertTrue(intent.getBooleanExtra(Intents.EXTRA_SHARE, false))
        assertEquals("https://desk.example.ts.net", intent.getStringExtra(Intents.EXTRA_ORIGIN))
    }
}
