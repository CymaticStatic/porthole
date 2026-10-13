package ai.porthole.app.voice

import ai.porthole.shared.Wav
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Streams 16 kHz mono 16-bit PCM into a WAV file. The 44-byte header is written first with a length of zero and
 * rewritten with the real length by [close] (design decision 10). Only whole samples are stored, and never more than
 * [maxDataBytes] bytes of audio.
 */
class WavFileWriter(
    private val file: File,
    maxDataBytes: Long = Wav.maxRecordingDataBytes(),
) : Closeable {
    // Whole samples only: an odd cap would leave a half sample that no reader can use.
    private val capBytes = maxDataBytes - maxDataBytes % BYTES_PER_SAMPLE
    private var dataBytes = 0L
    private var closed = false
    private var scratch = ByteArray(0)
    private val out = BufferedOutputStream(FileOutputStream(file), BUFFER_BYTES)

    init {
        out.write(Wav.header(0))
    }

    /**
     * Appends the first [count] samples. Samples that no longer fit under the cap are dropped. Returns `true` while
     * there is still room for more audio and `false` once the cap has been reached.
     */
    fun write(samples: ShortArray, count: Int): Boolean {
        check(!closed) { "WavFileWriter is closed" }
        require(count in 0..samples.size) { "count $count outside 0..${samples.size}" }
        val fit = ((capBytes - dataBytes) / BYTES_PER_SAMPLE).coerceAtMost(count.toLong()).toInt()
        if (fit > 0) {
            val byteCount = fit * BYTES_PER_SAMPLE
            if (scratch.size < byteCount) scratch = ByteArray(byteCount)
            for (i in 0 until fit) {
                val s = samples[i].toInt()
                scratch[2 * i] = s.toByte()
                scratch[2 * i + 1] = (s shr 8).toByte()
            }
            out.write(scratch, 0, byteCount)
            dataBytes += byteCount
        }
        return capBytes - dataBytes >= BYTES_PER_SAMPLE
    }

    /** Flushes the audio and patches the header with the real length. Safe to call twice. */
    override fun close() {
        if (closed) return
        closed = true
        try {
            out.close()
        } finally {
            RandomAccessFile(file, "rw").use {
                it.seek(0)
                it.write(Wav.header(dataBytes))
            }
        }
    }

    private companion object {
        const val BYTES_PER_SAMPLE = 2
        const val BUFFER_BYTES = 32 * 1024
    }
}
