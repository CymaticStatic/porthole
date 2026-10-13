package ai.porthole.app.share

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * A stand-in for another app's file provider: `content://AUTHORITY/file/<key>` serves [entries]`[key]` with a display
 * name, a MIME type and, when [Entry.reportSize] is set, the `OpenableColumns.SIZE` column.
 */
class TestShareProvider : ContentProvider() {
    class Entry(val name: String?, val mime: String?, val bytes: ByteArray, val reportSize: Boolean = true)

    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<String>?, selection: String?, selectionArgs: Array<String>?, sortOrder: String?): Cursor? {
        val e = entries[uri.lastPathSegment] ?: return null
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
            addRow(arrayOf<Any?>(e.name, if (e.reportSize) e.bytes.size.toLong() else null))
        }
    }

    override fun getType(uri: Uri): String? = entries[uri.lastPathSegment]?.mime

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        if (uri.lastPathSegment == DENIED) throw SecurityException("no grant")
        val e = entries[uri.lastPathSegment] ?: return null
        val file = File.createTempFile("share-test", ".bin", context!!.cacheDir)
        file.writeBytes(e.bytes)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).also { file.delete() }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = throw UnsupportedOperationException()

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int =
        throw UnsupportedOperationException()

    companion object {
        const val AUTHORITY = "ai.porthole.test.share"

        /** Opening this key throws `SecurityException`, as a provider does when the sharing app granted nothing. */
        const val DENIED = "denied"
        val entries = ConcurrentHashMap<String, Entry>()

        fun uri(key: String): Uri = Uri.parse("content://$AUTHORITY/file/$key")
    }
}
