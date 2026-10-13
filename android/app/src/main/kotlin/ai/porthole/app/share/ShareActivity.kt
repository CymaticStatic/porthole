package ai.porthole.app.share

import ai.porthole.app.Graph
import ai.porthole.app.Intents
import ai.porthole.shared.Machine
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** One uploaded file, as the page's `share` bridge event carries it: `{path, name, machine, origin}`. */
@Serializable
data class ShareEvent(val path: String, val name: String, val machine: String, val origin: String)

/** Where `MainActivity` sends the `share` events it takes from [ShareHandoff] (C1 fills this with its event outbox). */
fun interface ShareSink {
    fun share(events: List<ShareEvent>)
}

/**
 * The hand-off between [ShareActivity] and `MainActivity`: the share activity [put]s the events and starts
 * `MainActivity`; `MainActivity` [take]s them once it exists and emits them through its outbox (or [drainTo] a sink).
 * A process-wide object because the two activities share nothing else, and the page that must receive the events is
 * not loaded yet when `ShareActivity` finishes.
 */
object ShareHandoff {
    @Volatile
    var pending: List<ShareEvent> = emptyList()

    /** Adds [events] behind any that nobody has taken yet (two shares in a row must not lose the first). */
    @Synchronized
    fun put(events: List<ShareEvent>) {
        pending = pending + events
    }

    /** Returns everything waiting and clears it. */
    @Synchronized
    fun take(): List<ShareEvent> {
        val events = pending
        pending = emptyList()
        return events
    }

    /** [take]s and passes the events to [sink]; does nothing when none are waiting. */
    fun drainTo(sink: ShareSink) {
        val events = take()
        if (events.isNotEmpty()) sink.share(events)
    }
}

/**
 * The share-sheet target (design decision 6): asks which machine when there is more than one, uploads what was shared
 * to that machine's `/v1/uploads`, then opens `MainActivity` on it with the `share` events waiting in [ShareHandoff].
 */
class ShareActivity : ComponentActivity() {
    private var dialog: AlertDialog? = null
    private var upload: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreated activity (rotation) would start the same share twice, so the share is dropped instead.
        if (savedInstanceState != null) return finish()
        val uris = ShareIntents.uris(intent)
        val text = if (uris.isEmpty()) ShareIntents.text(intent) else null
        if (uris.isEmpty() && text == null) return quit("Nothing to share")
        val machines = Graph.machines.machines.value
        when (machines.size) {
            0 -> quit("Add a machine in Porthole first")
            1 -> send(machines.single(), uris, text)
            else -> choose(machines) { send(it, uris, text) }
        }
    }

    override fun onDestroy() {
        dialog?.dismiss()
        dialog = null
        super.onDestroy()
    }

    private fun choose(machines: List<Machine>, then: (Machine) -> Unit) {
        dialog = AlertDialog.Builder(this)
            .setTitle("Share to")
            .setItems(machines.map { it.name }.toTypedArray()) { _, which -> then(machines[which]) }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun send(machine: Machine, uris: List<android.net.Uri>, text: String?) {
        dialog = AlertDialog.Builder(this)
            .setMessage("Sending to ${machine.name}…")
            .setCancelable(false)
            .setNegativeButton("Cancel") { _, _ ->
                upload?.cancel()
                finish()
            }
            .show()
        val uploads = Graph.once<Uploads> { Uploads(Graph.host) }
        upload = lifecycleScope.launch {
            val result = uploads.shareAll(machine, uris, text, contentResolver)
            result.failure?.let { toast(failureText(it)) }
            if (result.events.isEmpty()) return@launch finish()
            ShareHandoff.put(result.events)
            startActivity(mainIntent(this@ShareActivity, machine.origin))
            finish()
        }
    }

    private fun quit(message: String) {
        toast(message)
        finish()
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun failureText(e: Throwable): String =
        if (e is TooLarge) e.message.orEmpty() else "Couldn't send: ${e.message ?: e.javaClass.simpleName}"

    companion object {
        /** `MainActivity` belongs to the web package, which is written separately, so it is named, not referenced. */
        const val MAIN_ACTIVITY = "ai.porthole.app.web.MainActivity"

        /** Opens `MainActivity` on [origin] with the share flag; the events themselves wait in [ShareHandoff]. */
        fun mainIntent(context: Context, origin: String): Intent =
            Intent()
                .setClassName(context.packageName, MAIN_ACTIVITY)
                .putExtra(Intents.EXTRA_SHARE, true)
                .putExtra(Intents.EXTRA_ORIGIN, origin)
    }
}
