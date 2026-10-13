package ai.porthole.shared

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

object Wav {
    const val SAMPLE_RATE = 16_000
    const val MAX_BYTES = 25L * 1024 * 1024
    const val MAX_RECORDING_MS = 600_000L
    private const val HEADER_BYTES = 44

    /** 44-byte canonical header: PCM, 1 channel, 16 kHz, 16 bit, little-endian, for [dataBytes] bytes of samples. */
    fun header(dataBytes: Long): ByteArray {
        val b = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray(Charsets.US_ASCII))
        b.putInt((36 + dataBytes).toInt())
        b.put("WAVE".toByteArray(Charsets.US_ASCII))
        b.put("fmt ".toByteArray(Charsets.US_ASCII))
        b.putInt(16)
        b.putShort(1) // PCM
        b.putShort(1) // mono
        b.putInt(SAMPLE_RATE)
        b.putInt(SAMPLE_RATE * 2) // byte rate
        b.putShort(2) // block align
        b.putShort(16) // bits per sample
        b.put("data".toByteArray(Charsets.US_ASCII))
        b.putInt(dataBytes.toInt())
        return b.array()
    }

    fun maxDataBytes(): Long = MAX_BYTES - HEADER_BYTES

    fun maxRecordingDataBytes(): Long = SAMPLE_RATE * 2L * MAX_RECORDING_MS / 1000
}

/**
 * Auto-stop for talk mode: [feed] returns true once speech (a block with RMS >= [thresholdRms]) was heard and
 * then [silenceMs] of continuous quiet blocks followed.
 */
class SilenceDetector(
    private val sampleRate: Int = 16_000,
    private val thresholdRms: Double = 500.0,
    private val silenceMs: Long = 2_000,
) {
    private var heardSpeech = false
    private var silentSamples = 0L

    fun feed(samples: ShortArray, count: Int): Boolean {
        if (count <= 0) return false
        var sum = 0.0
        for (i in 0 until count) {
            val s = samples[i].toDouble()
            sum += s * s
        }
        val rms = sqrt(sum / count)
        if (rms >= thresholdRms) {
            heardSpeech = true
            silentSamples = 0
            return false
        }
        if (!heardSpeech) return false
        silentSamples += count
        return silentSamples >= sampleRate * silenceMs / 1000
    }
}
