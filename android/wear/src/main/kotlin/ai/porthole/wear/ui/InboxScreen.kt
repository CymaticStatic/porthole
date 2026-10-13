package ai.porthole.wear.ui

import ai.porthole.shared.WatchItem
import ai.porthole.wear.data.AnswerSender
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SurfaceTransformation
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.lazy.rememberTransformationSpec
import androidx.wear.compose.material3.lazy.transformedHeight
import kotlinx.coroutines.delay

private const val CLOCK_TICK_MS = 30_000L

/** The model's clock, refreshed every 30 s, so "Updated N min ago" keeps counting while the screen is open. */
@Composable
internal fun rememberNow(model: InboxModel): State<Long> =
    produceState(initialValue = model.now(), model) {
        while (true) {
            delay(CLOCK_TICK_MS)
            value = model.now()
        }
    }

/** The waiting items, newest first, with the stale and no-phone lines on top and a Usage button at the bottom. */
@Composable
fun InboxScreen(model: InboxModel, onOpenItem: (WatchItem) -> Unit, onOpenUsage: () -> Unit) {
    val state by model.state.collectAsState()
    val phoneNotConnected by model.phoneNotConnected.collectAsState()
    val now by rememberNow(model)
    val view = remember(state, phoneNotConnected, now) { model.inbox(now) }

    val listState = rememberTransformingLazyColumnState()
    val spec = rememberTransformationSpec()
    ScreenScaffold(scrollState = listState) { padding ->
        TransformingLazyColumn(state = listState, contentPadding = padding) {
            item(key = "header") {
                ListHeader(
                    modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                    transformation = SurfaceTransformation(spec),
                ) { Text("Inbox") }
            }
            if (view.phoneNotConnected) {
                item(key = "no-phone") {
                    Text(
                        text = AnswerSender.PHONE_NOT_CONNECTED,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            view.updatedLine?.let { line ->
                item(key = "updated") {
                    Text(
                        text = line,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            view.emptyMessage?.let { message ->
                item(key = "empty") {
                    Text(
                        text = message,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            items(view.items, key = { it.itemId }) { item ->
                Button(
                    onClick = { onOpenItem(item) },
                    modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                    transformation = SurfaceTransformation(spec),
                    secondaryLabel = { Text("${item.machine} · ${item.project}", maxLines = 1) },
                    label = { Text(item.title, maxLines = 2) },
                )
            }
            item(key = "usage") {
                FilledTonalButton(
                    onClick = onOpenUsage,
                    modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                    transformation = SurfaceTransformation(spec),
                    label = { Text("Usage") },
                )
            }
        }
    }
}
