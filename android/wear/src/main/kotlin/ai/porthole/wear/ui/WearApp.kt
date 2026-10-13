package ai.porthole.wear.ui

import ai.porthole.wear.data.WearData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.remote.interactions.RemoteActivityHelper
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

private const val ROUTE_ITEM = "item/{itemId}"
private const val ROUTE_RESULT = "result"
private const val RESULT_SHOWN_MS = 3_000L

private fun itemRoute(itemId: String) = "item/" + Uri.encode(itemId)

/** The watch app: Inbox, Item, Usage and Result in a swipe-to-dismiss stack. [request] is the launch route. */
@Composable
fun WearApp(request: RouteRequest) {
    val context = LocalContext.current.applicationContext
    val model = remember { createModel(context) }
    MaterialTheme {
        AppScaffold(timeText = { TimeText() }) {
            val nav = rememberSwipeDismissableNavController()
            LaunchedEffect(model) { model.refresh() }
            LaunchedEffect(request) { openRequested(nav, request.route) }
            SwipeDismissableNavHost(navController = nav, startDestination = WearActivity.ROUTE_INBOX) {
                composable(WearActivity.ROUTE_INBOX) {
                    InboxScreen(
                        model = model,
                        onOpenItem = { nav.navigate(itemRoute(it.itemId)) },
                        onOpenUsage = { nav.navigate(WearActivity.ROUTE_USAGE) },
                    )
                }
                composable(ROUTE_ITEM) { entry ->
                    ItemScreen(
                        model = model,
                        itemId = entry.arguments?.getString("itemId").orEmpty(),
                        onResult = { nav.navigate(ROUTE_RESULT) },
                    )
                }
                composable(WearActivity.ROUTE_USAGE) { UsageScreen(model) }
                composable(ROUTE_RESULT) {
                    ResultScreen(model, onDone = { nav.popBackStack(WearActivity.ROUTE_INBOX, inclusive = false) })
                }
            }
        }
    }
}

private fun openRequested(nav: NavHostController, route: String?) {
    when (route) {
        WearActivity.ROUTE_USAGE -> {
            nav.popBackStack(WearActivity.ROUTE_INBOX, inclusive = false)
            nav.navigate(WearActivity.ROUTE_USAGE)
        }
        WearActivity.ROUTE_INBOX -> nav.popBackStack(WearActivity.ROUTE_INBOX, inclusive = false)
        else -> Unit
    }
}

/** The answer result for 3 s, then [onDone] (back to the inbox). */
@Composable
internal fun ResultScreen(model: InboxModel, onDone: () -> Unit) {
    val shown = remember { model.result.value }
    LaunchedEffect(Unit) {
        if (shown != null) delay(RESULT_SHOWN_MS)
        onDone()
        model.clearResult()
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = shown?.message.orEmpty(),
            modifier = Modifier.padding(horizontal = 24.dp),
            style = MaterialTheme.typography.titleMedium,
            color = if (shown?.ok == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )
    }
}

private fun createModel(context: Context): InboxModel {
    val repository = WearData.repository(context)
    return InboxModel(
        source = repository.state,
        isStale = repository::isStale,
        port = WearData.sender(context).asPort(),
        opener = RemoteActivityOpener(context),
        clock = System::currentTimeMillis,
    )
}

/** "Open on phone": asks the Data Layer to start an `ACTION_VIEW` + `BROWSABLE` intent on the paired phone. */
class RemoteActivityOpener(context: Context) : PhoneOpener {
    private val helper = RemoteActivityHelper(context.applicationContext)

    override suspend fun open(uri: String): Boolean = suspendCancellableCoroutine { continuation ->
        val intent = Intent(Intent.ACTION_VIEW)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .setData(Uri.parse(uri))
        val future = try {
            helper.startRemoteActivity(intent)
        } catch (e: IllegalArgumentException) {
            continuation.resume(false)
            return@suspendCancellableCoroutine
        }
        future.addListener(
            { continuation.resume(runCatching { future.get() }.isSuccess) },
            Runnable::run,
        )
        continuation.invokeOnCancellation { future.cancel(true) }
    }
}
