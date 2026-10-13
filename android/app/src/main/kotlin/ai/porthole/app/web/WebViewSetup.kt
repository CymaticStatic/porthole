package ai.porthole.app.web

import ai.porthole.app.BuildConfig
import android.annotation.SuppressLint
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * The one place the WebView is configured (design decision 4). The page is a trusted origin's own code, so JavaScript
 * and storage are on; everything that could reach local files, the location, other windows or insecure content is off.
 * The native bridge is installed by [BridgeHost] through `addWebMessageListener`, never `addJavascriptInterface`.
 */
object WebViewSetup {
    @SuppressLint("SetJavaScriptEnabled")
    fun apply(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }
}
