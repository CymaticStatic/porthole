package ai.porthole.app.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * The one OkHttp client of the app. Tailscale identity is the only authentication, so the only headers native code
 * adds are `X-Porthole: 1` and `Origin` (SPEC 4.16, 5.4); there is no cookie jar and no `Authorization`.
 */
class Http(val client: OkHttpClient) {
    /**
     * Runs [request] and turns the response into a value on OkHttp's own thread (the body is read and closed inside
     * [read]). Throws the [IOException] of a failed call; cancelling the coroutine cancels the call.
     */
    suspend fun <T> call(request: Request, read: (Response) -> T): T = suspendCancellableCoroutine { cont ->
        val call = client.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                val value = try {
                    response.use(read)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    if (cont.isActive) cont.resumeWithException(e)
                    return
                }
                if (cont.isActive) cont.resume(value)
            }
        })
    }

    companion object {
        fun create(): Http = Http(
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .pingInterval(25, TimeUnit.SECONDS)
                .cookieJar(CookieJar.NO_COOKIES)
                .addInterceptor(PortholeHeaders)
                .build(),
        )

        /** `scheme://host[:port]` of [url] with the port left out when it is the scheme's default. */
        fun originOf(url: HttpUrl): String {
            val defaultPort = HttpUrl.defaultPort(url.scheme)
            return url.scheme + "://" + url.host + if (url.port == defaultPort) "" else ":" + url.port
        }
    }
}

/** Adds `X-Porthole: 1` and `Origin` to every request, including the WebSocket upgrade (OkHttp sees `wss` as `https`). */
internal object PortholeHeaders : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        return chain.proceed(
            request.newBuilder()
                .header("X-Porthole", "1")
                .header("Origin", Http.originOf(request.url))
                .build(),
        )
    }
}

/** hostd answered with a status the call did not expect. */
class HostException(val code: Int, message: String) : IOException(message)
