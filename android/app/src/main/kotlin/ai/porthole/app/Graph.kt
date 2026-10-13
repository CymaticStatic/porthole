package ai.porthole.app

import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * The hand-made dependency holder (no DI library). `PortholeApp.onCreate` calls [init]; every component reads what it
 * needs from here.
 *
 * Tests call [init] again with fakes (every part is a parameter) or [reset]; [init] replaces everything, including
 * the objects registered with [once], and cancels the previous [appScope].
 *
 * Objects that belong to later parts of the app (the connection hub, the notifier, the recorder, ...) are not named
 * here: they register themselves with [once], so the first caller creates the shared instance and every later caller
 * gets the same one.
 */
object Graph {
    private class Parts(
        val context: Context,
        val http: Http,
        val host: HostClient,
        val machines: MachineStore,
        val scope: CoroutineScope,
    )

    private val shared = HashMap<Class<*>, Any>()

    @Volatile
    private var parts: Parts? = null

    @Synchronized
    fun init(
        context: Context,
        http: Http = Http.create(),
        host: HostClient = HostClient(http),
        machines: MachineStore = MachineStore(context),
        scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    ) {
        reset()
        parts = Parts(context.applicationContext, http, host, machines, scope)
    }

    /** Forgets every part and cancels [appScope]; [init] must run again before the next use. */
    @Synchronized
    fun reset() {
        parts?.scope?.cancel()
        parts = null
        shared.clear()
    }

    val context: Context get() = need().context
    val http: Http get() = need().http
    val host: HostClient get() = need().host
    val machines: MachineStore get() = need().machines

    /** The scope for work that lives as long as the process (sockets, relays); cancelled by [reset]. */
    val appScope: CoroutineScope get() = need().scope

    /** The one instance of [type]: [create] runs on the first call only (until [reset]). */
    @Synchronized
    fun <T : Any> once(type: Class<T>, create: () -> T): T {
        need()
        @Suppress("UNCHECKED_CAST")
        return shared.getOrPut(type, create) as T
    }

    inline fun <reified T : Any> once(noinline create: () -> T): T = once(T::class.java, create)

    /** Tests only: makes [instance] the shared [type] instead of whatever [once] would create. */
    @Synchronized
    fun <T : Any> provide(type: Class<T>, instance: T) {
        need()
        shared[type] = instance
    }

    private fun need(): Parts = checkNotNull(parts) { "Graph.init has not run" }
}
