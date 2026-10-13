package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.app.R
import ai.porthole.shared.InboxItem
import ai.porthole.shared.NotifyPlan
import ai.porthole.shared.Routes
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat

/**
 * Every notification the app posts (design decision 7). Channel `needs-you` is the only one that makes noise;
 * `connection` carries the foreground-service notice. Nothing here is `setLocalOnly`, so Wear OS bridges the
 * notifications, buttons included, to the watch.
 *
 * One notification per `(origin, itemId)`: tag = origin, id = the item's hash, so a newer one replaces the old one.
 */
class Notifier(context: Context) {
    private val ctx = context.applicationContext
    private val nm = ctx.getSystemService(NotificationManager::class.java)

    init {
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_NEEDS_YOU, ctx.getString(R.string.channel_needs_you), NotificationManager.IMPORTANCE_HIGH),
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, ctx.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_LOW),
        )
    }

    /**
     * Posts [plan]: an Open action first, then one action per `plan.answers`. [route] is the page route Open goes to
     * (see [route]).
     */
    fun show(plan: NotifyPlan, route: String) {
        val open = openIntent(plan, route)
        val builder = base(plan, plan.body, open)
        plan.answers.forEachIndexed { position, option ->
            val answer = Intent(ctx, AnswerReceiver::class.java)
                .setAction(Intents.ACTION_ANSWER)
                // The extras do not make two PendingIntents different, the data does: machines count from 1 independently.
                .setData(Uri.parse("porthole-answer://" + Routes.segment(plan.tag) + "/" + Routes.segment(plan.itemId) + "/" + plan.notifyId + "/" + position))
                .putExtra(Intents.EXTRA_ORIGIN, plan.tag)
                .putExtra(Intents.EXTRA_ITEM, plan.itemId)
                .putExtra(Intents.EXTRA_INDEX, option.index)
                .putExtra(Intents.EXTRA_LABEL, option.label)
                .putExtra(Intents.EXTRA_NOTIFY_ID, plan.notifyId)
                .putExtra(EXTRA_TITLE, plan.title)
                .putExtra(EXTRA_BODY, plan.body)
                .putExtra(EXTRA_SUBTEXT, plan.subText)
            val pending = PendingIntent.getBroadcast(
                ctx,
                (plan.notifyId * 4 + position).toInt(),
                answer,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(0, option.label, pending)
        }
        nm.notify(plan.tag, plan.id, builder.build())
    }

    /** Replaces [plan]'s notification with [text] and only the Open action; it stays until the user dismisses it. */
    fun confirm(plan: NotifyPlan, text: String, route: String) {
        val open = openIntent(plan, route)
        val extras = Bundle().apply { putBoolean(EXTRA_CONFIRMED, true) }
        nm.notify(plan.tag, plan.id, base(plan, text, open).addExtras(extras).build())
    }

    /**
     * Removes the notification of [itemId] on [origin], except a confirmation ("Sent: Yes"): that is the result of the
     * user's own tap, and the `inbox` message that follows an answer would otherwise wipe it at once.
     */
    fun cancel(origin: String, itemId: String) {
        val id = itemId.hashCode()
        val current = nm.activeNotifications.firstOrNull { it.tag == origin && it.id == id }
        if (current?.notification?.extras?.getBoolean(EXTRA_CONFIRMED) == true) return
        nm.cancel(origin, id)
    }

    /** The foreground-service notification: [text] plus the Machines and Battery actions (design decision 5). */
    fun connection(text: String): Notification {
        val content = PendingIntent.getActivity(
            ctx,
            REQUEST_CONNECTION_OPEN,
            Intent(Intent.ACTION_MAIN).setComponent(ComponentName(ctx.packageName, MAIN_ACTIVITY)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(ctx, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(text)
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, ctx.getString(R.string.shortcut_machines), activity(MACHINES_ACTIVITY, REQUEST_MACHINES))
            .addAction(0, ctx.getString(R.string.shortcut_battery), activity(BATTERY_ACTIVITY, REQUEST_BATTERY))
            .build()
    }

    /** Re-posts the foreground notification with new [text]. */
    fun updateConnection(text: String) {
        nm.notify(CONNECTION_ID, connection(text))
    }

    // The settings screens are written by another task: they are named, not referenced, so this file compiles alone.
    private fun activity(className: String, requestCode: Int): PendingIntent = PendingIntent.getActivity(
        ctx,
        requestCode,
        Intent().setComponent(ComponentName(ctx.packageName, className)),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun openIntent(plan: NotifyPlan, route: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(Routes.openLink(plan.tag, route)))
            .setComponent(ComponentName(ctx.packageName, MAIN_ACTIVITY))
        return PendingIntent.getActivity(
            ctx,
            (plan.notifyId * 4 + OPEN_SLOT).toInt(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun base(plan: NotifyPlan, text: String, open: PendingIntent): NotificationCompat.Builder =
        NotificationCompat.Builder(ctx, CHANNEL_NEEDS_YOU)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(plan.title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSubText(plan.subText)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .addAction(0, ctx.getString(R.string.action_open), open)

    companion object {
        const val CHANNEL_NEEDS_YOU = "needs-you"
        const val CHANNEL_CONNECTION = "connection"
        const val CONNECTION_ID = 1

        /** Title, body and machine name ride along on answer buttons so the result can replace the question. */
        const val EXTRA_TITLE = "ai.porthole.app.extra.TITLE"
        const val EXTRA_BODY = "ai.porthole.app.extra.BODY"
        const val EXTRA_SUBTEXT = "ai.porthole.app.extra.SUBTEXT"
        private const val EXTRA_CONFIRMED = "ai.porthole.app.extra.CONFIRMED"

        // Named, not referenced: these classes belong to other tasks (manifest names them).
        const val MAIN_ACTIVITY = "ai.porthole.app.web.MainActivity"
        const val MACHINES_ACTIVITY = "ai.porthole.app.settings.MachinesActivity"
        const val BATTERY_ACTIVITY = "ai.porthole.app.settings.BatteryGuideActivity"

        // Answer buttons use slots 0 and 1 of `notifyId * 4`; Open uses slot 2.
        private const val OPEN_SLOT = 2
        private const val REQUEST_CONNECTION_OPEN = 1
        private const val REQUEST_MACHINES = 2
        private const val REQUEST_BATTERY = 3

        /**
         * The page route Open goes to: `#/chat/<machine>/<sessionId>` when [itemId] is in [inbox] (the machine's last
         * known inbox), else `#/inbox` (the built page has no `#/inbox/<itemId>` route).
         */
        fun route(inbox: List<InboxItem>, itemId: String): String {
            val item = inbox.firstOrNull { it.id == itemId } ?: return "#/inbox"
            if (item.machine.isEmpty() || item.sessionId.isEmpty()) return "#/inbox"
            return "#/chat/" + Routes.segment(item.machine) + "/" + Routes.segment(item.sessionId)
        }

        /**
         * The text of the foreground notice: "Porthole is connected: 2 machines" ([connected] sockets open out of
         * [configured] machines), the reconnecting notice when none is open, "no machines" for an empty list.
         */
        fun connectionText(ctx: Context, connected: Int, configured: Int): String = when {
            configured == 0 -> ctx.getString(R.string.fgs_connected) + ": no machines"
            connected == 0 -> ctx.getString(R.string.fgs_connecting)
            connected == 1 -> ctx.getString(R.string.fgs_connected) + ": 1 machine"
            else -> ctx.getString(R.string.fgs_connected) + ": $connected machines"
        }

        fun shared(): Notifier = Graph.once { Notifier(Graph.context) }
    }
}
