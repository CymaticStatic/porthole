package ai.porthole.wear.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.OutlinedButton
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SurfaceTransformation
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.lazy.rememberTransformationSpec
import androidx.wear.compose.material3.lazy.transformedHeight
import kotlinx.coroutines.launch

/**
 * One waiting item: the question, a button per option (none for a multi-select question), "Open on phone" and
 * Stop, which asks "Stop this session?" first. [onResult] runs after a send or an open finished, whatever the
 * outcome; the result screen then shows it.
 */
@Composable
fun ItemScreen(model: InboxModel, itemId: String, onResult: () -> Unit) {
    val state by model.state.collectAsState()
    val busy by model.busy.collectAsState()
    val stopPending by model.stopPending.collectAsState()
    val item = state?.items?.firstOrNull { it.itemId == itemId }
    val scope = rememberCoroutineScope()

    DisposableEffect(itemId) { onDispose { model.cancelStop() } }
    val listState = rememberTransformingLazyColumnState()
    val spec = rememberTransformationSpec()
    ScreenScaffold(scrollState = listState) { padding ->
        TransformingLazyColumn(state = listState, contentPadding = padding) {
            if (item == null) {
                item(key = "gone") {
                    Text(
                        text = "No longer waiting",
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
                return@TransformingLazyColumn
            }
            item(key = "where") {
                Text(
                    text = "${item.machine} · ${item.project}",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            item(key = "question") {
                Text(
                    text = item.question ?: item.title,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
            }
            val options = model.optionsOf(item)
            itemsIndexed(options, key = { index, _ -> "option-$index" }) { index, label ->
                Button(
                    onClick = { scope.launch { if (model.choose(item, index) != null) onResult() } },
                    modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                    enabled = !busy,
                    transformation = SurfaceTransformation(spec),
                    label = { Text(label, maxLines = 2) },
                )
            }
            item(key = "open") {
                FilledTonalButton(
                    onClick = { scope.launch { model.openOnPhone(item); onResult() } },
                    modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                    enabled = !busy,
                    transformation = SurfaceTransformation(spec),
                    label = { Text("Open on phone") },
                )
            }
            if (stopPending == item.itemId) {
                item(key = "stop-prompt") {
                    Text(
                        text = InboxModel.STOP_PROMPT,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.titleSmall,
                        textAlign = TextAlign.Center,
                    )
                }
                item(key = "stop-confirm") {
                    Button(
                        onClick = { scope.launch { if (model.confirmStop(item) != null) onResult() } },
                        modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                        enabled = !busy,
                        transformation = SurfaceTransformation(spec),
                        label = { Text("Stop") },
                    )
                }
                item(key = "stop-cancel") {
                    OutlinedButton(
                        onClick = { model.cancelStop() },
                        modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                        transformation = SurfaceTransformation(spec),
                        label = { Text("Cancel") },
                    )
                }
            } else {
                item(key = "stop") {
                    OutlinedButton(
                        onClick = { model.requestStop(item) },
                        modifier = Modifier.fillMaxWidth().transformedHeight(this, spec),
                        enabled = !busy,
                        transformation = SurfaceTransformation(spec),
                        label = { Text("Stop") },
                    )
                }
            }
        }
    }
}
