package ai.porthole.wear.data

import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchPaths
import android.content.Context
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.tasks.await

/** The only door to Play services' Data Layer for answers; tests use a fake. */
interface WearLink {
    /** Node id of a reachable phone that advertises [WatchPaths.PHONE_CAPABILITY], or null. */
    suspend fun phoneNodeId(): String?

    /** True when the message was handed to the Data Layer for [nodeId]. */
    suspend fun send(nodeId: String, path: String, bytes: ByteArray): Boolean
}

/** [WearLink] over `CapabilityClient` and `MessageClient`. Real-device behaviour only; not unit-testable. */
class PlayWearLink(context: Context) : WearLink {
    private val capabilities = Wearable.getCapabilityClient(context.applicationContext)
    private val messages = Wearable.getMessageClient(context.applicationContext)

    override suspend fun phoneNodeId(): String? =
        try {
            val nodes = capabilities
                .getCapability(WatchPaths.PHONE_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
                .await()
                .nodes
            (nodes.firstOrNull { it.isNearby } ?: nodes.firstOrNull())?.id
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }

    override suspend fun send(nodeId: String, path: String, bytes: ByteArray): Boolean =
        try {
            messages.sendMessage(nodeId, path, bytes).await()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
}

/** Sends watch answers to the phone and waits for the phone's result (design decision 11). */
class AnswerSender(private val link: WearLink, private val pending: PendingAnswers) {
    /**
     * Sends [a] on [WatchPaths.ANSWER] and returns the phone's result. No reachable phone, or a failed send, gives
     * `ok=false` [PHONE_NOT_CONNECTED]; nothing within [PendingAnswers.ANSWER_TIMEOUT_MS] gives
     * `ok=false` [PendingAnswers.NO_ANSWER].
     */
    suspend fun answer(a: WatchAnswer): WatchAnswerResult {
        val node = link.phoneNodeId() ?: return notConnected(a.requestId)
        pending.register(a.requestId)
        try {
            if (!link.send(node, WatchPaths.ANSWER, a.encode())) return notConnected(a.requestId)
            return pending.await(a.requestId)
        } finally {
            pending.cancel(a.requestId)
        }
    }

    /** Asks the phone to push state and usage now ([WatchPaths.REFRESH]); does nothing when no phone is reachable. */
    suspend fun refresh() {
        val node = link.phoneNodeId() ?: return
        link.send(node, WatchPaths.REFRESH, ByteArray(0))
    }

    private fun notConnected(requestId: String) = WatchAnswerResult(requestId, ok = false, message = PHONE_NOT_CONNECTED)

    companion object {
        const val PHONE_NOT_CONNECTED = "Phone not connected"
    }
}
