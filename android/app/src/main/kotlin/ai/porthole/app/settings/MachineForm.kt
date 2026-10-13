package ai.porthole.app.settings

import ai.porthole.app.R
import ai.porthole.shared.Machine
import ai.porthole.shared.MachineList
import ai.porthole.shared.Origins
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

/**
 * The pure checks behind the "Add a computer" form: [MachineList] decides what is acceptable, this wrapper only turns
 * its one-message answer into messages for the right field.
 */
object MachineFormRules {
    sealed interface Check {
        /** [name] is trimmed and [origin] is the normalised `https://<host>.ts.net`; both are what the store will keep. */
        data class Valid(val name: String, val origin: String) : Check

        /** Each message belongs under its own field; at least one is not null. */
        data class Invalid(val nameError: String?, val originError: String?) : Check
    }

    /** A valid origin, so the name rules can be asked alone. */
    private const val PROBE_ORIGIN = "https://probe.ts.net"

    /**
     * [badOriginText] is the words for an origin that is not an https `.ts.net` address ("Use the https address ending
     * in .ts.net"); it is a parameter so that it lives in `settings_strings.xml`.
     */
    fun check(existing: List<Machine>, nameInput: String, originInput: String, badOriginText: String): Check {
        val name = nameInput.trim()
        val originOk = Origins.normalize(originInput) != null
        val nameError = MachineList.add(emptyList(), name, PROBE_ORIGIN).exceptionOrNull()?.message
        if (nameError != null || !originOk) {
            return Check.Invalid(nameError, if (originOk) null else badOriginText)
        }
        val added = MachineList.add(existing, name, originInput)
        val failure = added.exceptionOrNull()?.message
            ?: return Check.Valid(name, added.getOrThrow().last().origin)
        return if (existing.any { it.name == name }) Check.Invalid(failure, null) else Check.Invalid(null, failure)
    }
}

/**
 * Name and address fields plus an Add button. [onAdd] stores the machine and answers with the store's verdict; a
 * refusal from the store (which has the final say) is shown under the address.
 */
@Composable
fun MachineForm(
    existing: List<Machine>,
    onAdd: (name: String, origin: String) -> Result<List<Machine>>,
    modifier: Modifier = Modifier,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var origin by rememberSaveable { mutableStateOf("") }
    var nameError by rememberSaveable { mutableStateOf<String?>(null) }
    var originError by rememberSaveable { mutableStateOf<String?>(null) }
    val badOriginText = stringResource(R.string.settings_origin_error)

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.settings_form_title), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = name,
            onValueChange = { name = it; nameError = null },
            label = { Text(stringResource(R.string.settings_form_name_label)) },
            singleLine = true,
            isError = nameError != null,
            supportingText = nameError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag(TAG_NAME),
        )
        OutlinedTextField(
            value = origin,
            onValueChange = { origin = it; originError = null },
            label = { Text(stringResource(R.string.settings_form_origin_label)) },
            placeholder = { Text(stringResource(R.string.settings_form_origin_hint)) },
            singleLine = true,
            isError = originError != null,
            supportingText = originError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.fillMaxWidth().testTag(TAG_ORIGIN),
        )
        Button(
            onClick = {
                when (val check = MachineFormRules.check(existing, name, origin, badOriginText)) {
                    is MachineFormRules.Check.Invalid -> {
                        nameError = check.nameError
                        originError = check.originError
                    }
                    is MachineFormRules.Check.Valid -> onAdd(check.name, check.origin).fold(
                        onSuccess = { name = ""; origin = ""; nameError = null; originError = null },
                        onFailure = { originError = it.message ?: badOriginText },
                    )
                }
            },
            modifier = Modifier.testTag(TAG_ADD),
        ) { Text(stringResource(R.string.settings_form_add)) }
    }
}

internal const val TAG_NAME = "machine-form-name"
internal const val TAG_ORIGIN = "machine-form-origin"
internal const val TAG_ADD = "machine-form-add"
