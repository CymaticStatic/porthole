package ai.porthole.app.share

import java.io.ByteArrayInputStream
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LimitedInputStreamTest {
    private fun stream(size: Int, limit: Long) = LimitedInputStream(ByteArrayInputStream(ByteArray(size) { 7 }), limit)

    @Test
    fun exactlyTheLimitPasses() {
        assertEquals(1_000, stream(1_000, 1_000).readBytes().size)
    }

    @Test
    fun oneByteMoreThrowsTooLarge() {
        assertThrows(TooLarge::class.java) { stream(1_001, 1_000).readBytes() }
    }

    @Test
    fun theTooLargeMessageNamesTheFiftyMegabyteLimit() {
        val e = assertThrows(TooLarge::class.java) { stream(10, 5).readBytes() }
        assertEquals("Too big: 50 MB limit", e.message)
    }

    @Test
    fun singleByteReadsAreCountedToo() {
        val s = stream(3, 2)
        s.read()
        s.read()
        assertThrows(TooLarge::class.java) { s.read() }
    }

    @Test
    fun emptyInputPassesAtAnyLimit() {
        assertEquals(0, stream(0, 0).readBytes().size)
    }

    @Test
    fun skippedBytesCountTowardsTheLimit() {
        val s = stream(100, 40)
        assertEquals(30, s.skip(30))
        assertThrows(TooLarge::class.java) { s.readBytes() }
    }

    @Test
    fun itNeverReadsFarPastTheLimit() {
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int {
                served++
                return 0
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                served += len
                return len
            }
        }
        assertThrows(TooLarge::class.java) { LimitedInputStream(endless, 1_024).readBytes() }
        assertTrue("served $served bytes", served < 1_024 + 64 * 1024)
    }

    @Test
    fun closeClosesTheUnderlyingStream() {
        var closed = false
        val inner = object : InputStream() {
            override fun read() = -1
            override fun close() {
                closed = true
            }
        }
        LimitedInputStream(inner, 10).close()
        assertTrue(closed)
    }
}
