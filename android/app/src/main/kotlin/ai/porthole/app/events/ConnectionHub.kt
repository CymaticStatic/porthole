package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.MachineStore
import ai.porthole.app.net.EventsSocket
import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.app.net.Online
import ai.porthole.shared.InboxItem
import ai.porthole.shared.Machine
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.ServerEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Builds the socket for one machine; only tests replace it (their server has no TLS). */
typealias SocketFactory = (
    machine: Machine,
    device: String,
    ledger: NotifyLedger,
    scope: CoroutineScope,
    onEvent: (ServerEvent) -> Unit,
    onState: (Online) -> Unit,
) -> EventsSocket

/**
 * Owns one [EventsSocket] per configured machine: [start] follows [MachineStore.machines], opening a socket for each
 * machine and closing the ones of removed (or renamed) machines. Both flows are keyed by machine origin and only hold
 * machines that currently have a socket.
 */
class ConnectionHub(
    private val machines: MachineStore,
    private val host: HostClient,
    private val ledgers: LedgerStore,
    private val notifier: Notifier,
    private val scope: CoroutineScope,
    private val socketFor: SocketFactory,
) {
    private class Entry(val machine: Machine) {
        var setup: Job? = null
        var socket: EventsSocket? = null
    }

    private val lock = Any()
    private val entries = HashMap<String, Entry>()
    private var watcher: Job? = null

    private val onlineState = MutableStateFlow<Map<String, Online>>(emptyMap())
    private val inboxState = MutableStateFlow<Map<String, List<InboxItem>>>(emptyMap())

    /** Whether each machine's socket is open, by origin. */
    val online: StateFlow<Map<String, Online>> = onlineState.asStateFlow()

    /** The newest `inbox` message of each machine, by origin. */
    val inbox: StateFlow<Map<String, List<InboxItem>>> = inboxState.asStateFlow()

    fun start() {
        synchronized(lock) {
            if (watcher != null) return
            watcher = scope.launch { machines.machines.collect { sync(it) } }
        }
    }

    /** Closes every socket and forgets the machines; [start] opens them again. */
    fun stop() {
        synchronized(lock) {
            watcher?.cancel()
            watcher = null
            for (origin in entries.keys.toList()) close(origin)
        }
    }

    /** A network change: every machine that is waiting to reconnect tries now. */
    fun nudge() {
        val open = synchronized(lock) { entries.values.mapNotNull { it.socket } }
        for (socket in open) socket.nudge()
    }

    private fun sync(configured: List<Machine>) {
        synchronized(lock) {
            val wanted = configured.associateBy { it.origin }
            for ((origin, entry) in entries.toList()) {
                val now = wanted[origin]
                if (now == entry.machine) continue
                close(origin)
                if (now == null) ledgers.forget(origin) // removed, not just renamed
            }
            for (machine in wanted.values) {
                if (machine.origin !in entries) open(machine)
            }
        }
    }

    private fun open(machine: Machine) {
        val origin = machine.origin
        val entry = Entry(machine)
        entries[origin] = entry
        onlineState.update { it + (origin to Online.DISCONNECTED) }
        val ledger = ledgers.ledger(origin)
        val flow = NotifyFlow(ledger, notifier, machine) { ledgers.save(origin) }
        entry.setup = scope.launch {
            val device = machines.device(machine) { host.machine(it) }
            val socket = socketFor(
                machine,
                device,
                ledger,
                scope,
                { event -> onEvent(origin, flow, event) },
                { state ->
                    onlineState.update { it + (origin to state) }
                    ledgers.save(origin) // picks up acks, which the socket records after onEvent returns
                },
            )
            synchronized(lock) {
                if (entries[origin] !== entry) return@launch
                entry.socket = socket
                socket.start()
            }
        }
    }

    private fun close(origin: String) {
        val entry = entries.remove(origin) ?: return
        entry.setup?.cancel()
        entry.socket?.stop()
        ledgers.save(origin)
        onlineState.update { it - origin }
        inboxState.update { it - origin }
    }

    private fun onEvent(origin: String, flow: NotifyFlow, event: ServerEvent) {
        when (event) {
            is ServerEvent.Notify -> flow.onNotify(event)
            is ServerEvent.Inbox -> {
                flow.onInbox(event.items)
                inboxState.update { it + (origin to event.items) }
            }
            is ServerEvent.Sessions, is ServerEvent.Unknown -> Unit
        }
    }

    companion object {
        /** The hub the service runs; C1 (web shell) and C3 (watch relay) read the same object. */
        fun shared(): ConnectionHub = Graph.once {
            val http: Http = Graph.http
            ConnectionHub(
                machines = Graph.machines,
                host = Graph.host,
                ledgers = LedgerStore.shared(),
                notifier = Notifier.shared(),
                scope = Graph.appScope,
                socketFor = { machine, device, ledger, scope, onEvent, onState ->
                    EventsSocket(http, machine, device, ledger, scope, onEvent, onState)
                },
            )
        }
    }
}
