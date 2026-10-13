package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.net.HostClient
import ai.porthole.shared.AnswerOutcome
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyPlan
import ai.porthole.shared.text
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/**
 * Posts an answer tapped on a notification button and replaces the notification with the result. [routeFor] gives
 * the page route the confirmation's Open action goes to for `(machine, itemId)`.
 */
class AnswerHandler(
    private val host: HostClient,
    private val notifier: Notifier,
    private val routeFor: (Machine, String) -> String = { _, _ -> "#/inbox" },
) {
    suspend fun answer(machine: Machine, itemId: String, index: Int, label: String, plan: NotifyPlan): AnswerOutcome {
        val outcome = host.answer(machine, itemId, listOf(index), label)
        notifier.confirm(plan, outcome.text(), routeFor(machine, itemId))
        return outcome
    }

    /** [answer], but a request that takes longer than [timeoutMs] counts as failed, so the broadcast can finish. */
    suspend fun answerWithin(
        timeoutMs: Long,
        machine: Machine,
        itemId: String,
        index: Int,
        label: String,
        plan: NotifyPlan,
    ): AnswerOutcome = try {
        withTimeout(timeoutMs) { answer(machine, itemId, index, label, plan) }
    } catch (_: TimeoutCancellationException) {
        AnswerOutcome.Failed("Timed out").also { notifier.confirm(plan, it.text(), routeFor(machine, itemId)) }
    }

    companion object {
        fun shared(): AnswerHandler = Graph.once {
            AnswerHandler(Graph.host, Notifier.shared()) { machine, itemId ->
                Notifier.route(ConnectionHub.shared().inbox.value[machine.origin].orEmpty(), itemId)
            }
        }
    }
}
