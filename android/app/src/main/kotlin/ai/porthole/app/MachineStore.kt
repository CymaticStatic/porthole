package ai.porthole.app

import ai.porthole.shared.Machine
import ai.porthole.shared.MachineInfo
import ai.porthole.shared.MachineList
import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The configured machines, kept as `MachineList.encode` text in `SharedPreferences("machines")`, plus the phone's own
 * device name per machine (design decision 9). The list rules (names, origins, duplicates) live in [MachineList];
 * this class only persists the result and tells observers.
 */
class MachineStore(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("machines", Context.MODE_PRIVATE)
    private val deviceNames = app.getSharedPreferences("machine_devices", Context.MODE_PRIVATE)
    private val lock = Any()
    private val state = MutableStateFlow(load())

    /** The current list; the two default machines until the user changes it. */
    val machines: StateFlow<List<Machine>> = state

    fun add(name: String, originInput: String): Result<List<Machine>> =
        update { MachineList.add(it, name, originInput) }

    fun rename(oldName: String, newName: String): Result<List<Machine>> =
        update { MachineList.rename(it, oldName, newName) }

    fun remove(name: String) {
        synchronized(lock) {
            val removed = state.value.firstOrNull { it.name == name } ?: return
            save(MachineList.remove(state.value, name))
            deviceNames.edit().remove(removed.origin).apply()
        }
    }

    /**
     * The `device` this phone uses on [machine]'s events socket: `you.device` from `GET /v1/machine`, fetched with
     * [fetch] once and then kept (until [testConnection] finds a new name). When the machine cannot be reached or
     * reports no device, [FALLBACK_DEVICE] is returned and nothing is stored, so the next call asks again.
     */
    suspend fun device(machine: Machine, fetch: suspend (Machine) -> Result<MachineInfo>): String {
        deviceNames.getString(machine.origin, null)?.let { return it }
        val device = fetch(machine).getOrNull()?.you?.device?.takeIf { it.isNotBlank() } ?: return FALLBACK_DEVICE
        deviceNames.edit().putString(machine.origin, device).apply()
        return device
    }

    /**
     * The settings screen's "Test connection": always asks [fetch] (never the kept name) and, when the machine answers
     * with a device name, keeps it in place of the old one, so a device renamed in Tailscale shows its new name. A
     * failed fetch or an answer with no device leaves the kept name alone.
     */
    suspend fun testConnection(machine: Machine, fetch: suspend (Machine) -> Result<MachineInfo>): Result<MachineInfo> =
        fetch(machine).onSuccess { info ->
            info.you?.device?.takeIf { it.isNotBlank() }?.let { deviceNames.edit().putString(machine.origin, it).apply() }
        }

    private fun update(change: (List<Machine>) -> Result<List<Machine>>): Result<List<Machine>> =
        synchronized(lock) {
            change(state.value).onSuccess { save(it) }
        }

    private fun save(list: List<Machine>) {
        prefs.edit().putString(KEY_LIST, MachineList.encode(list)).apply()
        state.value = list
    }

    private fun load(): List<Machine> =
        prefs.getString(KEY_LIST, null)?.let { MachineList.decode(it) } ?: MachineList.defaults

    companion object {
        /** Tailscale node name of Ben's phone (SPEC 3), used until `/v1/machine` has told us the real one. */
        const val FALLBACK_DEVICE = "bencell"
        private const val KEY_LIST = "list"
    }
}
