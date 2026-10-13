package ai.porthole.app.voice

import ai.porthole.shared.Wav
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class WavFileWriterTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun newFile(): File = File(tmp.root, "a.wav")

    private fun samplesOf(file: File): ShortArray {
        val b = ByteBuffer.wrap(file.readBytes(), 44, file.length().toInt() - 44).order(ByteOrder.LITTLE_ENDIAN)
        return ShortArray((file.length().toInt() - 44) / 2) { b.getShort() }
    }

    @Test fun oneSecondIs44PlusThirtyTwoThousandBytesWithMatchingHeader() {
        val file = newFile()
        val samples = ShortArray(16_000) { (it % 200 - 100).toShort() }
        WavFileWriter(file).use { assertTrue(it.write(samples, samples.size)) }

        assertEquals(44L + 32_000, file.length())
        val h = ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(36 + 32_000, h.getInt(4))
        assertEquals(32_000, h.getInt(40))
        assertArrayEquals(Wav.header(32_000), file.readBytes().copyOf(44))
        assertArrayEquals(samples, samplesOf(file))
    }

    @Test fun writingPastTheCapReturnsFalseAndKeepsExactlyTheCap() {
        val file = newFile()
        val block = ShortArray(400) { (it + 1).toShort() } // 800 bytes
        val w = WavFileWriter(file, maxDataBytes = 1_000)
        assertTrue(w.write(block, 400)) // 800 of 1000
        assertFalse(w.write(block, 400)) // only 100 samples fit
        assertFalse(w.write(block, 400)) // nothing fits any more
        w.close()

        assertEquals(44L + 1_000, file.length())
        assertEquals(1_000, ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN).getInt(40))
        val stored = samplesOf(file)
        assertEquals(500, stored.size)
        assertArrayEquals(block, stored.copyOfRange(0, 400))
        assertArrayEquals(block.copyOfRange(0, 100), stored.copyOfRange(400, 500)) // the part that fit
    }

    @Test fun reachingTheCapExactlyAlreadyReturnsFalse() {
        val w = WavFileWriter(newFile(), maxDataBytes = 800)
        assertFalse(w.write(ShortArray(400), 400))
        w.close()
        assertEquals(44L + 800, newFile().length())
    }

    @Test fun onlyTheFirstCountSamplesAreWritten() {
        val file = newFile()
        val buf = ShortArray(10) { (it + 1).toShort() }
        WavFileWriter(file).use { it.write(buf, 3) }
        assertArrayEquals(shortArrayOf(1, 2, 3), samplesOf(file))
    }

    @Test fun anEmptyRecordingIsJustAHeaderAndCloseTwiceIsHarmless() {
        val file = newFile()
        val w = WavFileWriter(file)
        w.close()
        w.close()
        assertArrayEquals(Wav.header(0), file.readBytes())
    }

    @Test fun anOddCapNeverStoresAHalfSample() {
        val file = newFile()
        WavFileWriter(file, maxDataBytes = 11).use { assertFalse(it.write(ShortArray(20), 20)) }
        assertEquals(44L + 10, file.length())
        assertEquals(10, ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN).getInt(40))
    }

    @Test fun samplesKeepTheirSignAsLittleEndian() {
        val file = newFile()
        WavFileWriter(file).use { it.write(shortArrayOf(-2, Short.MAX_VALUE, Short.MIN_VALUE), 3) }
        assertArrayEquals(
            byteArrayOf(0xFE.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0x7F, 0x00, 0x80.toByte()),
            file.readBytes().copyOfRange(44, 50),
        )
    }
}
