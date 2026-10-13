package ai.porthole.app.voice

import ai.porthole.shared.SilenceDetector
import ai.porthole.shared.Wav
import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield

/** A source of 16 kHz mono PCM16 samples. [read] blocks until samples are available. */
interface Mic {
    /** Fills the start of [buf] and returns how many samples were read; 0 means none yet, negative is an error. */
    fun read(buf: ShortArray): Int

    /** Stops capturing and releases the microphone. Called exactly once per recording. */
    fun stop()
}

/**
 * The real microphone: `VOICE_RECOGNITION` source, 16 kHz, mono, PCM16. Capture starts when the object is created
 * (so create one per recording) and ends in [stop]. The caller must already hold `RECORD_AUDIO`; without it, or when
 * another app holds the microphone, construction throws [IllegalStateException] instead of recording silence.
 */
@SuppressLint("MissingPermission")
class AudioRecordMic : Mic {
    private val record: AudioRecord
    private val stopped = AtomicBoolean(false)

    init {
        val minBytes = AudioRecord.getMinBufferSize(Wav.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minBytes > 0) { "AudioRecord.getMinBufferSize failed ($minBytes)" }
        // Room for at least two blocks of Recorder.BLOCK_SAMPLES so a slow reader does not overrun the ring.
        val bufferBytes = maxOf(minBytes, 2 * Recorder.BLOCK_SAMPLES * 2)
        val r = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            Wav.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        try {
            check(r.state == AudioRecord.STATE_INITIALIZED) { "The microphone could not be opened" }
            r.startRecording()
            check(r.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "The microphone is in use by another app" }
        } catch (e: Throwable) {
            r.release()
            throw e
        }
        record = r
    }

    override fun read(buf: ShortArray): Int = record.read(buf, 0, buf.size)

    override fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        try {
            record.stop()
        } finally {
            record.release()
        }
    }
}

/** Why a recording ended. */
object RecordingReason {
    const val STOPPED = "stopped"
    const val SILENCE = "silence"
    const val LIMIT = "limit"
    const val BACKGROUND = "background"
}

/** A finished recording: a complete WAV [file] (16 kHz mono PCM16) and the [reason] it ended (see [RecordingReason]). */
data class Recording(val file: File, val reason: String)

/**
 * Records one clip from [mic] into a new WAV file in [dir] (the bridge passes `cacheDir/voice`). A Recorder is single
 * use: it owns [mic] and stops it when [record] ends, so make a new Recorder with a new microphone for each clip.
 *
 * [maxDataBytes] is the 10-minute cap (design decision 10); tests pass a small one. Blocking microphone reads run on
 * [dispatcher].
 */
class Recorder(
    private val mic: Mic,
    private val dir: File,
    private val maxDataBytes: Long = Wav.maxRecordingDataBytes(),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val used = AtomicBoolean(false)

    @Volatile
    private var background = false

    /**
     * Ends a running (or about to run) [record] with reason [RecordingReason.BACKGROUND]: it returns what was recorded
     * so far. The bridge calls this when the activity goes to the background (design decision 10). Thread-safe.
     */
    fun stopForBackground() {
        background = true
    }

    /**
     * Records until [stopSignal] turns `true` ([RecordingReason.STOPPED]), until 2 s of silence follow speech when
     * [autoStop] is set ([RecordingReason.SILENCE]), until the cap is reached ([RecordingReason.LIMIT]), or until
     * [stopForBackground] is called ([RecordingReason.BACKGROUND]). Cancelling the coroutine discards the clip: the
     * file is deleted. A microphone read error throws [IOException] and also deletes the file.
     */
    suspend fun record(autoStop: Boolean, stopSignal: StateFlow<Boolean>): Recording {
        check(used.compareAndSet(false, true)) { "A Recorder records only once" }
        return withContext(dispatcher) {
            var file: File? = null
            var finished = false
            try {
                dir.mkdirs()
                file = File.createTempFile("rec-", ".wav", dir)
                val reason = WavFileWriter(file, maxDataBytes).use { capture(it, autoStop, stopSignal) }
                finished = true
                Recording(file, reason)
            } finally {
                try {
                    mic.stop()
                } finally {
                    if (!finished) file?.delete()
                }
            }
        }
    }

    private suspend fun capture(writer: WavFileWriter, autoStop: Boolean, stopSignal: StateFlow<Boolean>): String {
        val buf = ShortArray(BLOCK_SAMPLES)
        val silence = if (autoStop) SilenceDetector(Wav.SAMPLE_RATE) else null
        while (true) {
            yield() // lets the stop signal's owner run and throws if this coroutine was cancelled
            if (background) return RecordingReason.BACKGROUND
            if (stopSignal.value) return RecordingReason.STOPPED
            val n = mic.read(buf)
            if (n < 0) throw IOException("Microphone read failed ($n)")
            if (n == 0) continue
            if (!writer.write(buf, n)) return RecordingReason.LIMIT
            if (silence != null && silence.feed(buf, n)) return RecordingReason.SILENCE
        }
    }

    companion object {
        /** 100 ms of audio per read: the stop signal is looked at ten times a second. */
        const val BLOCK_SAMPLES = Wav.SAMPLE_RATE / 10
    }
}

/**
 * Holds the recording that ended until the page has received it, so `stopRecording` with nothing recording can hand
 * it out again (design decision 6). Thread-safe.
 */
class LastRecording {
    private var kept: Recording? = null

    /** Keeps [r]; a recording kept earlier is deleted. */
    @Synchronized
    fun keep(r: Recording) {
        val old = kept
        if (old != null && old.file != r.file) old.file.delete()
        kept = r
    }

    /** The kept recording, on every call, until [delivered] or [discard]. */
    @Synchronized
    fun current(): Recording? = kept

    /** The page has received the recording: delete the file and forget it. */
    @Synchronized
    fun delivered() = drop()

    /** Throws a stale recording away (a new `startRecording`): delete the file and forget it. */
    @Synchronized
    fun discard() = drop()

    private fun drop() {
        kept?.file?.delete()
        kept = null
    }
}
