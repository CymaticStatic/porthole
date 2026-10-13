package ai.porthole.app.events

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network

/** A new default network (Wi-Fi to mobile, back from a tunnel) makes every waiting reconnect try now (SPEC 4.13). */
class NetworkWatcher(context: Context, private val onNetworkAvailable: () -> Unit) {
    constructor(context: Context, hub: ConnectionHub) : this(context, hub::nudge)

    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var registered: ConnectivityManager.NetworkCallback? = null

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            onNetworkAvailable()
        }
    }

    @Synchronized
    fun start() {
        if (registered != null) return
        connectivity.registerDefaultNetworkCallback(callback)
        registered = callback
    }

    @Synchronized
    fun stop() {
        val active = registered ?: return
        registered = null
        connectivity.unregisterNetworkCallback(active)
    }
}
