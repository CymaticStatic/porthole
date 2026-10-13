package ai.porthole.wear.data

import ai.porthole.shared.WatchState
import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The last [WatchState] the phone sent. The raw bytes are kept in a file, so complications and screens show the
 * last list after a watch restart. Bad bytes are ignored, in [update] and in the file.
 */
class StateRepository(context: Context) {
    private val file = File(context.applicationContext.filesDir, FILE_NAME)
    private val mutableState = MutableStateFlow(load())

    val state: StateFlow<WatchState?> = mutableState.asStateFlow()

    /** Stores [bytes] when they decode to a [WatchState]; returns false (and changes nothing) otherwise. */
    @Synchronized
    fun update(bytes: ByteArray): Boolean {
        val decoded = WatchState.decode(bytes) ?: return false
        mutableState.value = decoded
        persist(bytes)
        return true
    }

    /**
     * True when there is a state and it is older than [STALE_AFTER_MS] at [now] (epoch ms): the screens then show
     * "Updated N min ago". With no state there is nothing to be old, so false.
     */
    fun isStale(now: Long): Boolean {
        val current = mutableState.value ?: return false
        return now - current.updatedAt > STALE_AFTER_MS
    }

    private fun load(): WatchState? =
        try {
            if (file.isFile) WatchState.decode(file.readBytes()) else null
        } catch (e: IOException) {
            Log.w(TAG, "Could not read the saved watch state", e)
            null
        }

    private fun persist(bytes: ByteArray) {
        try {
            val tmp = File(file.parentFile, "$FILE_NAME.tmp")
            tmp.writeBytes(bytes)
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        } catch (e: IOException) {
            // The in-memory state is right; only the copy that survives a restart is stale.
            Log.w(TAG, "Could not save the watch state", e)
        }
    }

    companion object {
        const val FILE_NAME = "watch-state.json"
        const val STALE_AFTER_MS = 15 * 60_000L
        private const val TAG = "StateRepository"
    }
}

/** The app's single [StateRepository], [PendingAnswers] and [AnswerSender]: `WearData.repository(ctx)`, `WearData.sender(ctx)`. */
object WearData {
    val pending = PendingAnswers()

    @Volatile private var repository: StateRepository? = null
    @Volatile private var sender: AnswerSender? = null

    fun repository(context: Context): StateRepository =
        repository ?: synchronized(this) {
            repository ?: StateRepository(context).also { repository = it }
        }

    fun sender(context: Context): AnswerSender =
        sender ?: synchronized(this) {
            sender ?: AnswerSender(PlayWearLink(context), pending).also { sender = it }
        }
}
