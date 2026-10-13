package ai.porthole.wear.data

import ai.porthole.shared.WatchAnswerResult
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One waiting [CompletableDeferred] per `requestId`. [register] before the answer is sent, [complete] when the
 * phone's `ANSWER_RESULT` arrives, [await] gives the result or `ok=false` "Phone didn't answer" after [timeoutMs].
 * The timeout runs on the coroutine clock, so tests use virtual time.
 */
class PendingAnswers(private val timeoutMs: Long = ANSWER_TIMEOUT_MS) {
    private val waiting = ConcurrentHashMap<String, CompletableDeferred<WatchAnswerResult>>()

    fun register(requestId: String) {
        waiting.computeIfAbsent(requestId) { CompletableDeferred() }
    }

    /** True when [result] matched a registered request; a result for an unknown `requestId` is ignored. */
    fun complete(result: WatchAnswerResult): Boolean =
        waiting.remove(result.requestId)?.complete(result) ?: false

    /** Forget [requestId] without a result (the send failed, or the caller was cancelled). */
    fun cancel(requestId: String) {
        waiting.remove(requestId)
    }

    suspend fun await(requestId: String): WatchAnswerResult {
        val deferred = checkNotNull(waiting[requestId]) { "await($requestId) without register" }
        try {
            return withTimeoutOrNull(timeoutMs) { deferred.await() }
                ?: WatchAnswerResult(requestId, ok = false, message = NO_ANSWER)
        } finally {
            waiting.remove(requestId)
        }
    }

    companion object {
        const val ANSWER_TIMEOUT_MS = 15_000L
        const val NO_ANSWER = "Phone didn't answer"
    }
}
