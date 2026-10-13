package ai.porthole.wear.complications

import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.shared.WatchUsage
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import ai.porthole.shared.ComplicationText as ShownText

/** The two complication payloads (design decision 12). Pure: both services and the tests call these. */
internal const val USAGE_MIN = 0f
internal const val USAGE_MAX = 100f

private fun plain(text: String) = PlainComplicationText.Builder(text).build()

/** SHORT_TEXT: the number of waiting items as text, "waiting" as title, "N waiting" as content description. */
internal fun waitingComplication(state: WatchState?, tapAction: PendingIntent?): ShortTextComplicationData {
    val shown = ShownText.waiting(state)
    return ShortTextComplicationData.Builder(plain(shown.text), plain(shown.description))
        .setTitle(plain(shown.title))
        .setTapAction(tapAction)
        .build()
}

/**
 * RANGED_VALUE: the highest usage percent over 0 to 100, with "72%" as text. [NoDataComplicationData] when the
 * state has no usage windows (nothing to show, so the face shows its own "no data" look, not a made-up 0%).
 */
internal fun usageComplication(state: WatchState?, tapAction: PendingIntent?): ComplicationData {
    val shown = ShownText.usage(state) ?: return NoDataComplicationData()
    return RangedValueComplicationData.Builder(shown.value, USAGE_MIN, USAGE_MAX, plain(shown.description))
        .setText(plain(shown.text))
        .setTapAction(tapAction)
        .build()
}

/**
 * A tap action that opens [activityClassName] with the string extra [extraKey] set to [route]. Each route gets its
 * own request code, so the waiting and usage complications never share (and overwrite) one PendingIntent.
 */
internal fun routeTapAction(
    context: Context,
    activityClassName: String,
    extraKey: String,
    route: String,
): PendingIntent {
    val intent = Intent()
        .setComponent(ComponentName(context, activityClassName))
        .putExtra(extraKey, route)
    return PendingIntent.getActivity(
        context,
        route.hashCode(),
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

private val previewState = WatchState(
    updatedAt = 0,
    items = List(3) { i ->
        WatchItem(
            origin = "https://preview.invalid",
            machine = "desk",
            itemId = "preview-$i",
            sessionId = "preview-$i",
            project = "project",
            title = "Question",
            question = null,
            options = emptyList(),
            multi = false,
            updatedAt = 0,
        )
    },
    usage = listOf(WatchUsage(machine = "desk", windowId = "5h", usedPercent = 72.0, resetsAt = null)),
)

/** What a watch-face picker shows for the waiting complication: "3 waiting". No tap action: it is never tapped. */
internal fun waitingPreview(): ShortTextComplicationData = waitingComplication(previewState, null)

/** What a watch-face picker shows for the usage complication: 72%. */
internal fun usagePreview(): ComplicationData = usageComplication(previewState, null)
