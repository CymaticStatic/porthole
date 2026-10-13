package ai.porthole.app.net

import ai.porthole.shared.Backoff
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.Routes
import ai.porthole.shared.ServerEvent
import ai.porthole.shared.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Whether the socket to one machine is open right now. */
enum class Online { CONNECTED, DISCONNECTED }

/**
 * One reconnecting `WS /v1/events` connection to one machine.
 *
 * Everything the caller sees ([onEvent], [onState], the [ledger]) happens on [scope]'s dispatcher, one message at a
 * time, never on an OkHttp thread. After [onEvent] returns for a `notify`, the socket sends the `ack` (a notify the
 * ledger already knew gets the same treatment, so a lost ack is repaired) and marks it acked in the [ledger]. Acks
 * that are still open are re-sent first on every (re)connect, and `since` is the ledger's highest shown id.
 *
 * [urlFor] only differs from the default in tests, where the server has no TLS.
 */
class EventsSocket(
    private val http: Http,
    private val machine: Machine,
    private val device: String,
    private val ledger: NotifyLedger,
    private val scope: CoroutineScope,
    private val onEvent: (ServerEvent) -> Unit,
    private val onState: (Online) -> Unit,
    private val urlFor: (since: Long) -> String = { since -> Routes.events(machine.origin, device, since) },
) {
    private sealed interface Frame {
        data object Open : Frame
        data class Text(val text: String) : Frame
        data object End : Frame
    }

    private val lock = Any()
    private val backoff = Backoff()
    private var job: Job? = null
    private var waitJob: Job? = null
    private var socket: WebSocket? = null

    @Volatile
    private var state = Online.DISCONNECTED

    fun start() {
        synchronized(lock) {
            if (job?.isActive == true) return
            job = scope.launch { run() }
        }
    }

    fun stop() {
        val running: Job?
        val open: WebSocket?
        synchronized(lock) {
            running = job
            job = null
            open = socket
            socket = null
        }
        running?.cancel()
        open?.cancel()
        setState(Online.DISCONNECTED)
    }

    /** Android reports a network change (SPEC 4.13): if a reconnect is waiting, stop waiting and retry now. */
    fun nudge() {
        synchronized(lock) {
            val waiting = waitJob ?: return
            backoff.nudge()
            waiting.cancel()
        }
    }

    private suspend fun run() {
        try {
            while (true) {
                session()
                setState(Online.DISCONNECTED)
                val delayMs = synchronized(lock) { backoff.nextDelayMs() }
                coroutineScope {
                    val sleeper = launch { Scheduler.pause(delayMs) }
                    synchronized(lock) { waitJob = sleeper }
                    try {
                        sleeper.join()
                    } finally {
                        synchronized(lock) { waitJob = null }
                    }
                }
            }
        } finally {
            setState(Online.DISCONNECTED)
        }
    }

    /** Opens one connection and returns when it has ended, for whatever reason. */
    private suspend fun session() {
        val frames = Channel<Frame>(Channel.UNLIMITED)
        val request = Request.Builder().url(urlFor(ledger.since())).build()
        val ws = http.client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    frames.trySend(Frame.Open)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    frames.trySend(Frame.Text(text))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    frames.trySend(Frame.End)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    frames.trySend(Frame.End)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    frames.trySend(Frame.End)
                }
            },
        )
        synchronized(lock) { socket = ws }
        try {
            for (frame in frames) {
                when (frame) {
                    Frame.Open -> {
                        setState(Online.CONNECTED)
                        for (id in ledger.pendingAcks()) ack(ws, id)
                    }
                    is Frame.Text -> {
                        synchronized(lock) { backoff.reset() }
                        handle(ws, frame.text)
                    }
                    Frame.End -> return
                }
            }
        } finally {
            ws.cancel()
            synchronized(lock) { if (socket === ws) socket = null }
            frames.close()
        }
    }

    private fun handle(ws: WebSocket, text: String) {
        val event = try {
            Wire.parseEvent(text)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return // malformed: drop the message, keep the socket
        }
        if (event is ServerEvent.Unknown) return
        try {
            onEvent(event)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return // the consumer failed: no ack, so hostd offers a notify again on the next connect
        }
        if (event is ServerEvent.Notify) ack(ws, event.id)
    }

    private fun ack(ws: WebSocket, id: Long) {
        if (ws.send(Wire.ack(id))) ledger.markAcked(id)
    }

    private fun setState(next: Online) {
        val changed = synchronized(lock) {
            if (state == next) false else {
                state = next
                true
            }
        }
        if (changed) onState(next)
    }
}
