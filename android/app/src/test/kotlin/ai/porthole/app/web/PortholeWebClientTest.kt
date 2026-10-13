package ai.porthole.app.web

import ai.porthole.shared.Machine
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.webkit.WebResourceErrorCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowSslErrorHandler

private class FakeRequest(private val url: String, private val mainFrame: Boolean = true) : WebResourceRequest {
    override fun getUrl(): Uri = Uri.parse(url)
    override fun isForMainFrame() = mainFrame
    override fun isRedirect() = false
    override fun hasGesture() = true
    override fun getMethod() = "GET"
    override fun getRequestHeaders(): Map<String, String> = emptyMap()
}

private class FakeError : WebResourceErrorCompat() {
    override fun getErrorCode() = -2
    override fun getDebugCode() = 0
    override fun getDescription(): CharSequence = "net::ERR_NAME_NOT_RESOLVED"
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PortholeWebClientTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val desk = Machine("desk", "https://desk.tailx.ts.net")
    private val webView = WebView(app)
    private val started = mutableListOf<Unit>()
    private val finished = mutableListOf<String>()
    private val client = PortholeWebClient(app, { listOf(desk) }, { started.add(Unit) }, { finished.add(it) })

    private fun override(url: String) = client.shouldOverrideUrlLoading(webView, FakeRequest(url))

    @Test
    fun aConfiguredOriginStaysInTheWebView() {
        assertFalse(override("https://desk.tailx.ts.net"))
        assertFalse(override("https://desk.tailx.ts.net/#/chat/desk/x"))
        assertNull("no browser was opened", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun intentAndFileUrlsAreBlockedAndOpenNothing() {
        assertTrue(override("intent://scan/#Intent;scheme=zxing;end"))
        assertTrue(override("file:///sdcard/x.html"))
        assertTrue(override("javascript:alert(1)"))
        assertTrue(override("http://desk.tailx.ts.net/"))
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun aPreviewPortIsADifferentOriginAndOpensInACustomTab() {
        assertTrue(override("https://desk.tailx.ts.net:8443/preview/"))
        val intent = shadowOf(app).nextStartedActivity
        assertNotNull(intent)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("https://desk.tailx.ts.net:8443/preview/", intent.dataString)
        assertNull("one tab only", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun anyOtherHttpsAddressOpensInACustomTab() {
        assertTrue(override("https://example.com/a"))
        assertEquals("https://example.com/a", shadowOf(app).nextStartedActivity.dataString)
    }

    @Test
    fun aCertificateErrorIsCancelledNeverIgnored() {
        val handler = Shadow.newInstanceOf(SslErrorHandler::class.java)
        val cert = SslCertificate("desk.tailx.ts.net", "Test CA", "2020-01-01", "2030-01-01")
        client.onReceivedSslError(webView, handler, SslError(SslError.SSL_UNTRUSTED, cert, "https://desk.tailx.ts.net/"))
        val shadow = shadowOf(handler) as ShadowSslErrorHandler
        assertTrue(shadow.wasCancelCalled())
        assertFalse(shadow.wasProceedCalled())
    }

    @Test
    fun aMainFrameLoadErrorShowsTheOfflinePageWithARetryLinkToTheFailedAddress() {
        client.onReceivedError(webView, FakeRequest("https://desk.tailx.ts.net/#/inbox"), FakeError())

        val page = shadowOf(webView).lastLoadDataWithBaseURL
        assertNotNull(page)
        assertTrue(page.data.contains(">Retry</a>"))
        assertTrue(page.data.contains("href=\"https://desk.tailx.ts.net/#/inbox\""))
    }

    @Test
    fun aSubFrameOrSubResourceErrorLeavesThePageAlone() {
        client.onReceivedError(webView, FakeRequest("https://desk.tailx.ts.net/v1/x.png", mainFrame = false), FakeError())
        assertNull(shadowOf(webView).lastLoadDataWithBaseURL)
    }

    @Test
    fun theRetryLinkEscapesTheAddress() {
        val html = OfflinePage.html("https://x.ts.net/\"><script>alert(1)</script>")
        assertFalse(html.contains("<script>"))
        assertTrue(html.contains("href=\"https://x.ts.net/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\""))
    }

    @Test
    fun pageCallbacksFireForMachinePagesOnly() {
        client.onPageStarted(webView, "https://desk.tailx.ts.net/", null)
        client.onPageFinished(webView, "https://desk.tailx.ts.net/#/inbox")
        client.onPageFinished(webView, "https://example.com/")
        client.onPageFinished(webView, null)

        assertEquals(1, started.size)
        assertEquals(listOf("https://desk.tailx.ts.net/#/inbox"), finished)
    }
}
