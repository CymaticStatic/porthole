package ai.porthole.app.relay

import ai.porthole.app.Graph
import ai.porthole.app.events.ConnectionHub
import ai.porthole.app.net.HostClient
import ai.porthole.shared.AnswerOutcome
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchPaths
import ai.porthole.shared.text
import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What the phone does with a message from the watch; Play-services free, so tests drive it with a fake
 * [WearMessages]. [machines] and [inbox] are read at call time. [refresh] runs for [WatchPaths.REFRESH].
 */
class RelayHandler(
    private val host: HostClient,
    private val wear: WearMessages,
    private val machines: () -> List<Machine>,
    private val inbox: () -> Map<String, List<InboxItem>>,
    private val refresh: () -> Unit,
) {
    /** Handles one message from [sourceNodeId]; messages on other paths are ignored. */
    suspend fun onMessage(sourceNodeId: String, path: String, data: ByteArray) {
        when (path) {
            WatchPaths.ANSWER -> onAnswer(sourceNodeId, data)
            WatchPaths.REFRESH -> refresh()
        }
    }

    private suspend fun onAnswer(sourceNodeId: String, data: ByteArray) {
        val answer = WatchAnswer.decode(data) ?: return // no request id to reply to
        val result = when (val call = RelayLogic.answerToCall(answer, machines())) {
            null -> WatchAnswerResult(answer.requestId, ok = false, message = UNKNOWN_MACHINE)
            is RelayCall.Answer -> {
                val outcome = host.answer(call.machine, call.itemId, call.optionIndexes, labelOf(call))
                resultOf(answer.requestId, outcome)
            }
            is RelayCall.Stop -> {
                val outcome = host.keys(call.machine, call.sessionId, listOf("Esc")).fold(
                    onSuccess = { AnswerOutcome.Sent("Stop") },
                    onFailure = { AnswerOutcome.Failed(it.message ?: "Failed") },
                )
                resultOf(answer.requestId, outcome)
            }
        }
        try {
            wear.reply(sourceNodeId, WatchPaths.ANSWER_RESULT, result.encode())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not send the answer result to the watch", e)
        }
    }

    private fun resultOf(requestId: String, outcome: AnswerOutcome) =
        WatchAnswerResult(requestId, ok = outcome is AnswerOutcome.Sent, message = outcome.text())

    /** The option text(s) the watch tapped, for "Sent: Yes". */
    private fun labelOf(call: RelayCall.Answer): String {
        val options = inbox()[call.machine.origin].orEmpty().firstOrNull { it.id == call.itemId }?.question?.options.orEmpty()
        return call.optionIndexes.mapNotNull { options.getOrNull(it) }.joinToString(", ").ifEmpty { "answer" }
    }

    companion object {
        const val UNKNOWN_MACHINE = "Machine not set up on the phone"
        private const val TAG = "RelayHandler"

        fun shared(): RelayHandler = Graph.once {
            RelayHandler(
                host = Graph.host,
                wear = PlayWearMessages(Graph.context),
                machines = { Graph.machines.machines.value },
                inbox = { ConnectionHub.shared().inbox.value },
                refresh = { WatchRelay.shared().refresh() },
            )
        }
    }
}

/**
 * Receives the watch's `/porthole/answer` and `/porthole/refresh` messages. Play services calls it on its own
 * background thread, and the process may only be kept alive while the callback runs, so the work is done inside it,
 * within [BUDGET_MS] (the watch gives up after 15 s).
 */
class RelayListenerService : WearableListenerService() {
    override fun onMessageReceived(event: MessageEvent) {
        val handler = RelayHandler.shared()
        runBlocking {
            withTimeoutOrNull(BUDGET_MS) { handler.onMessage(event.sourceNodeId, event.path, event.data) }
        }
    }

    companion object {
        const val BUDGET_MS = 13_000L
    }
}
