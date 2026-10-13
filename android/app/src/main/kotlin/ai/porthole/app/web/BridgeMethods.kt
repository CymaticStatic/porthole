package ai.porthole.app.web

import ai.porthole.app.Graph
import ai.porthole.app.settings.BatteryGuideActivity
import ai.porthole.app.settings.MachinesActivity
import ai.porthole.app.share.PickedFile
import ai.porthole.app.voice.AndroidAudioFocus
import ai.porthole.app.voice.AndroidTts
import ai.porthole.app.voice.AudioRecordMic
import ai.porthole.app.voice.LastRecording
import ai.porthole.app.voice.Recorder
import ai.porthole.app.voice.Recording
import ai.porthole.app.voice.RecordingReason
import ai.porthole.app.voice.Speaker
import ai.porthole.shared.BridgeProtocol
import ai.porthole.shared.Machine
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.Settings
import java.io.File
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What goes back to the page: the JSON [text] and [onPosted], which the caller runs once [text] has really been posted
 * (a `stopRecording` reply deletes its recording only then, so a reply that never arrived can be asked for again).
 */
class Reply(val text: String, val onPosted: () -> Unit = {})

/**
 * The eight bridge methods the page can call (design decision 6; the page's own list is `ALLOWED` in
 * `web/src/net/bridge.js`). A call must come from the main thread: it opens pickers and starts activities.
 *
 * Everything that touches the phone is a parameter, so tests replace it. [pick] uploads a chosen file to the machine
 * it is given (the one whose origin the bridge verified).
 */
class BridgeMethods(
    private val context: Context,
    private val machines: () -> List<Machine>,
    private val outbox: EventOutbox,
    private val scope: CoroutineScope,
    private val pick: suspend (source: String, machine: Machine) -> PickedFile?,
    private val micPermission: suspend () -> Boolean,
    private val speaker: Speaker = Graph.once<Speaker> {
        Speaker(AndroidTts(Graph.context), AndroidAudioFocus(Graph.context))
    },
    private val lastRecording: LastRecording = Graph.once<LastRecording> { LastRecording() },
    private val newRecorder: () -> Recorder = { Recorder(AudioRecordMic(), File(context.cacheDir, "voice")) },
) {
    private class Active(val recorder: Recorder) {
        val stop = MutableStateFlow(false)
        val result = CompletableDeferred<Recording>()
        lateinit var job: Job
    }

    private val lock = Any()
    private var active: Active? = null
    private val startLock = Mutex()

    /** Runs [call] for [caller], the machine whose origin the bridge verified. Failures become an error reply. */
    suspend fun call(caller: Machine, call: BridgeProtocol.Parsed.Call): Reply =
        try {
            when (call.method) {
                "machines" -> result(call, machinesJson())
                "speak" -> {
                    val utterances = BridgeProtocol.speakArgs(call.args).getOrThrow()
                    val finished = speaker.speak(utterances)
                    result(call, buildJsonObject { put("finished", finished) })
                }
                "stopSpeaking" -> {
                    speaker.stop()
                    result(call, JsonNull)
                }
                "startRecording" -> {
                    startRecording(BridgeProtocol.autoStopArg(call.args))
                    result(call, JsonNull)
                }
                "stopRecording" -> stopRecording(call)
                "pickFile" -> {
                    val source = BridgeProtocol.pickArgs(call.args).getOrThrow()
                    val picked = pick(source, caller)
                    result(
                        call,
                        if (picked == null) JsonNull else buildJsonObject {
                            put("path", picked.path)
                            put("name", picked.name)
                        },
                    )
                }
                "openExternal" -> {
                    openExternal(BridgeProtocol.externalArgs(call.args).getOrThrow())
                    result(call, JsonNull)
                }
                "openSettings" -> {
                    openSettings(BridgeProtocol.settingsArgs(call.args).getOrThrow())
                    result(call, JsonNull)
                }
                else -> Reply(BridgeProtocol.error(call.id, "Bridge method not allowed: ${call.method}"))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Reply(BridgeProtocol.error(call.id, e.message ?: e.javaClass.simpleName))
        }

    /** The activity left the foreground: a recording in progress ends now and goes to the page as `recordingStopped`. */
    fun onBackground() {
        synchronized(lock) { active }?.recorder?.stopForBackground()
    }

    private fun result(call: BridgeProtocol.Parsed.Call, value: JsonElement) =
        Reply(BridgeProtocol.ok(call.id, value))

    private fun machinesJson() = JsonArray(
        machines().map { m ->
            buildJsonObject {
                put("name", m.name)
                put("origin", m.origin)
            }
        },
    )

    private suspend fun startRecording(autoStop: Boolean) {
        startLock.withLock {
            lastRecording.discard()
            check(micPermission()) { "Microphone permission denied" }
            // A second start replaces a recording the page lost track of (a reload): free the microphone first.
            synchronized(lock) { active }?.job?.cancelAndJoin()
            val next = Active(newRecorder())
            synchronized(lock) { active = next }
            next.job = scope.launch { run(next, autoStop) }
        }
    }

    private suspend fun run(a: Active, autoStop: Boolean) {
        val rec = try {
            a.recorder.record(autoStop, a.stop)
        } catch (e: CancellationException) {
            end(a)
            a.result.completeExceptionally(IllegalStateException("Recording cancelled"))
            throw e
        } catch (e: Exception) {
            end(a)
            a.result.completeExceptionally(e)
            return
        }
        // Kept before it stops being "active", so a stopRecording at this moment finds one or the other.
        lastRecording.keep(rec)
        end(a)
        a.result.complete(rec)
        if (rec.reason != RecordingReason.STOPPED) emitStopped(rec)
    }

    private fun end(a: Active) {
        synchronized(lock) { if (active === a) active = null }
    }

    private suspend fun emitStopped(rec: Recording) {
        val wav = try {
            encode(rec)
        } catch (_: IOException) {
            return // the file is gone: stopRecording will say so when the page asks
        }
        outbox.emit(EventOutbox.RECORDING_STOPPED, buildJsonObject { put("wav", wav) }) { delivered(rec) }
    }

    private suspend fun stopRecording(call: BridgeProtocol.Parsed.Call): Reply {
        val running = synchronized(lock) { active }
        val rec = if (running != null) {
            running.stop.value = true
            running.result.await()
        } else {
            lastRecording.current() ?: throw IllegalStateException("Not recording")
        }
        val wav = encode(rec)
        return Reply(BridgeProtocol.ok(call.id, buildJsonObject { put("wav", wav) })) { delivered(rec) }
    }

    /** The page has [rec]: delete it, unless a newer recording has been kept since. */
    private fun delivered(rec: Recording) {
        if (lastRecording.current()?.file == rec.file) lastRecording.delivered()
    }

    private suspend fun encode(rec: Recording): String =
        withContext(Dispatchers.IO) { Base64.getEncoder().encodeToString(rec.file.readBytes()) }

    private fun openSettings(screen: BridgeProtocol.SettingsScreen) {
        val target = when (screen) {
            BridgeProtocol.SettingsScreen.MACHINES -> MachinesActivity::class.java
            BridgeProtocol.SettingsScreen.BATTERY -> BatteryGuideActivity::class.java
        }
        val intent = Intent(context, target)
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun openExternal(target: BridgeProtocol.ExternalTarget) {
        when (target) {
            is BridgeProtocol.ExternalTarget.Https -> openCustomTab(context, target.url)
            BridgeProtocol.ExternalTarget.NotificationSettings -> {
                val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
        }
    }
}
