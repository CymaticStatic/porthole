package ai.porthole.wear.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf

/** A start route asked for through [WearActivity.EXTRA_ROUTE]; [serial] makes a repeated request count again. */
data class RouteRequest(val route: String?, val serial: Int = 0)

/**
 * The watch app's only activity. A complication tap starts it with [EXTRA_ROUTE] set to [ROUTE_INBOX] or
 * [ROUTE_USAGE]; it is `singleTask`, so a tap while it is open arrives in [onNewIntent].
 */
class WearActivity : ComponentActivity() {
    private val request = mutableStateOf(RouteRequest(null))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) request.value = RouteRequest(intent.getStringExtra(EXTRA_ROUTE))
        setContent { WearApp(request.value) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        request.value = RouteRequest(intent.getStringExtra(EXTRA_ROUTE), request.value.serial + 1)
    }

    companion object {
        /** String extra naming the screen to open: [ROUTE_INBOX] or [ROUTE_USAGE]. */
        const val EXTRA_ROUTE = "ai.porthole.wear.ROUTE"
        const val ROUTE_INBOX = "inbox"
        const val ROUTE_USAGE = "usage"
    }
}
