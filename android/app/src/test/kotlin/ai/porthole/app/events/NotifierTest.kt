package ai.porthole.app.events

import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyPlanner
import ai.porthole.shared.Routes
import android.app.Notification
import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NotifierTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val nm get() = context.getSystemService(NotificationManager::class.java)
    private val shadow get() = shadowOf(nm)
    private val desk = Machine("desk", "https://desk.tailafe04c.ts.net")
    private lateinit var notifier: Notifier

    @Before
    fun setUp() {
        notifier = Notifier(context)
    }

    private fun plan(itemId: String = "a", notifyId: Long = 3) =
        NotifyPlanner.plan(notifyEvent(notifyId, itemId), desk)

    private fun Notification.actionTitles() = actions.orEmpty().map { it.title.toString() }

    @Test
    fun needsYouIsAnImportantChannelAndConnectionIsALowOne() {
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel("needs-you").importance)
        assertEquals(NotificationManager.IMPORTANCE_LOW, nm.getNotificationChannel("connection").importance)
        assertEquals(2, shadow.notificationChannels.size)
    }

    @Test
    fun creatingTheNotifierTwiceKeepsTheSameTwoChannels() {
        Notifier(context)
        assertEquals(2, shadow.notificationChannels.size)
    }

    @Test
    fun confirmReplacesTheQuestionWithTheResultAndOnlyOpen() {
        val p = plan()
        notifier.show(p, "#/inbox")
        assertEquals(listOf("Open", "Yes", "No"), shadow.getNotification(p.tag, p.id).actionTitles())

        notifier.confirm(p, "Sent: Yes", "#/inbox")

        assertEquals(1, shadow.size())
        val n = shadow.getNotification(p.tag, p.id)
        assertEquals(listOf("Open"), n.actionTitles())
        assertEquals("Sent: Yes", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(p.title, n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(Notifier.CHANNEL_NEEDS_YOU, n.channelId)
    }

    @Test
    fun confirmOpenFollowsTheRouteItIsGiven() {
        val p = plan()
        notifier.confirm(p, "Not sent: question closed", "#/chat/m/s")

        val n = shadow.getNotification(p.tag, p.id)
        assertEquals(Routes.openLink(desk.origin, "#/chat/m/s"), shadowOf(n.actions[0].actionIntent).savedIntent.data.toString())
    }

    @Test
    fun cancelRemovesTheQuestionOfThatMachineOnly() {
        val a = plan("a")
        val b = NotifyPlanner.plan(notifyEvent(3, "a"), Machine("lap", "https://lap.tailafe04c.ts.net"))
        notifier.show(a, "#/inbox")
        notifier.show(b, "#/inbox")

        notifier.cancel(desk.origin, "a")

        assertNull(shadow.getNotification(a.tag, a.id))
        assertNotNull(shadow.getNotification(b.tag, b.id))
    }

    @Test
    fun cancelLeavesAConfirmationInPlace() {
        // The inbox message that follows an answer would otherwise delete "Sent: Yes" at once.
        val p = plan()
        notifier.show(p, "#/inbox")
        notifier.confirm(p, "Sent: Yes", "#/inbox")

        notifier.cancel(desk.origin, "a")

        assertEquals("Sent: Yes", shadow.getNotification(p.tag, p.id).extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }

    @Test
    fun cancelOfAnUnknownItemDoesNothing() {
        notifier.cancel(desk.origin, "nothing")
        assertEquals(0, shadow.size())
    }

    @Test
    fun connectionNoticeIsOngoingOnTheConnectionChannelWithMachinesAndBatteryActions() {
        val n = notifier.connection("Porthole is connected: 2 machines")

        assertEquals(Notifier.CHANNEL_CONNECTION, n.channelId)
        assertEquals("Porthole is connected: 2 machines", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertTrue(n.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(listOf("Machines", "Battery"), n.actionTitles())
        val machines = shadowOf(n.actions[0].actionIntent)
        val battery = shadowOf(n.actions[1].actionIntent)
        assertTrue(machines.isActivity && battery.isActivity)
        assertEquals("ai.porthole.app.settings.MachinesActivity", machines.savedIntent.component!!.className)
        assertEquals("ai.porthole.app.settings.BatteryGuideActivity", battery.savedIntent.component!!.className)
        assertEquals(context.packageName, machines.savedIntent.component!!.packageName)
    }

    @Test
    fun updatingTheConnectionNoticeReplacesTheOneNotification() {
        notifier.updateConnection("Porthole is connected: 1 machine")
        notifier.updateConnection("Porthole is connected: 2 machines")

        assertEquals(1, shadow.size())
        assertEquals(
            "Porthole is connected: 2 machines",
            shadow.getNotification(Notifier.CONNECTION_ID).extras.getCharSequence(Notification.EXTRA_TITLE).toString(),
        )
    }

    @Test
    fun connectionTextCountsOpenSockets() {
        assertEquals("Porthole is connected: 2 machines", Notifier.connectionText(context, 2, 2))
        assertEquals("Porthole is connected: 1 machine", Notifier.connectionText(context, 1, 2))
        assertEquals("Porthole is reconnecting", Notifier.connectionText(context, 0, 2))
        assertEquals("Porthole is connected: no machines", Notifier.connectionText(context, 0, 0))
    }

    @Test
    fun routeIsTheChatOfTheItemOrTheInbox() {
        val items = listOf(inboxItem("a", sessionId = "tmux:/run/t.sock:main:0.0", machine = "test desk"))

        assertEquals("#/chat/test%20desk/tmux%3A%2Frun%2Ft.sock%3Amain%3A0.0", Notifier.route(items, "a"))
        assertEquals("#/inbox", Notifier.route(items, "missing"))
        assertEquals("#/inbox", Notifier.route(emptyList(), "a"))
    }
}
