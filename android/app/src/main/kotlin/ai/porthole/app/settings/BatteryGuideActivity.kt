package ai.porthole.app.settings

import ai.porthole.app.R
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

/** Native screen "Keep Porthole running": asks Android not to put the always-on connection to sleep. */
class BatteryGuideActivity : ComponentActivity() {
    private val ignoring = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        refresh()
        setContent {
            SettingsTheme { BatteryGuideScreen(ignoringOptimizations = ignoring.value, onAllow = ::requestExemption) }
        }
    }

    /** The system dialog is a separate screen: look again whenever the user comes back. */
    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        ignoring.value = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestExemption() {
        val request = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        try {
            startActivity(request)
        } catch (_: ActivityNotFoundException) {
            // A phone without the one-tap dialog still has the full list of apps Android may put to sleep.
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }
}

@Composable
fun BatteryGuideScreen(ignoringOptimizations: Boolean, onAllow: () -> Unit) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.settings_battery_title), style = MaterialTheme.typography.headlineMedium)
            Text(stringResource(R.string.settings_battery_intro), style = MaterialTheme.typography.bodyLarge)
            Text(stringResource(R.string.settings_battery_how), style = MaterialTheme.typography.bodyLarge)
            Text(
                stringResource(
                    if (ignoringOptimizations) R.string.settings_battery_status_ok
                    else R.string.settings_battery_status_limited,
                ),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.testTag(TAG_BATTERY_STATUS),
            )
            Button(onClick = onAllow, modifier = Modifier.fillMaxWidth().testTag(TAG_BATTERY_BUTTON)) {
                Text(stringResource(R.string.settings_battery_button))
            }
        }
    }
}

internal const val TAG_BATTERY_STATUS = "battery-status"
internal const val TAG_BATTERY_BUTTON = "battery-button"
