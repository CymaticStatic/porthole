package ai.porthole.app.web

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.app.R
import ai.porthole.app.events.ConnectionHub
import ai.porthole.app.events.EventsService
import ai.porthole.app.net.Online
import ai.porthole.app.settings.MachinesActivity
import ai.porthole.app.share.Pickers
import ai.porthole.app.share.ShareEvent
import ai.porthole.app.share.ShareHandoff
import ai.porthole.app.share.ShareIntents
import ai.porthole.shared.Machine
import ai.porthole.shared.Origins
import ai.porthole.shared.Routes
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The whole app UI for the shared Porthole page: one WebView showing one machine at a time (design decision 4), plus
 * the native bridge ([BridgeHost]). Native screens are separate activities.
 */
class MainActivity : ComponentActivity() {
    private class PendingShare(val machine: Machine, val events: List<ShareEvent>)

    private lateinit var webView: WebView
    private lateinit var outbox: EventOutbox
    private lateinit var methods: BridgeMethods
    private lateinit var bridge: BridgeHost
    private lateinit var pickers: Pickers
    private lateinit var emptyState: View
    private lateinit var updateBanner: View
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }

    /** Recordings outlive the activity's own scope just long enough for `onStop` to deliver what was recorded. */
    private val recordingScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var micAnswer: CompletableDeferred<Boolean>? = null
    private val micRequest =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { micAnswer?.complete(it) }
    private val notificationRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    /** The machine whose page has finished loading and is on screen now, or null while a page loads. */
    private var shownOrigin: String? = null
    private var pendingShare: PendingShare? = null
    private var online: Boolean? = null
    private lateinit var client: PortholeWebClient

    private val machines get() = Graph.machines.machines

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // No page has posted a message yet, so events (the share from ShareActivity) wait in the outbox.
        outbox = EventOutbox()
        outbox.onNewFrame()

        webView = WebView(this)
        WebViewSetup.apply(webView)
        client = PortholeWebClient(
            context = this,
            machines = { machines.value },
            onPageStarted = ::pageStarted,
            onPageFinished = ::pageFinished,
            onHistoryChanged = { back.isEnabled = webView.canGoBack() },
        )
        webView.webViewClient = client
        onBackPressedDispatcher.addCallback(this, back)

        // Both launchers must exist before the activity is STARTED.
        pickers = Pickers(this)
        methods = BridgeMethods(
            context = this,
            machines = { machines.value },
            outbox = outbox,
            scope = recordingScope,
            pick = { source, machine -> pickers.pick(source, machine) },
            micPermission = ::microphone,
        )
        val registry = Graph.once<WebMessageRegistryFactory> { WebMessageRegistryFactory { WebViewRegistry(it) } }.create(webView)
        bridge = BridgeHost(registry, { machines.value }, methods, outbox, lifecycleScope)

        setContentView(buildLayout())
        watchMachines()
        watchNetwork()

        // A foreground activity may start the foreground service; it is idempotent.
        EventsService.start(this)
        askForNotifications()

        if (!handle(intent)) loadDefault()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onStop() {
        methods.onBackground()
        super.onStop()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    // --- intents ------------------------------------------------------------------------------------------------

    /** Loads what [intent] asks for. False when it asks for nothing (the app then opens its default machine). */
    private fun handle(intent: Intent): Boolean {
        if (intent.getBooleanExtra(Intents.EXTRA_SHARE, false)) return handleShare(intent)
        if (intent.action == Intent.ACTION_VIEW) {
            val url = Routes.parseOpenLink(intent.dataString ?: return false, machines.value) ?: return false
            webView.loadUrl(url)
            return true
        }
        return false
    }

    private fun handleShare(intent: Intent): Boolean {
        val events = ShareHandoff.take()
        val origin = intent.getStringExtra(Intents.EXTRA_ORIGIN)?.let(Origins::normalize) ?: return false
        val machine = machines.value.firstOrNull { it.origin == origin } ?: return false
        if (shownOrigin == machine.origin) {
            events.forEach(::emitShare)
            routeShare(machine)
        } else {
            // The page is not there yet: events wait for it to finish loading, then the open list is read from it.
            pendingShare = PendingShare(machine, events)
            webView.loadUrl(machine.origin)
        }
        return true
    }

    private fun emitShare(event: ShareEvent) {
        outbox.emit(EventOutbox.SHARE, Json.encodeToJsonElement(ShareEvent.serializer(), event))
    }

    /** Reads the machine page's open chats and switches the page to the last chat, or to the inbox picker. */
    private fun routeShare(machine: Machine) {
        Graph.once<OpenListReader> { RealOpenListReader }.read(webView) { json ->
            webView.loadUrl(machine.origin + "/" + ShareIntents.lastChatRoute(json, machine.name))
        }
    }

    // --- page events --------------------------------------------------------------------------------------------

    private fun pageStarted() {
        shownOrigin = null
        outbox.onNewFrame()
        // The new page asks nothing yet; it learns the connection state with its first message.
        online?.let(::emitNetwork)
    }

    private fun pageFinished(url: String) {
        val machine = machines.value.firstOrNull { it.owns(url) } ?: return
        shownOrigin = machine.origin
        prefs.edit { putString(LAST_ORIGIN, machine.origin) }
        val share = pendingShare
        if (share != null && share.machine.origin == machine.origin) {
            pendingShare = null
            share.events.forEach(::emitShare)
            routeShare(share.machine)
        }
    }

    private fun Machine.owns(url: String): Boolean {
        val base = origin.trimEnd('/')
        return url == base || url.startsWith("$base/") || url.startsWith("$base?") || url.startsWith("$base#")
    }

    private fun emitNetwork(isOnline: Boolean) {
        outbox.emit(EventOutbox.NETWORK, buildJsonObject { put("online", isOnline) })
    }

    private fun watchNetwork() {
        lifecycleScope.launch {
            ConnectionHub.shared().online
                .map { states -> states.values.any { it == Online.CONNECTED } }
                .distinctUntilChanged()
                .collect {
                    online = it
                    emitNetwork(it)
                }
        }
    }

    /** Keeps the bridge's allowed origins equal to the machine list, and the empty state in step with it. */
    private fun watchMachines() {
        lifecycleScope.launch {
            var first = true
            machines.collect { list ->
                updateBanner.visibility = if (bridge.install()) View.GONE else View.VISIBLE
                emptyState.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
                // The first value only sets up the screen; onCreate decides what to load.
                if (!first && list.isNotEmpty() && webView.url == null && pendingShare == null) loadDefault()
                first = false
            }
        }
    }

    private fun loadDefault() {
        val list = machines.value
        val last = prefs.getString(LAST_ORIGIN, null)
        val machine = list.firstOrNull { it.origin == last } ?: list.firstOrNull() ?: return
        webView.loadUrl(machine.origin)
    }

    // --- permissions --------------------------------------------------------------------------------------------

    private suspend fun microphone(): Boolean {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        val answer = CompletableDeferred<Boolean>()
        micAnswer = answer
        micRequest.launch(Manifest.permission.RECORD_AUDIO)
        return answer.await()
    }

    private fun askForNotifications() {
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (prefs.getBoolean(ASKED_NOTIFICATIONS, false)) return
        prefs.edit { putBoolean(ASKED_NOTIFICATIONS, true) }
        notificationRequest.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // --- layout -------------------------------------------------------------------------------------------------

    private fun buildLayout(): View {
        val dp = resources.displayMetrics.density
        val pad = (16 * dp).toInt()
        val root = FrameLayout(this)
        root.addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))

        updateBanner = TextView(this).apply {
            text = getString(R.string.web_update_webview_detail)
            setBackgroundColor(Color.parseColor("#B3261E"))
            setTextColor(Color.WHITE)
            setPadding(pad, pad, pad, pad)
            contentDescription = getString(R.string.web_update_webview)
            visibility = View.GONE
        }
        root.addView(updateBanner, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP))

        emptyState = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            addView(TextView(context).apply {
                text = getString(R.string.web_no_machines)
                textSize = 18f
                gravity = Gravity.CENTER
            })
            addView(Button(context).apply {
                text = getString(R.string.web_open_machines)
                setOnClickListener { startActivity(Intent(this@MainActivity, MachinesActivity::class.java)) }
            })
            visibility = View.GONE
        }
        root.addView(emptyState, FrameLayout.LayoutParams(MATCH, MATCH))

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        return root
    }

    companion object {
        private const val PREFS = "web"
        private const val LAST_ORIGIN = "last_origin"
        private const val ASKED_NOTIFICATIONS = "asked_notifications"
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
