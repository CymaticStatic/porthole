package ai.porthole.app.share

import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream

/** SPEC 4.8: one uploaded file may be at most 50 MB. */
const val UPLOAD_MAX_BYTES: Long = 50L * 1024 * 1024

/** The stream held more than the allowed number of bytes. The text is what the user sees. */
class TooLarge : IOException("Too big: 50 MB limit")

/**
 * Passes [input] through and throws [TooLarge] as soon as more than [limit] bytes have been read or skipped. It never
 * buffers: the check only counts, so an upload of any size is stopped after at most one read past the limit.
 */
class LimitedInputStream(input: InputStream, private val limit: Long = UPLOAD_MAX_BYTES) : FilterInputStream(input) {
    private var count = 0L

    override fun read(): Int {
        val b = `in`.read()
        if (b >= 0) add(1)
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        val n = `in`.read(b, off, len)
        if (n > 0) add(n.toLong())
        return n
    }

    override fun skip(n: Long): Long {
        val skipped = `in`.skip(n)
        if (skipped > 0) add(skipped)
        return skipped
    }

    override fun markSupported(): Boolean = false

    override fun mark(readlimit: Int) = Unit

    override fun reset() {
        throw IOException("mark/reset not supported")
    }

    private fun add(n: Long) {
        count += n
        if (count > limit) throw TooLarge()
    }
}
