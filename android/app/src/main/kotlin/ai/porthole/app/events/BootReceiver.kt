package ai.porthole.app.events

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts [EventsService] after the phone boots or the app is updated, so the sockets are open without opening the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            BootPolicy.startFromBoot(context)
        }
    }
}

/**
 * The one place that decides how the service starts from a broadcast. That the `remoteMessaging` type may be started
 * from `BOOT_COMPLETED` is G-6 in the plan (checked in T0, proved on the phone in E2 step 4h).
 */
object BootPolicy {
    fun startFromBoot(context: Context) {
        EventsService.start(context)
    }
}
