package ai.porthole.app.web

import android.app.Application
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WebViewSetupTest {
    private val app: Application = ApplicationProvider.getApplicationContext()

    @Test
    fun theSettingsAreExactlyTheOnesTheDesignAsksFor() {
        val webView = WebView(app)
        // Start from the opposite of every value, so a setting that is never applied shows up.
        webView.settings.apply {
            javaScriptEnabled = false
            domStorageEnabled = false
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            setSupportMultipleWindows(true)
            setGeolocationEnabled(true)
        }

        WebViewSetup.apply(webView)

        val s = webView.settings
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        // WebSettings has no public getter for this; Robolectric's fake keeps the value.
        assertEquals(false, s.javaClass.getMethod("getGeolocationEnabled").invoke(s))
        assertFalse(s.supportMultipleWindows())
    }
}
