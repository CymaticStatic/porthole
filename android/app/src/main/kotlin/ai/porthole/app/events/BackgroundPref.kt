package ai.porthole.app.events

import android.content.Context

/**
 * "Stay connected in the background": whether [EventsService] may run at all. On by default. While it is off nothing
 * starts the service (the app opening, the boot broadcast), because [EventsService.start] checks it; the
 * [NetworkWatcher] only exists inside the running service, so it is gone with it.
 */
class BackgroundPref(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("background", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_STAY_CONNECTED, true)
        set(value) {
            prefs.edit().putBoolean(KEY_STAY_CONNECTED, value).apply()
        }

    private companion object {
        const val KEY_STAY_CONNECTED = "stay_connected"
    }
}
