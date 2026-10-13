package ai.porthole.app.events

import ai.porthole.shared.Arrival
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.NotifyPlanner
import ai.porthole.shared.ServerEvent

/**
 * What one machine's `notify` and `inbox` messages do to the notifications (design decisions 7 and 8). The socket
 * acks a notify after [onNotify] returns, whether it was shown or recognised as a duplicate; if [onNotify] throws, no
 * ack is sent and hostd offers the notify again on the next connect.
 *
 * [persist] runs after every change to the [ledger].
 */
class NotifyFlow(
    private val ledger: NotifyLedger,
    private val notifier: Notifier,
    private val machine: Machine,
    private val persist: () -> Unit = {},
) {
    /** The newest `inbox` message of this machine; empty until one arrives. */
    @Volatile
    var inbox: List<InboxItem> = emptyList()
        private set

    fun onNotify(n: ServerEvent.Notify) {
        when (ledger.arrival(n.id, n.itemId)) {
            Arrival.DUPLICATE -> return
            Arrival.COUNTER_RESET -> ledger.reset()
            Arrival.FRESH -> Unit
        }
        val items = inbox
        notifier.show(NotifyPlanner.plan(n, machine), Notifier.route(items, n.itemId))
        ledger.markShown(n.id, n.itemId)
        if (items.any { it.id == n.itemId && it.isNeedsYou() }) ledger.noteNeedsYou(n.itemId)
        persist()
    }

    fun onInbox(items: List<InboxItem>) {
        inbox = items
        for (itemId in ledger.onInbox(items.filter { it.isNeedsYou() }.mapTo(HashSet()) { it.id })) {
            notifier.cancel(machine.origin, itemId)
        }
        persist()
    }

    private fun InboxItem.isNeedsYou() = column == "needs-you" && archivedAt == null
}
