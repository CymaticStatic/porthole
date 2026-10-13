package ai.porthole.shared

import kotlinx.serialization.Serializable

@Serializable
data class ShownNotify(val id: Long, val itemId: String)

@Serializable
data class LedgerState(
    val highest: Long = 0,
    val shown: List<ShownNotify> = emptyList(),
    val unacked: List<Long> = emptyList(),
    val needsYou: List<String> = emptyList(),
)

enum class Arrival { FRESH, DUPLICATE, COUNTER_RESET }

/**
 * Per-machine record of which notifies were shown and acked, so a reconnect can ask for only newer ones, a
 * redelivery is not shown twice, and a restarted hostd counter is noticed (design decisions 7 and 8).
 */
class NotifyLedger(var state: LedgerState = LedgerState()) {
    fun arrival(id: Long, itemId: String): Arrival = when {
        id > state.highest -> Arrival.FRESH
        ShownNotify(id, itemId) in state.shown -> Arrival.DUPLICATE
        else -> Arrival.COUNTER_RESET
    }

    fun markShown(id: Long, itemId: String) {
        val pair = ShownNotify(id, itemId)
        state = state.copy(
            highest = maxOf(state.highest, id),
            shown = (state.shown - pair + pair).takeLast(MAX_KEPT),
            unacked = if (id in state.unacked) state.unacked else state.unacked + id,
        )
    }

    fun markAcked(id: Long) {
        if (id in state.unacked) state = state.copy(unacked = state.unacked - id)
    }

    fun since(): Long = state.highest

    fun pendingAcks(): List<Long> = state.unacked.toList()

    fun reset() {
        state = LedgerState()
    }

    /** The notification for [itemId] was shown while the item was in `needs-you`. */
    fun noteNeedsYou(itemId: String) {
        state = state.copy(needsYou = (state.needsYou - itemId + itemId).takeLast(MAX_KEPT))
    }

    /**
     * [needsYouIds]: item ids that are `needs-you` and unarchived in the newest `inbox` message. Returns the item ids
     * whose notifications must be cancelled (recorded as `needs-you`, no longer there) and starts tracking every shown
     * item that is `needs-you` now.
     */
    fun onInbox(needsYouIds: Set<String>): List<String> {
        val cancel = state.needsYou.filter { it !in needsYouIds }
        val tracked = state.needsYou.filter { it in needsYouIds }.toMutableList()
        for (s in state.shown) if (s.itemId in needsYouIds && s.itemId !in tracked) tracked.add(s.itemId)
        state = state.copy(needsYou = tracked.takeLast(MAX_KEPT))
        return cancel
    }

    private companion object {
        const val MAX_KEPT = 200
    }
}
