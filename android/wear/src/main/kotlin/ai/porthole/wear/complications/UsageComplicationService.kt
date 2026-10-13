package ai.porthole.wear.complications

import ai.porthole.wear.data.WearData
import ai.porthole.wear.ui.WearActivity
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/** RANGED_VALUE complication: the highest Claude usage percent over every machine and window. Tap opens usage. */
class UsageComplicationService : SuspendingComplicationDataSourceService() {
    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type == ComplicationType.RANGED_VALUE) usagePreview() else null

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val state = WearData.repository(applicationContext).state.value
        val tap = routeTapAction(
            applicationContext,
            WearActivity::class.java.name,
            WearActivity.EXTRA_ROUTE,
            WearActivity.ROUTE_USAGE,
        )
        return usageComplication(state, tap)
    }
}
