package ai.porthole.app.events

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.shared.NotifyPlan
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.launch

/**
 * An answer button on a notification. `goAsync()` work may run about 30 s before Android kills the receiver
 * [INFERENCE], so the request gets 20 s ([TIMEOUT_MS]); [AnswerHandler] turns a timeout into a "Couldn't send" notice.
 */
class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intents.ACTION_ANSWER) return
        val origin = intent.getStringExtra(Intents.EXTRA_ORIGIN) ?: return
        val itemId = intent.getStringExtra(Intents.EXTRA_ITEM) ?: return
        val index = intent.getIntExtra(Intents.EXTRA_INDEX, -1)
        if (index < 0) return
        val machine = Graph.machines.machines.value.firstOrNull { it.origin == origin }
        if (machine == null) {
            Notifier.shared().cancel(origin, itemId) // the machine was removed after the notification was posted
            return
        }
        val label = intent.getStringExtra(Intents.EXTRA_LABEL).orEmpty()
        val plan = NotifyPlan(
            tag = origin,
            id = itemId.hashCode(),
            title = intent.getStringExtra(Notifier.EXTRA_TITLE).orEmpty(),
            body = intent.getStringExtra(Notifier.EXTRA_BODY).orEmpty(),
            subText = intent.getStringExtra(Notifier.EXTRA_SUBTEXT) ?: machine.name,
            answers = emptyList(),
            itemId = itemId,
            notifyId = intent.getLongExtra(Intents.EXTRA_NOTIFY_ID, 0),
        )
        val pending = goAsync()
        val handler = AnswerHandler.shared()
        Graph.appScope.launch {
            try {
                handler.answerWithin(TIMEOUT_MS, machine, itemId, index, label, plan)
            } finally {
                pending?.finish()
            }
        }
    }

    companion object {
        const val TIMEOUT_MS = 20_000L
    }
}
