package ai.porthole.shared

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioTest {
    @Test fun headerIsCanonical16kMono16bit() {
        val h = ByteBuffer.wrap(Wav.header(32_000)).order(ByteOrder.LITTLE_ENDIAN)
        assertArrayEquals("RIFF".toByteArray(), ByteArray(4) { h.get(it) })
        assertEquals(36 + 32_000, h.getInt(4))
        assertArrayEquals("WAVEfmt ".toByteArray(), ByteArray(8) { h.get(8 + it) })
        assertEquals(16, h.getInt(16)); assertEquals(1, h.getShort(20).toInt()); assertEquals(1, h.getShort(22).toInt())
        assertEquals(16_000, h.getInt(24)); assertEquals(32_000, h.getInt(28))
        assertEquals(2, h.getShort(32).toInt()); assertEquals(16, h.getShort(34).toInt())
        assertArrayEquals("data".toByteArray(), ByteArray(4) { h.get(36 + it) })
        assertEquals(32_000, h.getInt(40))
        assertEquals(44, Wav.header(0).size)
    }
    @Test fun limitIs25MegabytesIncludingHeader() = assertEquals(25L * 1024 * 1024 - 44, Wav.maxDataBytes())
    @Test fun recordingCapIsTenMinutesOf16kMono() {
        assertEquals(19_200_000L, Wav.maxRecordingDataBytes())
        assertTrue(Wav.maxRecordingDataBytes() <= Wav.maxDataBytes())
    }
    @Test fun headerForTheRecordingCapIsExact() {
        val h = ByteBuffer.wrap(Wav.header(Wav.maxRecordingDataBytes())).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(19_200_000, h.getInt(40))
        assertEquals(19_200_036, h.getInt(4))
    }

    private fun block(level: Short) = ShortArray(1_600) { if (it % 2 == 0) level else (-level).toShort() } // 100 ms

    @Test fun silenceBeforeSpeechNeverStops() {
        val d = SilenceDetector()
        repeat(50) { assertFalse(d.feed(block(10), 1_600)) }
    }
    @Test fun twoSecondsOfSilenceAfterSpeechStops() {
        val d = SilenceDetector()
        assertFalse(d.feed(block(4_000), 1_600))
        repeat(19) { assertFalse(d.feed(block(10), 1_600)) }
        assertTrue(d.feed(block(10), 1_600))
    }
    @Test fun speechResetsTheSilenceClock() {
        val d = SilenceDetector()
        d.feed(block(4_000), 1_600); repeat(15) { d.feed(block(10), 1_600) }
        assertFalse(d.feed(block(4_000), 1_600))
        repeat(19) { assertFalse(d.feed(block(10), 1_600)) }
        assertTrue(d.feed(block(10), 1_600))
    }
    @Test fun onlyTheFirstCountSamplesAreMeasured() {
        val d = SilenceDetector()
        val loudTail = ShortArray(1_600) { if (it < 800) 10 else 30_000 }
        // first 800 samples are quiet, so this block is not speech, and silence never starts
        repeat(50) { assertFalse(d.feed(loudTail, 800)) }
    }
    @Test fun thresholdIsInclusive() {
        val d = SilenceDetector(thresholdRms = 500.0, silenceMs = 100)
        assertFalse(d.feed(block(500), 1_600)) // RMS exactly 500: speech
        assertTrue(d.feed(block(10), 1_600))
    }
}
