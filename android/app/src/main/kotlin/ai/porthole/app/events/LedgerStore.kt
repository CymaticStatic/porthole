package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.shared.LedgerState
import ai.porthole.shared.NotifyLedger
import ai.porthole.shared.Wire
import android.content.Context

/**
 * Keeps one [NotifyLedger] per machine origin and persists its [LedgerState] as JSON in `SharedPreferences("ledger")`
 * (design decision 8). [ledger] always returns the same object for an origin, so the socket and the notify flow
 * share it; whoever changes it calls [save] afterwards.
 */
class LedgerStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("ledger", Context.MODE_PRIVATE)
    private val ledgers = HashMap<String, NotifyLedger>()

    @Synchronized
    fun ledger(origin: String): NotifyLedger = ledgers.getOrPut(origin) { NotifyLedger(load(origin)) }

    /** Writes the current state of [origin]'s ledger; does nothing when [ledger] was never asked for it. */
    @Synchronized
    fun save(origin: String) {
        val ledger = ledgers[origin] ?: return
        prefs.edit().putString(origin, Wire.json.encodeToString(LedgerState.serializer(), ledger.state)).apply()
    }

    /** Drops the ledger of a machine that was removed. */
    @Synchronized
    fun forget(origin: String) {
        ledgers.remove(origin)
        prefs.edit().remove(origin).apply()
    }

    private fun load(origin: String): LedgerState {
        val text = prefs.getString(origin, null) ?: return LedgerState()
        return runCatching { Wire.json.decodeFromString(LedgerState.serializer(), text) }.getOrDefault(LedgerState())
    }

    companion object {
        fun shared(): LedgerStore = Graph.once { LedgerStore(Graph.context) }
    }
}
