package ai.porthole.app.events

import ai.porthole.app.Intents
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.NotifyOption
import ai.porthole.shared.Routes
import android.app.Notification
import android.app.NotificationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class NotifyFlowTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val shadow get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private val desk = Machine("desk", "https://desk.tailafe04c.ts.net")
    private val lap = Machine("lap", "https://lap.tailafe04c.ts.net")
    private lateinit var notifier: Notifier
    private lateinit var ledger: NotifyLedger
    private lateinit var flow: NotifyFlow
    private var saves = 0

    @Before
    fun setUp() {
        notifier = Notifier(context)
        ledger = NotifyLedger()
        flow = NotifyFlow(ledger, notifier, desk) { saves++ }
    }

    private fun shown(machine: Machine, itemId: String): Notification? = shadow.getNotification(machine.origin, itemId.hashCode())

    private fun Notification.actionTitles() = actions.orEmpty().map { it.title.toString() }

    @Test
    fun aTwoOptionNotifyPostsOneNotificationOnNeedsYouWithOpenAndBothAnswers() {
        flow.onNotify(notifyEvent(1, "a", title = "T".repeat(100)))

        assertEquals(1, shadow.size())
        val n = shown(desk, "a")!!
        assertEquals(Notifier.CHANNEL_NEEDS_YOU, n.channelId)
        assertEquals(listOf("Open", "Yes", "No"), n.actionTitles())
        val title = n.extras.getCharSequence(Notification.EXTRA_TITLE).toString()
        assertEquals(80, title.length)
        assertTrue(title.endsWith("…"))
        assertEquals("Proceed?", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals("desk", n.extras.getCharSequence(Notification.EXTRA_SUB_TEXT).toString())
        assertEquals(0, n.flags and Notification.FLAG_LOCAL_ONLY) // Wear OS must be able to bridge it
    }

    @Test
    fun answerButtonsBroadcastToAnswerReceiverWithTheOptionAndDistinctRequestCodes() {
        flow.onNotify(notifyEvent(7, "a"))

        val buttons = shown(desk, "a")!!.actions.drop(1)
        val pending = buttons.map { shadowOf(it.actionIntent) }
        assertTrue(pending.all { it.isBroadcast && it.isImmutable })
        assertEquals(listOf(28, 29), pending.map { it.requestCode })
        val first = pending[0].savedIntent
        assertEquals(Intents.ACTION_ANSWER, first.action)
        assertEquals(AnswerReceiver::class.java.name, first.component!!.className)
        assertEquals(desk.origin, first.getStringExtra(Intents.EXTRA_ORIGIN))
        assertEquals("a", first.getStringExtra(Intents.EXTRA_ITEM))
        assertEquals(0, first.getIntExtra(Intents.EXTRA_INDEX, -1))
        assertEquals("Yes", first.getStringExtra(Intents.EXTRA_LABEL))
        assertEquals(7L, first.getLongExtra(Intents.EXTRA_NOTIFY_ID, -1))
        assertEquals(1, pending[1].savedIntent.getIntExtra(Intents.EXTRA_INDEX, -1))
    }

    @Test
    fun theSameNotifyTwicePostsOnceAndLeavesTheLedgerAlone() {
        flow.onNotify(notifyEvent(1, "a"))
        val after = ledger.state
        flow.onNotify(notifyEvent(1, "a"))

        assertEquals(1, shadow.size())
        assertEquals(after, ledger.state)
        assertEquals(1, saves)
    }

    @Test
    fun aFiveOptionNotifyHasOnlyOpen() {
        val five = (0..4).map { NotifyOption(it, "Option $it") }
        flow.onNotify(notifyEvent(1, "a", options = five))

        assertEquals(listOf("Open"), shown(desk, "a")!!.actionTitles())
    }

    @Test
    fun aThreeOptionNotifyShowsItsFirstTwoOptions() {
        val three = (0..2).map { NotifyOption(it, "Option $it") }
        flow.onNotify(notifyEvent(1, "a", options = three))

        assertEquals(listOf("Open", "Option 0", "Option 1"), shown(desk, "a")!!.actionTitles())
    }

    @Test
    fun aSecondMachinesItemWithTheSameItemIdGetsItsOwnNotification() {
        val other = NotifyFlow(NotifyLedger(), notifier, lap)
        flow.onNotify(notifyEvent(1, "same-item"))
        other.onNotify(notifyEvent(1, "same-item", title = "Other machine"))

        assertEquals(2, shadow.size())
        assertEquals("Question", shown(desk, "same-item")!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Other machine", shown(lap, "same-item")!!.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        // Same notify id on two machines must not make one machine's buttons answer the other's question.
        val a = shadowOf(shown(desk, "same-item")!!.actions[1].actionIntent)
        val b = shadowOf(shown(lap, "same-item")!!.actions[1].actionIntent)
        assertFalse(a.savedIntent.filterEquals(b.savedIntent))
    }

    @Test
    fun aQuestionNotificationStaysWhileNeedsYouAndIsCancelledWhenAnsweredElsewhere() {
        flow.onNotify(notifyEvent(1, "q"))

        flow.onInbox(listOf(inboxItem("q", column = "needs-you")))
        assertNotNull(shown(desk, "q"))

        flow.onInbox(listOf(inboxItem("q", column = "working")))
        assertNull(shown(desk, "q"))
    }

    @Test
    fun aQuestionNotificationShownAfterItsInboxRowIsTrackedAndCancelledToo() {
        flow.onInbox(listOf(inboxItem("q", column = "needs-you")))
        flow.onNotify(notifyEvent(1, "q"))
        assertNotNull(shown(desk, "q"))

        flow.onInbox(listOf(inboxItem("q", column = "working")))
        assertNull(shown(desk, "q"))
    }

    @Test
    fun aQuestionNotificationIsCancelledWhenTheItemLeavesTheInbox() {
        flow.onNotify(notifyEvent(1, "q"))
        flow.onInbox(listOf(inboxItem("q", column = "needs-you")))

        flow.onInbox(listOf(inboxItem("other", column = "needs-you")))
        assertNull(shown(desk, "q"))
    }

    @Test
    fun aQuestionNotificationIsCancelledWhenTheItemIsArchived() {
        flow.onNotify(notifyEvent(1, "q"))
        flow.onInbox(listOf(inboxItem("q", column = "needs-you")))

        flow.onInbox(listOf(inboxItem("q", column = "needs-you", archivedAt = 5)))
        assertNull(shown(desk, "q"))
    }

    @Test
    fun onlyTheItemThatLeftNeedsYouIsCancelled() {
        flow.onNotify(notifyEvent(1, "q1"))
        flow.onNotify(notifyEvent(2, "q2"))
        flow.onInbox(listOf(inboxItem("q1"), inboxItem("q2")))

        flow.onInbox(listOf(inboxItem("q1"), inboxItem("q2", column = "working")))
        assertNotNull(shown(desk, "q1"))
        assertNull(shown(desk, "q2"))
    }

    @Test
    fun aTurnFinishedNoticeStaysAfterEveryInboxMessage() {
        // hostd broadcasts the inbox right after queueing a turnFinished notify; the item is `working`, never `needs-you`.
        flow.onInbox(listOf(inboxItem("done-1", column = "working")))
        flow.onNotify(notifyEvent(1, "done-1", title = "Finished", options = emptyList()))

        flow.onInbox(listOf(inboxItem("done-1", column = "working")))
        flow.onInbox(listOf(inboxItem("done-1", column = "done")))
        flow.onInbox(emptyList())
        assertNotNull(shown(desk, "done-1"))
    }

    @Test
    fun aLowerIdForAnotherItemIsACounterResetThatIsShownAndRestartsTheLedger() {
        flow.onNotify(notifyEvent(900, "old"))
        assertEquals(900L, ledger.since())

        flow.onNotify(notifyEvent(1, "new"))

        assertNotNull(shown(desk, "new"))
        assertEquals(1L, ledger.since())
        assertEquals(listOf(1L), ledger.pendingAcks())
        assertEquals(ai.porthole.shared.Arrival.DUPLICATE, ledger.arrival(1, "new"))
    }

    @Test
    fun anItemNotifiedBeforeTheResetIsNotifiedAgainAfterIt() {
        flow.onNotify(notifyEvent(900, "same"))
        flow.onNotify(notifyEvent(2, "other"))
        flow.onNotify(notifyEvent(1, "same"))

        assertEquals(1L, ledger.since())
        assertNotNull(shown(desk, "same"))
    }

    @Test
    fun openGoesToTheChatWhenTheItemIsInTheLastInbox() {
        flow.onInbox(listOf(inboxItem("a", sessionId = "tmux:/run/t.sock:main:0.0", machine = "testdesk")))
        flow.onNotify(notifyEvent(1, "a"))

        val expected = Routes.openLink(desk.origin, "#/chat/testdesk/tmux%3A%2Frun%2Ft.sock%3Amain%3A0.0")
        val n = shown(desk, "a")!!
        assertEquals(expected, shadowOf(n.actions[0].actionIntent).savedIntent.data.toString())
        assertEquals(expected, shadowOf(n.contentIntent).savedIntent.data.toString())
        assertEquals(Notifier.MAIN_ACTIVITY, shadowOf(n.contentIntent).savedIntent.component!!.className)
    }

    @Test
    fun openGoesToTheInboxWhenTheItemIsNotInTheLastInbox() {
        flow.onInbox(listOf(inboxItem("something-else")))
        flow.onNotify(notifyEvent(1, "a"))

        val expected = Routes.openLink(desk.origin, "#/inbox")
        val n = shown(desk, "a")!!
        assertEquals(expected, shadowOf(n.actions[0].actionIntent).savedIntent.data.toString())
        assertEquals(expected, shadowOf(n.contentIntent).savedIntent.data.toString())
    }

    @Test
    fun openGoesToTheInboxBeforeAnyInboxMessageArrived() {
        flow.onNotify(notifyEvent(1, "a"))

        assertEquals(
            Routes.openLink(desk.origin, "#/inbox"),
            shadowOf(shown(desk, "a")!!.contentIntent).savedIntent.data.toString(),
        )
    }

    @Test
    fun theLedgerIsPersistedAfterEveryChange() {
        flow.onNotify(notifyEvent(1, "a"))
        assertEquals(1, saves)
        flow.onInbox(emptyList())
        assertEquals(2, saves)
    }
}
