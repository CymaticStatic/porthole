package ai.porthole.app.relay

import ai.porthole.shared.Machine
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchState

/** What a watch answer means for hostd. */
sealed interface RelayCall {
    /** `POST /v1/inbox/:itemId/answer` with these option indexes. */
    data class Answer(val machine: Machine, val itemId: String, val optionIndexes: List<Int>) : RelayCall

    /** `POST /v1/sessions/:id/keys` with `Esc`: the watch's Stop button. */
    data class Stop(val machine: Machine, val sessionId: String) : RelayCall
}

/** The pure decisions of the phone-to-watch relay. */
object RelayLogic {
    /**
     * True when the watch would see something different: the items or the usage windows changed, or nothing was
     * pushed yet. [WatchState.updatedAt] alone never counts, so a quiet inbox does not rewrite the DataItem.
     */
    fun shouldPush(prev: WatchState?, next: WatchState): Boolean =
        prev == null || prev.items != next.items || prev.usage != next.usage

    /** The hostd call for [a], or null when its origin is not one of [machines] (the machine was removed). */
    fun answerToCall(a: WatchAnswer, machines: List<Machine>): RelayCall? {
        val machine = machines.firstOrNull { it.origin == a.origin() } ?: return null
        return when (a) {
            is WatchAnswer.Option -> RelayCall.Answer(machine, a.itemId, a.optionIndexes)
            is WatchAnswer.Stop -> RelayCall.Stop(machine, a.sessionId)
        }
    }

    private fun WatchAnswer.origin(): String = when (this) {
        is WatchAnswer.Option -> origin
        is WatchAnswer.Stop -> origin
    }
}
