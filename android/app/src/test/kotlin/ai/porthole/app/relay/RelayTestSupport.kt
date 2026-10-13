package ai.porthole.app.relay

import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Question
import java.io.IOException
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.Dispatcher
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer

internal const val DESK_ORIGIN = "https://desk.example.ts.net"

/** OkHttp runs every call on the caller's thread, so a coroutine test needs no waiting for another thread. */
private object DirectExecutorService : AbstractExecutorService() {
    override fun execute(command: Runnable) = command.run()
    override fun shutdown() = Unit
    override fun shutdownNow(): MutableList<Runnable> = mutableListOf()
    override fun isShutdown() = false
    override fun isTerminated() = false
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = true
}

/** A real [HostClient] whose requests never leave the process: [respond] answers them, [seen] records them. */
internal class FakeHostd {
    class Seen(val method: String, val url: String, val body: String)

    val seen = CopyOnWriteArrayList<Seen>()

    /** The status and body for a request; throw [IOException] to fail the call like a dead network. */
    @Volatile
    var respond: (Seen) -> Pair<Int, String> = { 200 to "{}" }

    val client = HostClient(
        Http(
            OkHttpClient.Builder()
                .dispatcher(Dispatcher(DirectExecutorService))
                .addInterceptor(
                    Interceptor { chain ->
                        val request = chain.request()
                        val body = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }.orEmpty()
                        val entry = Seen(request.method, request.url.toString(), body)
                        seen += entry
                        val (code, text) = respond(entry)
                        Response.Builder()
                            .request(request)
                            .protocol(Protocol.HTTP_1_1)
                            .code(code)
                            .message("fake")
                            .body(text.toResponseBody("application/json".toMediaType()))
                            .build()
                    },
                )
                .build(),
        ),
    )

    fun requestsTo(suffix: String) = seen.filter { it.url.endsWith(suffix) }
}

internal class FakeWear : WearMessages {
    class Reply(val nodeId: String, val path: String, val bytes: ByteArray)

    @Volatile
    var nodes: List<String> = listOf("watch-1")

    @Volatile
    var failPut = false

    @Volatile
    var failReply = false

    val puts = CopyOnWriteArrayList<ByteArray>()
    val replies = CopyOnWriteArrayList<Reply>()

    override suspend fun connectedWatchNodes(): List<String> = nodes

    override suspend fun putState(bytes: ByteArray) {
        if (failPut) throw IOException("no Play services")
        puts += bytes
    }

    override suspend fun reply(nodeId: String, path: String, bytes: ByteArray) {
        if (failReply) throw IOException("watch gone")
        replies += Reply(nodeId, path, bytes)
    }
}

internal fun needsYou(
    id: String,
    updatedAt: Long = 5,
    options: List<String> = listOf("Yes", "No"),
    column: String = "needs-you",
) = InboxItem(
    id = id,
    key = id,
    sessionId = "tmux:s:$id",
    machine = "desk",
    project = "proj",
    kind = "question",
    column = column,
    title = "Title of $id",
    body = "Body",
    question = Question("q-$id", 1, "Proceed with $id?", options, multi = false, count = 1, open = true),
    createdAt = 1,
    updatedAt = updatedAt,
)
