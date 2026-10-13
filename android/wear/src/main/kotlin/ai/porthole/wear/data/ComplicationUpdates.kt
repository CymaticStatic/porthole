package ai.porthole.wear.data

import android.content.ComponentName
import android.content.Context
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester

/** Pushes a refresh to both complication services when a new state arrives (design decision 12). */
object ComplicationUpdates {
    // Class names as strings: the services belong to another task and are only named in the manifest.
    private val serviceClassNames = listOf(
        "ai.porthole.wear.complications.UsageComplicationService",
        "ai.porthole.wear.complications.WaitingComplicationService",
    )

    fun requestAll(context: Context) {
        for (name in serviceClassNames) {
            ComplicationDataSourceUpdateRequester
                .create(context, ComponentName(context, name))
                .requestUpdateAll()
        }
    }
}
