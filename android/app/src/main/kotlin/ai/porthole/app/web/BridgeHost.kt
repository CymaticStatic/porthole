package ai.porthole.app.web

import ai.porthole.shared.BridgeAllowlist
import ai.porthole.shared.BridgeProtocol
import ai.porthole.shared.Machine
import ai.porthole.shared.Origins
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** What the bridge needs from WebView's `addWebMessageListener`; a seam so tests need no real WebView. */
interface WebMessageRegistry {
    /** False when the installed Android System WebView is too old for `WEB_MESSAGE_LISTENER`. */
    fun supported(): Boolean

    /** Registers [listener] under `PortholeNative` for exactly [originRules]. */
    fun add(originRules: Set<String>, listener: WebViewCompat.WebMessageListener)

    fun remove()
}

/** The real registry: `WebViewCompat.addWebMessageListener` on [webView] (design decision 4). */
class WebViewRegistry(private val webView: WebView) : WebMessageRegistry {
    override fun supported() = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    override fun add(originRules: Set<String>, listener: WebViewCompat.WebMessageListener) =
        WebViewCompat.addWebMessageListener(webView, BridgeHost.NAME, originRules, listener)

    override fun remove() = WebViewCompat.removeWebMessageListener(webView, BridgeHost.NAME)
}

/**
 * Connects the page to [BridgeMethods]. The page reaches native code only through the one `PortholeNative` message
 * listener, which WebView limits to the configured machine origins; [handle] checks that again, works out which
 * machine is calling from the verified source origin, and runs the call on [scope] (the main dispatcher).
 */
class BridgeHost(
    private val registry: WebMessageRegistry,
    private val machines: () -> List<Machine>,
    private val methods: BridgeMethods,
    private val outbox: EventOutbox,
    private val scope: CoroutineScope,
) {
    private var registered = false

    /**
     * Installs the listener for the current machines, replacing an earlier one (call again whenever the machine list
     * changes). Returns false, installing nothing, when this WebView cannot do it: the app then asks for an update.
     */
    fun install(): Boolean {
        if (!registry.supported()) return false
        if (registered) {
            registry.remove()
            registered = false
        }
        val rules = BridgeAllowlist.originRules(machines())
        if (rules.isEmpty()) return true
        registry.add(rules, ::onPostMessage)
        registered = true
        return true
    }

    private fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: android.net.Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        val text = message.data ?: return
        handle(sourceOrigin.toString(), isMainFrame, text, replyProxy::postMessage)
    }

    /** One message from the page: [post] sends a string back to that frame. Anything not from a machine is ignored. */
    fun handle(sourceOrigin: String?, isMainFrame: Boolean, text: String, post: (String) -> Unit) {
        val list = machines()
        if (!BridgeAllowlist.allows(sourceOrigin, isMainFrame, list)) return
        val origin = Origins.normalize(sourceOrigin ?: return) ?: return
        val caller = list.firstOrNull { Origins.normalize(it.origin) == origin } ?: return
        outbox.onMessage(post)
        when (val parsed = BridgeProtocol.parse(text)) {
            is BridgeProtocol.Parsed.Bad -> parsed.id?.let { post(BridgeProtocol.error(it, parsed.reason)) }
            is BridgeProtocol.Parsed.Call -> scope.launch {
                val reply = methods.call(caller, parsed)
                try {
                    post(reply.text)
                } catch (_: Exception) {
                    return@launch // the frame is gone, so the page never got it: keep what the reply would have cleared
                }
                reply.onPosted()
            }
        }
    }

    companion object {
        const val NAME = "PortholeNative"
    }
}
