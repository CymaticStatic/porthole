package ai.porthole.app.relay

import ai.porthole.shared.WatchPaths
import android.content.Context
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.tasks.await

/**
 * The only door from the relay to Play services' Data Layer; tests use a fake. Every call may throw (no Play
 * services, no connection): callers decide what a failure means.
 */
interface WearMessages {
    /** Node ids of the watches connected to this phone right now; empty when none is. */
    suspend fun connectedWatchNodes(): List<String>

    /** Writes [bytes] as the DataItem at [WatchPaths.STATE], urgent so it syncs at once. */
    suspend fun putState(bytes: ByteArray)

    /** Sends a message on [path] to [nodeId]. */
    suspend fun reply(nodeId: String, path: String, bytes: ByteArray)
}

/** [WearMessages] over `NodeClient`, `DataClient` and `MessageClient`. Real-device behaviour only; not unit-testable. */
class PlayWearMessages(context: Context) : WearMessages {
    private val app = context.applicationContext
    private val nodes by lazy { Wearable.getNodeClient(app) }
    private val data by lazy { Wearable.getDataClient(app) }
    private val messages by lazy { Wearable.getMessageClient(app) }

    override suspend fun connectedWatchNodes(): List<String> = nodes.connectedNodes.await().map { it.id }

    override suspend fun putState(bytes: ByteArray) {
        data.putDataItem(PutDataRequest.create(WatchPaths.STATE).setData(bytes).setUrgent()).await()
    }

    override suspend fun reply(nodeId: String, path: String, bytes: ByteArray) {
        messages.sendMessage(nodeId, path, bytes).await()
    }
}
