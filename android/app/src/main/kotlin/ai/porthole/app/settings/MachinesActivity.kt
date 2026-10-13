package ai.porthole.app.settings

import ai.porthole.app.Graph
import ai.porthole.app.MachineStore
import ai.porthole.app.R
import ai.porthole.app.net.HostClient
import ai.porthole.shared.Machine
import ai.porthole.shared.MachineInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

/** Native screen "Your computers": list, add, rename, remove and test the machines the app talks to. */
class MachinesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = Graph.machines
        val host = Graph.host
        setContent { SettingsTheme { MachinesRoute(store, host) } }
    }
}

/** Connects [MachinesScreen] to the machine store and to hostd. */
@Composable
fun MachinesRoute(store: MachineStore, host: HostClient) {
    val machines by store.machines.collectAsStateWithLifecycle()
    MachinesScreen(
        machines = machines,
        onAdd = store::add,
        onRename = store::rename,
        onRemove = store::remove,
        onTest = host::machine,
    )
}

@Composable
fun MachinesScreen(
    machines: List<Machine>,
    onAdd: (name: String, origin: String) -> Result<List<Machine>>,
    onRename: (oldName: String, newName: String) -> Result<List<Machine>>,
    onRemove: (name: String) -> Unit,
    onTest: suspend (Machine) -> Result<MachineInfo>,
) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        LazyColumn(
            modifier = Modifier.safeDrawingPadding().testTag(TAG_LIST),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(stringResource(R.string.settings_machines_title), style = MaterialTheme.typography.headlineMedium)
            }
            item {
                Text(stringResource(R.string.settings_machines_intro), style = MaterialTheme.typography.bodyMedium)
            }
            if (machines.isEmpty()) {
                item {
                    Text(stringResource(R.string.settings_machines_empty), modifier = Modifier.testTag(TAG_EMPTY))
                }
            }
            items(machines, key = { it.name }) { machine ->
                MachineCard(machine, onRename = onRename, onRemove = onRemove, onTest = onTest)
            }
            item { MachineForm(existing = machines, onAdd = onAdd) }
        }
    }
}

@Composable
private fun MachineCard(
    machine: Machine,
    onRename: (String, String) -> Result<List<Machine>>,
    onRemove: (String) -> Unit,
    onTest: suspend (Machine) -> Result<MachineInfo>,
) {
    val scope = rememberCoroutineScope()
    var testing by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<Result<MachineInfo>?>(null) }
    var renaming by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(machine.name, style = MaterialTheme.typography.titleMedium)
            Text(machine.origin, style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(
                onClick = {
                    testing = true
                    scope.launch {
                        testResult = onTest(machine)
                        testing = false
                    }
                },
                enabled = !testing,
                modifier = Modifier.fillMaxWidth().testTag("test-${machine.name}"),
            ) {
                Text(stringResource(if (testing) R.string.settings_machine_testing else R.string.settings_machine_test))
            }
            testResult?.let { result ->
                Text(
                    testSummary(result),
                    color = if (result.isSuccess) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                    modifier = Modifier.testTag("test-result-${machine.name}"),
                )
            }
            Row {
                TextButton(onClick = { renaming = true }, modifier = Modifier.testTag("rename-${machine.name}")) {
                    Text(stringResource(R.string.settings_machine_rename))
                }
                TextButton(onClick = { removing = true }, modifier = Modifier.testTag("remove-${machine.name}")) {
                    Text(stringResource(R.string.settings_machine_remove))
                }
            }
        }
    }

    if (renaming) RenameDialog(machine, onRename = onRename, onDismiss = { renaming = false })
    if (removing) {
        AlertDialog(
            onDismissRequest = { removing = false },
            title = { Text(stringResource(R.string.settings_remove_title, machine.name)) },
            text = { Text(stringResource(R.string.settings_remove_body)) },
            confirmButton = {
                TextButton(
                    onClick = { removing = false; onRemove(machine.name) },
                    modifier = Modifier.testTag(TAG_CONFIRM_REMOVE),
                ) { Text(stringResource(R.string.settings_machine_remove)) }
            },
            dismissButton = {
                TextButton(onClick = { removing = false }) { Text(stringResource(R.string.settings_cancel)) }
            },
        )
    }
}

@Composable
private fun testSummary(result: Result<MachineInfo>): String {
    val info = result.getOrNull()
    if (info == null) {
        val why = result.exceptionOrNull()?.message?.takeIf { it.isNotBlank() }
            ?: stringResource(R.string.settings_test_failed_no_reason)
        return stringResource(R.string.settings_test_failed, why)
    }
    val device = info.you?.device?.takeIf { it.isNotBlank() }
    return if (device == null) {
        stringResource(R.string.settings_test_ok_no_device, info.name)
    } else {
        stringResource(R.string.settings_test_ok, info.name, device)
    }
}

@Composable
private fun RenameDialog(
    machine: Machine,
    onRename: (String, String) -> Result<List<Machine>>,
    onDismiss: () -> Unit,
) {
    var newName by remember { mutableStateOf(machine.name) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_rename_title, machine.name)) },
        text = {
            OutlinedTextField(
                value = newName,
                onValueChange = { newName = it; error = null },
                singleLine = true,
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth().testTag(TAG_RENAME_FIELD),
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onRename(machine.name, newName.trim()).fold(
                        onSuccess = { onDismiss() },
                        onFailure = { error = it.message },
                    )
                },
                modifier = Modifier.testTag(TAG_CONFIRM_RENAME),
            ) { Text(stringResource(R.string.settings_rename_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) } },
    )
}

internal const val TAG_LIST = "machines-list"
internal const val TAG_EMPTY = "machines-empty"
internal const val TAG_CONFIRM_REMOVE = "confirm-remove"
internal const val TAG_RENAME_FIELD = "rename-field"
internal const val TAG_CONFIRM_RENAME = "confirm-rename"
