package ai.porthole.wear.data

import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchPaths
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService

/** What the listener does with the bytes it receives; Play-services free, so tests call it directly. */
class WearDataHandler(
    private val repository: StateRepository,
    private val pending: PendingAnswers,
    private val onNewState: () -> Unit,
) {
    /** A good state is stored and [onNewState] runs; bad bytes change nothing. */
    fun onStateBytes(bytes: ByteArray) {
        if (repository.update(bytes)) onNewState()
    }

    /** Completes the matching [PendingAnswers] entry; bad bytes and unknown request ids are ignored. */
    fun onAnswerResultBytes(bytes: ByteArray) {
        val result = WatchAnswerResult.decode(bytes) ?: return
        pending.complete(result)
    }
}

/** Receives the phone's `/porthole/state` data items and `/porthole/answer-result` messages. */
class WearDataListenerService : WearableListenerService() {
    private fun handler() = WearDataHandler(
        repository = WearData.repository(this),
        pending = WearData.pending,
        onNewState = { ComplicationUpdates.requestAll(this) },
    )

    override fun onDataChanged(events: DataEventBuffer) {
        val handler = handler()
        for (event in events) {
            if (event.type != DataEvent.TYPE_CHANGED) continue
            if (event.dataItem.uri.path != WatchPaths.STATE) continue
            event.dataItem.data?.let(handler::onStateBytes)
        }
    }

    override fun onMessageReceived(event: MessageEvent) {
        if (event.path == WatchPaths.ANSWER_RESULT) handler().onAnswerResultBytes(event.data)
    }
}
