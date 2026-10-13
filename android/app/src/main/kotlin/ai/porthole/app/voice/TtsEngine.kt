package ai.porthole.app.voice

/**
 * A text-to-speech engine that queues what it is given. [speak] appends to the queue (it never interrupts), [stop]
 * drops everything queued and silences the current utterance.
 *
 * [listener] is called from any thread with the id passed to [speak]: `done = false` when that utterance starts,
 * `done = true` when it has ended for good, whether it was spoken to the end, failed, or was cut off by [stop].
 */
interface TtsEngine {
    fun speak(text: String, id: String)

    fun stop()

    var listener: ((id: String, done: Boolean) -> Unit)?
}
