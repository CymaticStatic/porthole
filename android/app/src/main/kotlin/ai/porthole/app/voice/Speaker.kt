package ai.porthole.app.voice

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred

/**
 * Reads utterances aloud through [engine] while holding transient may-duck audio [focus].
 *
 * Every utterance is handed to the engine at once (it queues them) and [speak] finishes when the last one has ended.
 * An utterance longer than [maxChars] (the engine's maximum input length) is split first. One reading at a time: a
 * new [speak] stops the one in progress, which then returns `false`. When the engine reports that an utterance of the
 * reading failed and the reading then ends by itself, [speak] throws [SpeechFailedException].
 */
class Speaker(
    private val engine: TtsEngine,
    private val focus: AudioFocus,
    private val maxChars: Int = DEFAULT_MAX_CHARS,
) {
    private class Reading(val ids: Set<String>, val lastId: String, val result: CompletableDeferred<Boolean> = CompletableDeferred()) {
        @Volatile var failed = false
    }

    private val lock = Any()
    private var reading: Reading? = null
    private val counter = AtomicLong()

    init {
        require(maxChars >= 1) { "maxChars must be positive" }
        engine.listener = { id, done -> if (done) onEnded(id) }
        engine.errorListener = { id -> onFailed(id) }
    }

    /**
     * `true` once the last utterance has ended, `false` when [stop] (or another [speak]) cut it short.
     * @throws SpeechFailedException when an utterance could not be spoken
     */
    suspend fun speak(utterances: List<String>): Boolean {
        val pieces = utterances.filter { it.isNotBlank() }.flatMap { split(it, maxChars) }
        if (pieces.isEmpty()) return true

        val ids = pieces.map { "u${counter.incrementAndGet()}" }
        val mine = Reading(ids = ids.toSet(), lastId = ids.last())
        val previous = synchronized(lock) { reading.also { reading = mine } }
        if (previous != null) {
            engine.stop()
            previous.result.complete(false)
        }

        focus.request()
        try {
            pieces.forEachIndexed { i, text -> engine.speak(text, ids[i]) }
            val finished = mine.result.await()
            if (finished && mine.failed) throw SpeechFailedException()
            return finished
        } finally {
            // Still the active reading: it ended by itself, by cancellation or by a failure, so release the focus and
            // make sure nothing of ours stays queued. Otherwise stop() or a newer speak() already took over.
            if (release(mine)) {
                if (!mine.result.isCompleted) engine.stop()
                focus.abandon()
            }
        }
    }

    /** Silences the engine and ends the reading in progress with `false`. */
    fun stop() {
        val current = synchronized(lock) { reading.also { reading = null } }
        engine.stop()
        if (current != null) {
            current.result.complete(false)
            focus.abandon()
        }
    }

    private fun onEnded(id: String) {
        val current = synchronized(lock) { reading }
        if (current != null && current.lastId == id) current.result.complete(true)
    }

    private fun onFailed(id: String) {
        val current = synchronized(lock) { reading }
        if (current != null && id in current.ids) current.failed = true
    }

    /** Clears [r] as the active reading if it still is. */
    private fun release(r: Reading): Boolean = synchronized(lock) {
        if (reading === r) { reading = null; true } else false
    }

    companion object {
        const val DEFAULT_MAX_CHARS = 4_000

        /**
         * Cuts [text] into pieces of at most [max] characters that concatenate back to [text]: each cut is just after
         * the last space that fits, or hard at [max] when there is none (never between the halves of a surrogate pair).
         */
        fun split(text: String, max: Int): List<String> {
            if (text.length <= max) return listOf(text)
            val out = ArrayList<String>()
            var start = 0
            while (text.length - start > max) {
                val window = start + max
                val space = text.lastIndexOf(' ', window - 1)
                var cut = if (space >= start) space + 1 else window
                if (cut == window && cut - 1 > start && text[cut - 1].isHighSurrogate()) cut--
                out.add(text.substring(start, cut))
                start = cut
            }
            out.add(text.substring(start))
            return out
        }
    }
}

/** The engine could not speak part of a reading. The bridge turns it into an error reply (the page words it itself). */
class SpeechFailedException : Exception("Text-to-speech failed")
