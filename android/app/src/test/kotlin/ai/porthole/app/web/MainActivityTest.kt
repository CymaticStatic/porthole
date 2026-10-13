package ai.porthole.app.web

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.app.share.ShareEvent
import ai.porthole.app.share.ShareHandoff
import ai.porthole.app.voice.AudioFocus
import ai.porthole.app.voice.LastRecording
import ai.porthole.app.voice.Speaker
import ai.porthole.app.voice.TtsEngine
import ai.porthole.shared.Machine
import ai.porthole.shared.Routes
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.JavaScriptExecutionException
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewOutcomeReceiver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

private class MainRegistry : WebMessageRegistry {
    var listener: WebViewCompat.WebMessageListener? = null
    var supported = true

    override fun supported() = supported
    override fun add(originRules: Set<String>, listener: WebViewCompat.WebMessageListener) {
        this.listener = listener
    }

    override fun remove() {
        listener = null
    }
}

private class MainEngine : TtsEngine {
    override var listener: ((id: String, done: Boolean) -> Unit)? = null
    override var errorListener: ((id: String) -> Unit)? = null
    override fun speak(text: String, id: String) = Unit
    override fun stop() = Unit
}

private class MainFocus : AudioFocus {
    override fun request() = Unit
    override fun abandon() = Unit
}

private class RecordingProxy : JavaScriptReplyProxy() {
    val posted = mutableListOf<String>()
    override fun postMessage(message: String) {
        posted.add(message)
    }

    override fun postMessage(arrayBuffer: ByteArray) = Unit
    override fun executeJavaScript(script: String, callback: WebViewOutcomeReceiver<String, JavaScriptExecutionException>?) = Unit
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivityTest {
    private lateinit var desk: Machine
    private lateinit var lap: Machine
    private val registry = MainRegistry()
    private var openList: String? = null
    private val reads = mutableListOf<WebView>()
    private var controller: ActivityController<MainActivity>? = null

    @Before
    fun setUp() {
        Graph.init(ApplicationProvider.getApplicationContext())
        for (m in Graph.machines.machines.value) Graph.machines.remove(m.name) // the defaults would need a network
        desk = Graph.machines.add("desk", "https://desk.tailx.ts.net").getOrThrow().first { it.name == "desk" }
        lap = Graph.machines.add("lap", "https://lap.tailx.ts.net").getOrThrow().first { it.name == "lap" }
        Graph.provide(Speaker::class.java, Speaker(MainEngine(), MainFocus()))
        Graph.provide(LastRecording::class.java, LastRecording())
        Graph.provide(WebMessageRegistryFactory::class.java, WebMessageRegistryFactory { registry })
        Graph.provide(OpenListReader::class.java, OpenListReader { view, done ->
            reads.add(view)
            done(openList)
        })
        ShareHandoff.take()
    }

    @After
    fun tearDown() {
        controller?.let { runCatching { it.pause().stop().destroy() } }
        ShareHandoff.take()
        Graph.reset()
    }

    private fun launch(intent: Intent = Intent(Intent.ACTION_MAIN)): MainActivity {
        val c = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        controller = c
        return c.get()
    }

    private fun webViewOf(activity: MainActivity): WebView {
        fun find(v: View): WebView? {
            if (v is WebView) return v
            if (v is ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i))?.let { return it }
            return null
        }
        return checkNotNull(find(activity.findViewById<ViewGroup>(android.R.id.content)))
    }

    private fun loaded(activity: MainActivity) = shadowOf(webViewOf(activity)).lastLoadedUrl

    private fun openLink(machine: Machine, route: String) =
        Intent(Intent.ACTION_VIEW, Uri.parse(Routes.openLink(machine.origin, route)))

    private fun shareIntent(machine: Machine) = Intent(Intent.ACTION_MAIN)
        .putExtra(Intents.EXTRA_SHARE, true)
        .putExtra(Intents.EXTRA_ORIGIN, machine.origin)

    private fun shareEvent() = ShareEvent("/cache/a.jpg", "a.jpg", "desk", desk.origin)

    @Test
    fun openingTheAppLoadsTheFirstMachineAndRemembersTheOneThatFinishedLoading() {
        val a = launch()
        assertEquals(desk.origin, loaded(a)?.trimEnd('/'))

        // The page for the other machine finishes: it becomes the one the app reopens with.
        val view = webViewOf(a)
        shadowOf(view).webViewClient.onPageFinished(view, lap.origin + "/")
        controller!!.pause().stop().destroy()

        val b = launch()
        assertEquals(lap.origin, loaded(b)?.trimEnd('/'))
    }

    @Test
    fun anOpenLinkInOnCreateLoadsTheMatchingChatUrl() {
        val a = launch(openLink(desk, "#/chat/desk/tmux%3Ax%3A1.2"))
        assertEquals("https://desk.tailx.ts.net/#/chat/desk/tmux%3Ax%3A1.2", loaded(a))
    }

    @Test
    fun anOpenLinkInOnNewIntentLoadsTheMatchingUrl() {
        val a = launch()
        controller!!.newIntent(openLink(lap, "#/inbox"))
        assertEquals("https://lap.tailx.ts.net/#/inbox", loaded(a))
    }

    @Test
    fun anOpenLinkWithAnUnknownOriginLoadsNothingNew() {
        val a = launch()
        val before = loaded(a)
        val stranger = Machine("evil", "https://evil.tailx.ts.net")
        controller!!.newIntent(openLink(stranger, "#/inbox"))
        assertEquals(before, loaded(a))
        assertEquals(desk.origin, before?.trimEnd('/'))
    }

    @Test
    fun anOpenLinkWithAnUnknownOriginInOnCreateOpensTheAppAsNormal() {
        val a = launch(openLink(Machine("evil", "https://evil.tailx.ts.net"), "#/inbox"))
        assertEquals(desk.origin, loaded(a)?.trimEnd('/'))
    }

    @Test
    fun aShareLoadsTheMachineThenSwitchesToItsLastChatOncePageHasLoaded() {
        openList = """[{"machine":"desk","sessionId":"tmux:x:1.2","view":"chat"}]"""
        ShareHandoff.put(listOf(shareEvent()))
        val a = launch(shareIntent(desk))
        val view = webViewOf(a)

        assertEquals("the machine's page loads first", desk.origin, loaded(a)?.trimEnd('/'))
        assertTrue("the open list is read from the loaded page, not before", reads.isEmpty())

        shadowOf(view).webViewClient.onPageFinished(view, desk.origin + "/")

        assertEquals(listOf(view), reads)
        assertEquals("https://desk.tailx.ts.net/#/chat/desk/tmux%3Ax%3A1.2", loaded(a))
        assertTrue("the hand-off was taken", ShareHandoff.take().isEmpty())
    }

    @Test
    fun aShareWithNoOpenChatLoadsTheInbox() {
        openList = null
        ShareHandoff.put(listOf(shareEvent()))
        val a = launch(shareIntent(desk))
        val view = webViewOf(a)
        shadowOf(view).webViewClient.onPageFinished(view, desk.origin + "/")
        assertEquals("https://desk.tailx.ts.net/#/inbox", loaded(a))
    }

    @Test
    fun aShareForAMachineAlreadyShowingSwitchesRightAway() {
        val a = launch()
        val view = webViewOf(a)
        shadowOf(view).webViewClient.onPageFinished(view, desk.origin + "/")
        openList = """[{"machine":"desk","sessionId":"s1","view":"chat"}]"""
        ShareHandoff.put(listOf(shareEvent()))

        controller!!.newIntent(shareIntent(desk))

        assertEquals("https://desk.tailx.ts.net/#/chat/desk/s1", loaded(a))
    }

    @Test
    fun aShareForAnUnconfiguredOriginIsIgnored() {
        ShareHandoff.put(listOf(shareEvent()))
        val a = launch(shareIntent(Machine("evil", "https://evil.tailx.ts.net")))
        assertEquals(desk.origin, loaded(a)?.trimEnd('/'))
        assertTrue(reads.isEmpty())
    }

    @Test
    fun theShareEventReachesThePageWhenItPostsItsFirstMessage() {
        ShareHandoff.put(listOf(shareEvent()))
        val a = launch(shareIntent(desk))
        val view = webViewOf(a)
        shadowOf(view).webViewClient.onPageStarted(view, desk.origin + "/", null)
        shadowOf(view).webViewClient.onPageFinished(view, desk.origin + "/")

        val proxy = RecordingProxy()
        val listener = checkNotNull(registry.listener)
        listener.onPostMessage(view, WebMessageCompat("""{"id":1,"method":"machines","args":{}}"""), Uri.parse(desk.origin), true, proxy)

        val frames = proxy.posted.map { Json.parseToJsonElement(it).jsonObject }
        val share = frames.single { it["event"]?.jsonPrimitive?.content == "share" }
        assertEquals("/cache/a.jpg", share["data"]!!.jsonObject["path"]!!.jsonPrimitive.content)
        assertEquals(desk.origin, share["data"]!!.jsonObject["origin"]!!.jsonPrimitive.content)
        assertNotNull("the reply to the call follows the events", frames.single { it["id"] != null })
    }

    @Test
    fun anOldWebViewShowsTheUpdateBannerAndInstallsNoBridge() {
        registry.supported = false
        val a = launch()
        assertEquals(null, registry.listener)
        val text = a.getString(ai.porthole.app.R.string.web_update_webview_detail)
        assertEquals(View.VISIBLE, textView(a, text).visibility)
    }

    @Test
    fun theUpdateBannerStaysHiddenWhenTheBridgeIsInstalled() {
        val a = launch()
        assertNotNull(registry.listener)
        val text = a.getString(ai.porthole.app.R.string.web_update_webview_detail)
        assertEquals(View.GONE, textView(a, text).visibility)
    }

    @Test
    fun withNoMachinesTheAppShowsHowToAddOneAndLoadsNothing() {
        for (m in Graph.machines.machines.value) Graph.machines.remove(m.name)
        val a = launch()
        val text = a.getString(ai.porthole.app.R.string.web_no_machines)
        assertEquals(View.VISIBLE, (textView(a, text).parent as View).visibility)
        assertEquals(null, loaded(a))
    }

    private fun textView(a: MainActivity, text: String): android.widget.TextView {
        fun find(v: View): android.widget.TextView? {
            if (v is android.widget.TextView && v.text.toString() == text) return v
            if (v is ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i))?.let { return it }
            return null
        }
        return checkNotNull(find(a.findViewById<ViewGroup>(android.R.id.content))) { "no view with text $text" }
    }
}
