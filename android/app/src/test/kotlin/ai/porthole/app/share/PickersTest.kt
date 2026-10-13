package ai.porthole.app.share

import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.shared.Machine
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityOptionsCompat
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A registry that answers every launch at once with whatever [outcome] says, so no real picker is needed. */
private class FakeRegistry(private val outcome: (Any?) -> Any?) : ActivityResultRegistry() {
    val launched = mutableListOf<Any?>()

    override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
        launched += input
        @Suppress("UNCHECKED_CAST")
        dispatchResult(requestCode, outcome(input) as O)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PickersTest {
    private lateinit var server: MockWebServer
    private lateinit var machine: Machine
    private lateinit var activity: ComponentActivity
    private val uploads = Uploads(HostClient(Http.create()), 1_024)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        machine = Machine("test", "http://${server.hostName}:${server.port}")
        TestShareProvider.entries.clear()
        Robolectric.setupContentProvider(TestShareProvider::class.java, TestShareProvider.AUTHORITY)
        // FileProvider caches each authority's roots in a static map; every test has its own cache directory.
        androidx.core.content.FileProvider::class.java.getDeclaredField("sCache").apply { isAccessible = true }
            .let { (it.get(null) as MutableMap<*, *>).clear() }
    }

    @After
    fun tearDown() {
        runCatching { server.close() }
    }

    private fun reply(code: Int = 200, body: String = """{"path":"/home/ben/uploads/p"}""") {
        server.enqueue(MockResponse.Builder().code(code).body(body).build())
    }

    /** The picker set up the way `MainActivity` does: created, then the pickers, then started. */
    private fun pickers(registry: FakeRegistry): Pickers {
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).create()
        activity = controller.get()
        val pickers = Pickers(activity, uploads, registry)
        controller.start().resume()
        return pickers
    }

    private fun pick(p: Pickers, source: String) = runBlocking { p.pick(source, machine) }

    private fun serve(key: String, name: String, bytes: ByteArray = "image bytes".toByteArray()): Uri {
        TestShareProvider.entries[key] = TestShareProvider.Entry(name, "image/jpeg", bytes)
        return TestShareProvider.uri(key)
    }

    @Test
    fun photoOpensTheImageOnlyPhotoPickerAndUploadsTheChoice() {
        reply()
        val registry = FakeRegistry { serve("p1", "holiday.jpg") }
        val got = pick(pickers(registry), "photo")
        assertEquals(PickedFile("/home/ben/uploads/p", "holiday.jpg"), got)
        val request = registry.launched.single() as PickVisualMediaRequest
        assertEquals(ActivityResultContracts.PickVisualMedia.ImageOnly, request.mediaType)
        val body = server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8()
        assertTrue(body, body.contains("""filename="holiday.jpg""""))
        assertTrue(body, body.contains("image bytes"))
    }

    @Test
    fun fileOpensTheDocumentPickerForAnyType() {
        reply()
        val registry = FakeRegistry { serve("f1", "notes.pdf") }
        val got = pick(pickers(registry), "file")
        assertEquals("notes.pdf", got!!.name)
        assertArrayEquals(arrayOf("*/*"), registry.launched.single() as Array<*>)
    }

    @Test
    fun backingOutReturnsNullAndUploadsNothing() {
        reply()
        val p = pickers(FakeRegistry { null })
        assertNull(pick(p, "photo"))
        assertNull(pick(p, "file"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun cameraTakesThePictureIntoCacheCameraThenUploadsAndCleansUp() {
        reply()
        val registry = FakeRegistry { input ->
            activity.contentResolver.openOutputStream(input as Uri)!!.use { it.write("jpeg data".toByteArray()) }
            true
        }
        val p = pickers(registry)
        val got = pick(p, "camera")!!
        assertTrue(got.name, got.name.startsWith("photo-") && got.name.endsWith(".jpg"))
        val launchedUri = registry.launched.single() as Uri
        assertEquals("${activity.packageName}.files", launchedUri.authority)
        val body = server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8()
        assertTrue(body, body.contains("jpeg data"))
        assertEquals(emptyList<File>(), File(activity.cacheDir, "camera").listFiles()!!.toList())
    }

    @Test
    fun aCancelledCameraUploadsNothingAndLeavesNoFile() {
        reply()
        val p = pickers(FakeRegistry { false })
        assertNull(pick(p, "camera"))
        assertEquals(0, server.requestCount)
        assertEquals(emptyList<File>(), File(activity.cacheDir, "camera").listFiles()!!.toList())
    }

    @Test
    fun unknownSourcesIncludingClipboardAreRefusedBeforeAnyPickerOpens() {
        val registry = FakeRegistry { null }
        val p = pickers(registry)
        for (source in listOf("clipboard", "", "Camera", "photo ", "files")) {
            val e = assertThrows(IllegalArgumentException::class.java) { pick(p, source) }
            assertEquals("Unknown source", e.message)
        }
        assertTrue(registry.launched.isEmpty())
    }

    @Test
    fun aFailedUploadThrowsSoThePageLearnsWhy() {
        val registry = FakeRegistry { serve("big", "big.bin", ByteArray(2_000)) }
        val e = assertThrows(TooLarge::class.java) { pick(pickers(registry), "file") }
        assertEquals("Too big: 50 MB limit", e.message)
        reply(500, "boom")
        val registry2 = FakeRegistry { serve("small", "small.bin", ByteArray(5)) }
        assertThrows(IOException::class.java) { pick(pickers(registry2), "file") }
    }
}
