package ai.porthole.wear.complications

import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.shared.WatchUsage
import ai.porthole.wear.data.WearData
import ai.porthole.wear.ui.WearActivity
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.NoDataComplicationData
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ComplicationPreviewTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    private fun item(id: String) = WatchItem(
        origin = "https://desk.ts.net",
        machine = "desk",
        itemId = id,
        sessionId = "tmux:t:main:0.0",
        project = "porthole",
        title = "Run tests?",
        question = "Run the tests?",
        options = listOf("Yes", "No"),
        multi = false,
        updatedAt = 5_000,
    )

    private fun store(items: Int, usage: List<WatchUsage>) {
        val state = WatchState(updatedAt = 1_000_000, items = List(items) { item("i$it") }, usage = usage)
        assertTrue(WearData.repository(context).update(state.encode()))
    }

    private fun ComplicationText.read(): String = getTextAt(context.resources, Instant.EPOCH).toString()

    private fun requestData(service: SuspendingComplicationDataSourceService, type: ComplicationType): ComplicationData? =
        runBlocking { service.onComplicationRequest(ComplicationRequest(1, type, false)) }

    private fun waitingService() = Robolectric.buildService(WaitingComplicationService::class.java).create().get()

    private fun usageService() = Robolectric.buildService(UsageComplicationService::class.java).create().get()

    @Test
    fun waitingPreviewIsShortText() {
        val preview = waitingService().getPreviewData(ComplicationType.SHORT_TEXT)
        assertTrue(preview is ShortTextComplicationData)
        assertEquals(ComplicationType.SHORT_TEXT, preview!!.type)
        assertEquals("3", (preview as ShortTextComplicationData).text.read())
    }

    @Test
    fun waitingHasNoPreviewForAnotherType() {
        assertNull(waitingService().getPreviewData(ComplicationType.RANGED_VALUE))
    }

    @Test
    fun usagePreviewIsRangedValue() {
        val preview = usageService().getPreviewData(ComplicationType.RANGED_VALUE)
        assertTrue(preview is RangedValueComplicationData)
        assertEquals(ComplicationType.RANGED_VALUE, preview!!.type)
        assertEquals(72f, (preview as RangedValueComplicationData).value, 0f)
    }

    @Test
    fun usageHasNoPreviewForAnotherType() {
        assertNull(usageService().getPreviewData(ComplicationType.SHORT_TEXT))
    }

    @Test
    fun waitingServiceShowsThreeItemsFromTheStoredState() {
        store(3, emptyList())
        val data = requestData(waitingService(), ComplicationType.SHORT_TEXT) as ShortTextComplicationData
        assertEquals("3", data.text.read())
        assertEquals("waiting", data.title!!.read())
        assertEquals("3 waiting", data.contentDescription!!.read())
    }

    @Test
    fun waitingBuilderShowsZeroWithoutAState() {
        val data = waitingComplication(null, null)
        assertEquals("0", data.text.read())
        assertEquals("0 waiting", data.contentDescription!!.read())
        assertNull(data.tapAction)
    }

    @Test
    fun usageServiceWithNoWindowsReturnsNoData() {
        store(2, emptyList())
        assertTrue(requestData(usageService(), ComplicationType.RANGED_VALUE) is NoDataComplicationData)
    }

    @Test
    fun usageBuilderWithoutAStateReturnsNoData() {
        assertTrue(usageComplication(null, null) is NoDataComplicationData)
    }

    @Test
    fun usageServiceShows72PercentFromTheStoredState() {
        store(
            0,
            listOf(
                WatchUsage("desk", "5h", 72.0, null),
                WatchUsage("laptop", "5h", 40.0, null),
                WatchUsage("desk", "7d", 10.0, null),
            ),
        )
        val data = requestData(usageService(), ComplicationType.RANGED_VALUE) as RangedValueComplicationData
        assertEquals(72f, data.value, 0f)
        assertEquals(0f, data.min, 0f)
        assertEquals(100f, data.max, 0f)
        assertEquals("72%", data.text!!.read())
        assertEquals("Highest Claude usage 72 percent", data.contentDescription!!.read())
    }

    @Test
    fun routeTapActionOpensTheActivityWithTheRouteExtra() {
        val pending = routeTapAction(context, "ai.porthole.wear.ui.WearActivity", "some.extra", "usage")
        val shadow = shadowOf(pending)
        assertTrue(shadow.isActivityIntent)
        assertEquals("ai.porthole.wear.ui.WearActivity", shadow.savedIntent.component!!.className)
        assertEquals("usage", shadow.savedIntent.getStringExtra("some.extra"))
    }

    @Test
    fun differentRoutesGetDifferentPendingIntents() {
        val inbox = routeTapAction(context, "ai.porthole.wear.ui.WearActivity", "some.extra", "inbox")
        val usage = routeTapAction(context, "ai.porthole.wear.ui.WearActivity", "some.extra", "usage")
        assertEquals("inbox", shadowOf(inbox).savedIntent.getStringExtra("some.extra"))
        assertEquals("usage", shadowOf(usage).savedIntent.getStringExtra("some.extra"))
    }

    @Test
    fun waitingTapOpensTheInboxAndUsageTapOpensUsage() {
        store(1, listOf(WatchUsage("desk", "5h", 10.0, null)))
        val waiting = requestData(waitingService(), ComplicationType.SHORT_TEXT) as ShortTextComplicationData
        val usage = requestData(usageService(), ComplicationType.RANGED_VALUE) as RangedValueComplicationData
        val waitingIntent = shadowOf(waiting.tapAction!!).savedIntent
        val usageIntent = shadowOf(usage.tapAction!!).savedIntent
        assertEquals(WearActivity::class.java.name, waitingIntent.component!!.className)
        assertEquals(WearActivity::class.java.name, usageIntent.component!!.className)
        assertEquals("inbox", waitingIntent.getStringExtra(WearActivity.EXTRA_ROUTE))
        assertEquals("usage", usageIntent.getStringExtra(WearActivity.EXTRA_ROUTE))
    }
}
