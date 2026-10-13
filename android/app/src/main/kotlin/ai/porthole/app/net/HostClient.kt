package ai.porthole.app.net

import ai.porthole.shared.AnswerOutcome
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.MachineInfo
import ai.porthole.shared.Routes
import ai.porthole.shared.Usage
import ai.porthole.shared.UploadReply
import ai.porthole.shared.Wire
import ai.porthole.shared.from
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink

/**
 * Typed hostd calls. The page posts recordings to `/v1/voice` itself (design decision 6), so there is no voice call.
 * Every call names the [Machine] it goes to; nothing is cached here.
 */
class HostClient(private val http: Http) {
    suspend fun machine(m: Machine): Result<MachineInfo> = attempt {
        get(Routes.machine(m.origin)) { Wire.parseMachineInfo(it) }
    }

    /** [label] is the button text the user tapped; it only ends up in the `Sent` outcome. */
    suspend fun answer(m: Machine, itemId: String, indexes: List<Int>, label: String = ""): AnswerOutcome =
        try {
            val request = Request.Builder()
                .url(Routes.answer(m.origin, itemId))
                .post(Wire.answerBody(indexes).toByteArray().toRequestBody(JSON))
                .build()
            http.call(request) { AnswerOutcome.from(it.code, it.body.string(), label) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            AnswerOutcome.from(-1, null, label)
        }

    suspend fun keys(m: Machine, sessionId: String, keys: List<String>): Result<Unit> = attempt {
        val request = Request.Builder()
            .url(Routes.keys(m.origin, sessionId))
            .post(Wire.keysBody(keys).toByteArray().toRequestBody(JSON))
            .build()
        http.call(request) { it.requireOk() }
    }

    suspend fun usage(m: Machine): Result<Usage> = attempt {
        get(Routes.usage(m.origin)) { Wire.parseUsage(it) }
    }

    suspend fun inbox(m: Machine): Result<List<InboxItem>> = attempt {
        get(m.origin.trimEnd('/') + "/v1/inbox") { Wire.json.decodeFromString<InboxReply>(it).items }
    }

    /** Streams [body] as the multipart field `file`; [mime] is the part's content type. */
    suspend fun upload(m: Machine, name: String, mime: String, body: RequestBody): Result<UploadReply> = attempt {
        val part = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", name, WithType(body, mime.toMediaTypeOrNull()))
            .build()
        val request = Request.Builder().url(Routes.uploads(m.origin)).post(part).build()
        http.call(request) { Wire.parseUpload(it.requireOk()) }
    }

    private suspend fun <T> get(url: String, parse: (String) -> T): T =
        http.call(Request.Builder().url(url).get().build()) { parse(it.requireOk()) }

    private fun Response.requireOk(): String {
        val text = body.string()
        if (code != 200) throw HostException(code, "HTTP $code")
        return text
    }

    private suspend inline fun <T> attempt(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: IOException) {
        Result.failure(e)
    } catch (e: IllegalArgumentException) {
        Result.failure(e)
    } catch (e: kotlinx.serialization.SerializationException) {
        Result.failure(e)
    }

    @Serializable
    private data class InboxReply(val items: List<InboxItem>)

    /** [body] with another content type: the caller knows the file's MIME type, the stream does not. */
    private class WithType(private val body: RequestBody, private val type: MediaType?) : RequestBody() {
        override fun contentType() = type ?: body.contentType()
        override fun contentLength() = body.contentLength()
        override fun isOneShot() = body.isOneShot()
        override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
