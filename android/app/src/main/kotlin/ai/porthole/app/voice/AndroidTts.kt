package ai.porthole.app.voice

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log

/**
 * [TtsEngine] on the system `TextToSpeech`: `QUEUE_ADD`, music stream. Create it on the main thread: the engine binds
 * asynchronously and utterances given before it is ready are held and spoken in order once it is. If the engine cannot
 * start, every utterance ends at once (`done = true`, logged) so a caller waiting on it never hangs. Call [shutdown]
 * when the owner goes away.
 */
class AndroidTts(context: Context) : TtsEngine {
    private val lock = Any()
    private val pending = ArrayDeque<Pair<String, String>>() // text, id
    private var ready = false
    private var failed = false

    @Volatile
    override var listener: ((id: String, done: Boolean) -> Unit)? = null

    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status -> onInit(status) }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) {
                listener?.invoke(utteranceId, false)
            }

            override fun onDone(utteranceId: String) {
                listener?.invoke(utteranceId, true)
            }

            @Deprecated("Replaced by onError(String, Int)")
            override fun onError(utteranceId: String) {
                Log.w(TAG, "TextToSpeech failed on $utteranceId")
                listener?.invoke(utteranceId, true)
            }

            override fun onError(utteranceId: String, errorCode: Int) {
                Log.w(TAG, "TextToSpeech failed on $utteranceId (error $errorCode)")
                listener?.invoke(utteranceId, true)
            }

            override fun onStop(utteranceId: String, interrupted: Boolean) {
                listener?.invoke(utteranceId, true)
            }
        })
    }

    override fun speak(text: String, id: String) {
        val failNow = synchronized(lock) {
            when {
                failed -> true
                ready -> { enqueue(text, id); false }
                else -> { pending.addLast(text to id); false }
            }
        }
        if (failNow) endUnspoken(id)
    }

    override fun stop() {
        val dropped = synchronized(lock) { pending.map { it.second }.also { pending.clear() } }
        tts.stop()
        dropped.forEach { listener?.invoke(it, true) }
    }

    /** Releases the engine. The instance is unusable afterwards. */
    fun shutdown() {
        synchronized(lock) { pending.clear() }
        tts.stop()
        tts.shutdown()
    }

    private fun onInit(status: Int) {
        val unspoken = synchronized(lock) {
            if (status == TextToSpeech.SUCCESS) {
                ready = true
                while (pending.isNotEmpty()) pending.removeFirst().let { enqueue(it.first, it.second) }
                emptyList()
            } else {
                failed = true
                pending.map { it.second }.also { pending.clear() }
            }
        }
        if (status != TextToSpeech.SUCCESS) Log.e(TAG, "TextToSpeech could not start (status $status)")
        unspoken.forEach { endUnspoken(it) }
    }

    private fun enqueue(text: String, id: String) {
        val params = Bundle().apply { putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC) }
        if (tts.speak(text, TextToSpeech.QUEUE_ADD, params, id) != TextToSpeech.SUCCESS) {
            Log.w(TAG, "TextToSpeech refused utterance $id")
            endUnspoken(id)
        }
    }

    private fun endUnspoken(id: String) {
        listener?.invoke(id, true)
    }

    private companion object {
        const val TAG = "AndroidTts"
    }
}
