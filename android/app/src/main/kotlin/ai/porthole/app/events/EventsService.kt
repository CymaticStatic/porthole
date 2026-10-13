package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.net.Online
import ai.porthole.app.relay.WatchRelay
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The always-on foreground service (type `remoteMessaging`, design decision 1): it keeps [ConnectionHub]'s sockets
 * open and shows the `connection` notification. It ends only when the user turns "Stay connected in the background"
 * off ([setStayConnected]); while that is off [start] does nothing.
 */
class EventsService : LifecycleService() {
    private val hub: ConnectionHub get() = ConnectionHub.shared()
    private var networkWatcher: NetworkWatcher? = null
    private var observing = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val notifier = Notifier.shared()
        val machines = Graph.machines
        startForeground(
            Notifier.CONNECTION_ID,
            notifier.connection(text(hub.online.value, machines.machines.value.size)),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        hub.start()
        WatchRelay.shared().start()
        if (networkWatcher == null) networkWatcher = NetworkWatcher(this, hub).also { it.start() }
        if (!observing) {
            observing = true
            lifecycleScope.launch {
                combine(hub.online, machines.machines) { online, configured -> text(online, configured.size) }
                    .collect { notifier.updateConnection(it) }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        networkWatcher?.stop()
        networkWatcher = null
        WatchRelay.shared().stop()
        hub.stop()
        super.onDestroy()
    }

    private fun text(online: Map<String, Online>, configured: Int) =
        Notifier.connectionText(this, online.values.count { it == Online.CONNECTED }, configured)

    companion object {
        /**
         * Starts the service from the foreground app or from a boot broadcast, unless the user switched "Stay
         * connected in the background" off: then nothing starts it.
         */
        fun start(context: Context) {
            if (!BackgroundPref(context).enabled) return
            context.startForegroundService(Intent(context, EventsService::class.java))
        }

        /** Ends the service. */
        fun stop(context: Context) {
            context.stopService(Intent(context, EventsService::class.java))
        }

        /** The settings switch: saves the choice, then starts the service (on) or stops it and keeps it stopped (off). */
        fun setStayConnected(context: Context, on: Boolean) {
            BackgroundPref(context).enabled = on
            if (on) start(context) else stop(context)
        }
    }
}
