package ai.porthole.app.web

import ai.porthole.shared.Machine
import ai.porthole.shared.Nav
import ai.porthole.shared.NavPolicy
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.browser.customtabs.CustomTabsIntent
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewClientCompat

/** Opens [url] in a Custom Tab: the user's browser, with none of the app's bridge. */
internal fun openCustomTab(context: Context, url: String) {
    val tab = CustomTabsIntent.Builder().build()
    if (context !is Activity) tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    tab.launchUrl(context, Uri.parse(url))
}

/** The page shown when a machine cannot be reached: one Retry link back to the address that failed. */
internal object OfflinePage {
    fun html(failedUrl: String): String {
        val href = failedUrl
            .replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;")
        return """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Porthole is offline</title>
<style>
body{font-family:sans-serif;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;background:#fff;color:#1b1b1b}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
a.retry{display:inline-block;margin-top:16px;padding:12px 28px;border-radius:24px;background:#1a6fd8;color:#fff;text-decoration:none;font-size:16px}
</style></head><body>
<h1>Can't reach this machine</h1>
<p>Check that the phone is connected to Tailscale and the machine is on.</p>
<a class="retry" href="$href">Retry</a>
</body></html>"""
    }
}

/**
 * Keeps navigation inside the trusted origins (design decision 4): a configured machine stays in the WebView, any other
 * `https:` address opens in a Custom Tab, everything else is blocked. A main-frame load error shows the offline page;
 * a certificate error is never overridden.
 *
 * [onPageStarted] runs for every main-frame load that starts (the page being replaced is gone), [onPageFinished] for a
 * finished load of a configured machine's page, and [onHistoryChanged] when the back stack may have changed.
 */
class PortholeWebClient(
    private val context: Context,
    private val machines: () -> List<Machine>,
    private val onPageStarted: () -> Unit = {},
    private val onPageFinished: (url: String) -> Unit = {},
    private val onHistoryChanged: () -> Unit = {},
) : WebViewClientCompat() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        when (NavPolicy.decide(url, machines())) {
            Nav.STAY -> return false
            Nav.CUSTOM_TAB -> try {
                openCustomTab(context, url)
            } catch (_: ActivityNotFoundException) {
                // No browser installed: nothing to open, and nothing may load in this WebView either.
            }
            Nav.BLOCK -> Unit
        }
        return true
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        super.onPageStarted(view, url, favicon)
        onPageStarted()
    }

    override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        if (url != null && NavPolicy.decide(url, machines()) == Nav.STAY) onPageFinished(url)
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        super.doUpdateVisitedHistory(view, url, isReload)
        onHistoryChanged()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceErrorCompat) {
        if (request.isForMainFrame) showOffline(view, request.url.toString())
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
    }

    internal fun showOffline(view: WebView, failedUrl: String) {
        view.loadDataWithBaseURL(null, OfflinePage.html(failedUrl), "text/html", "utf-8", null)
    }
}
