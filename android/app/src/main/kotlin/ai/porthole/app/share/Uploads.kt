package ai.porthole.app.share

import ai.porthole.app.net.HostClient
import ai.porthole.app.net.HostException
import ai.porthole.shared.Machine
import ai.porthole.shared.UploadReply
import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.IOException
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source

/** What [Uploads.shareAll] managed: one [ShareEvent] per file that arrived, and the first failure if any file did not. */
class ShareResult(val events: List<ShareEvent>, val failure: Throwable?)

/** A file hostd now holds: [path] is where it is on the machine, [name] is what the user knows it as. */
data class Uploaded(val path: String, val name: String)

/**
 * Sends files to a machine's `/v1/uploads`. A file is streamed from its content uri through [LimitedInputStream] and
 * is never held in memory; when it is bigger than [limit] the upload is aborted mid-stream and fails with [TooLarge].
 */
class Uploads(private val host: HostClient, private val limit: Long = UPLOAD_MAX_BYTES) {
    suspend fun send(m: Machine, uri: Uri, resolver: ContentResolver): Result<UploadReply> =
        upload(m, uri, resolver).map { UploadReply(it.path) }

    /** Like [send], and also returns the display name the file was uploaded under. */
    suspend fun upload(m: Machine, uri: Uri, resolver: ContentResolver): Result<Uploaded> = withContext(Dispatchers.IO) {
        val meta = describe(resolver, uri)
        if (meta.size != null && meta.size > limit) return@withContext Result.failure(TooLarge())
        val raw = try {
            resolver.openInputStream(uri) ?: return@withContext Result.failure(IOException(UNREADABLE))
        } catch (e: java.io.FileNotFoundException) {
            return@withContext Result.failure(IOException(UNREADABLE, e))
        } catch (e: RuntimeException) { // SecurityException when the sharing app granted nothing, among others
            return@withContext Result.failure(IOException(UNREADABLE, e))
        }
        try {
            val body = StreamBody(LimitedInputStream(raw, limit), meta.mime.toMediaTypeOrNull())
            host.upload(m, meta.name, meta.mime, body)
                .fold({ Result.success(Uploaded(it.path, meta.name)) }, { Result.failure(translate(it)) })
        } finally {
            try {
                raw.close()
            } catch (_: IOException) {
                // already failed or finished; nothing to add
            }
        }
    }

    /** Uploads shared [text] (a link, a note) as the file `shared-text.txt`. */
    suspend fun sendText(m: Machine, text: String): Result<Uploaded> {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size > limit) return Result.failure(TooLarge())
        val mime = "text/plain; charset=utf-8"
        return host.upload(m, TEXT_NAME, mime, bytes.toRequestBody(mime.toMediaTypeOrNull()))
            .fold({ Result.success(Uploaded(it.path, TEXT_NAME)) }, { Result.failure(translate(it)) })
    }

    /**
     * The share-sheet job: uploads every uri of [uris] in order (or, when there are none, the [text]) to [m]. A file that
     * fails does not stop the others; the first failure is returned next to the events of the files that went through.
     */
    suspend fun shareAll(m: Machine, uris: List<Uri>, text: String?, resolver: ContentResolver): ShareResult {
        val events = ArrayList<ShareEvent>()
        var failure: Throwable? = null
        val results = if (uris.isNotEmpty()) uris.map { upload(m, it, resolver) } else listOfNotNull(text?.let { sendText(m, it) })
        for (r in results) {
            r.fold({ events += ShareEvent(it.path, it.name, m.name, m.origin) }, { if (failure == null) failure = it })
        }
        return ShareResult(events, failure)
    }

    private class Meta(val name: String, val mime: String, val size: Long?)

    private fun describe(resolver: ContentResolver, uri: Uri): Meta {
        var name: String? = null
        var size: Long? = null
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                    val s = c.getColumnIndex(OpenableColumns.SIZE)
                    if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                }
            }
        } catch (_: RuntimeException) {
            // no metadata: the name falls back to the uri, and opening the stream reports a real permission problem
        }
        val mime = try {
            resolver.getType(uri)
        } catch (_: RuntimeException) {
            null
        }
        val shown = (name ?: uri.lastPathSegment)?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
        return Meta(shown, mime ?: "application/octet-stream", size)
    }

    /** TooLarge may come back wrapped by OkHttp; hostd's own 413 means the same thing. */
    private fun translate(e: Throwable): Throwable {
        var t: Throwable? = e
        var depth = 0
        while (t != null && depth++ < 8) {
            if (t is TooLarge) return t
            t.suppressed.firstOrNull { it is TooLarge }?.let { return it }
            t = t.cause
        }
        return if (e is HostException && e.code == 413) TooLarge() else e
    }

    /** One-shot: the stream is read once, so a failed attempt is never retried against a half-read stream. */
    private class StreamBody(private val input: InputStream, private val type: MediaType?) : RequestBody() {
        override fun contentType(): MediaType? = type
        override fun isOneShot(): Boolean = true
        override fun writeTo(sink: BufferedSink) {
            input.source().use { sink.writeAll(it) }
        }
    }

    private companion object {
        const val UNREADABLE = "Couldn't read the file"
        const val TEXT_NAME = "shared-text.txt"
    }
}
