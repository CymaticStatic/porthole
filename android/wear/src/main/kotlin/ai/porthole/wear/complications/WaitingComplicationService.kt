package ai.porthole.wear.complications

import ai.porthole.wear.data.WearData
import ai.porthole.wear.ui.WearActivity
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/** SHORT_TEXT complication: how many questions wait for the user. Tap opens the inbox. */
class WaitingComplicationService : SuspendingComplicationDataSourceService() {
    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type == ComplicationType.SHORT_TEXT) waitingPreview() else null

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val state = WearData.repository(applicationContext).state.value
        val tap = routeTapAction(
            applicationContext,
            WearActivity::class.java.name,
            WearActivity.EXTRA_ROUTE,
            WearActivity.ROUTE_INBOX,
        )
        return waitingComplication(state, tap)
    }
}
