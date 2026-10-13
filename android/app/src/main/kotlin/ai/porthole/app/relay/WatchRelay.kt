package ai.porthole.app.relay

import ai.porthole.app.Graph
import ai.porthole.app.MachineStore
import ai.porthole.app.events.ConnectionHub
import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Scheduler
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.Usage
import ai.porthole.shared.WatchRules
import ai.porthole.shared.WatchState
import android.content.Context
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps the watch's `/porthole/state` DataItem current (design decision 11). It wakes on every inbox change, every
 * configured-machine change, every [USAGE_POLL_MS] and on [refresh]; each wake does nothing unless
 * [WearMessages.connectedWatchNodes] is non-empty, so a phone without a watch makes no usage requests. Usage is read
 * again on the poll and on [refresh] only. The state is written when [RelayLogic.shouldPush] says the watch would see
 * a difference, when [refresh] forces it, or when the last write is [HEARTBEAT_MS] old (the watch shows "Updated N
 * min ago" once the state is 15 minutes old, which would be wrong for a quiet but connected phone).
 */
class WatchRelay(
    ctx: Context,
    private val inbox: StateFlow<Map<String, List<InboxItem>>>,
    private val host: HostClient,
    private val machines: MachineStore,
    private val wear: WearMessages = PlayWearMessages(ctx),
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    constructor(
        ctx: Context,
        hub: ConnectionHub,
        host: HostClient,
        machines: MachineStore,
        wear: WearMessages = PlayWearMessages(ctx),
        scope: CoroutineScope,
    ) : this(ctx, hub.inbox, host, machines, wear, scope)

    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val usageDue = AtomicBoolean(true)
    private val forceNext = AtomicBoolean(false)
    private val usage = ConcurrentHashMap<Machine, Usage>()
    private var job: Job? = null

    @Volatile
    private var lastPushed: WatchState? = null

    /** Starts observing; calling it while running does nothing. */
    @Synchronized
    fun start() {
        if (job != null) return
        lastPushed = null
        job = scope.launch {
            launch { combine(inbox, machines.machines) { _, _ -> }.collect { wake.trySend(Unit) } }
            launch {
                while (true) {
                    Scheduler.pause(USAGE_POLL_MS)
                    usageDue.set(true)
                    wake.trySend(Unit)
                }
            }
            for (ignored in wake) sync()
        }
    }

    /** Stops observing; [start] begins again from scratch (the next sync pushes whatever the state is). */
    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
        lastPushed = null
        usageDue.set(true)
        forceNext.set(false)
        usage.clear()
    }

    /** The watch asked for fresh data: reads usage and writes the state now, changed or not. No-op while stopped. */
    @Synchronized
    fun refresh() {
        if (job == null) return
        usageDue.set(true)
        forceNext.set(true)
        wake.trySend(Unit)
    }

    private suspend fun sync() {
        val nodes = try {
            wear.connectedWatchNodes()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not list watches", e)
            emptyList()
        }
        if (nodes.isEmpty()) return // flags stay set: the next wake with a watch does the work

        val configured = machines.machines.value
        val forced = forceNext.getAndSet(false)
        if (usageDue.getAndSet(false)) refreshUsage(configured)

        val inboxes = configured.mapNotNull { m -> inbox.value[m.origin]?.let { m to it } }.toMap()
        val next = WatchRules.build(now(), inboxes, usage.filterKeys { it in configured })
        val prev = lastPushed
        val heartbeat = prev != null && next.updatedAt - prev.updatedAt >= HEARTBEAT_MS
        if (!forced && !heartbeat && !RelayLogic.shouldPush(prev, next)) return
        try {
            wear.putState(next.encode())
            lastPushed = next
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Could not write the watch state", e)
        }
    }

    /** A machine whose usage call fails keeps its last windows; a removed machine's windows go. */
    private suspend fun refreshUsage(configured: List<Machine>) {
        val fetched = coroutineScope { configured.map { m -> async { m to host.usage(m) } }.awaitAll() }
        usage.keys.retainAll(configured.toSet())
        for ((machine, result) in fetched) result.onSuccess { usage[machine] = it }
    }

    companion object {
        const val USAGE_POLL_MS = 5 * 60_000L
        const val HEARTBEAT_MS = 10 * 60_000L
        private const val TAG = "WatchRelay"

        /** The relay [ai.porthole.app.events.EventsService] runs and [RelayListenerService] refreshes. */
        fun shared(): WatchRelay = Graph.once {
            WatchRelay(Graph.context, ConnectionHub.shared(), Graph.host, Graph.machines, PlayWearMessages(Graph.context), Graph.appScope)
        }
    }
}
