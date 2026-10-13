package ai.porthole.wear.ui

import ai.porthole.shared.Routes
import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.wear.data.AnswerSender
import java.time.Instant
import java.util.UUID
import kotlin.math.roundToInt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What [InboxModel] needs from [AnswerSender]; tests use a fake. */
interface AnswerPort {
    suspend fun answer(a: WatchAnswer): WatchAnswerResult

    suspend fun refresh()
}

fun AnswerSender.asPort(): AnswerPort = object : AnswerPort {
    override suspend fun answer(a: WatchAnswer): WatchAnswerResult = this@asPort.answer(a)

    override suspend fun refresh() = this@asPort.refresh()
}

/** Starts the chat on the phone for "Open on phone"; true when the Data Layer accepted the request. */
fun interface PhoneOpener {
    suspend fun open(uri: String): Boolean
}

data class InboxView(
    /** Newest first. */
    val items: List<WatchItem>,
    /** "Nothing waiting" when [items] is empty, otherwise null. */
    val emptyMessage: String?,
    /** "Updated N min ago" when the state is stale, otherwise null. */
    val updatedLine: String?,
    /** True when the last send found no phone. */
    val phoneNotConnected: Boolean,
)

data class ResultView(val ok: Boolean, val message: String)

data class UsageRow(val machine: String, val window: String, val percent: String, val reset: String?)

data class UsageView(val rows: List<UsageRow>, val emptyMessage: String?)

/**
 * The state the watch screens read: [WatchState] from the phone plus the outcome of the watch's own sends.
 * Plain Kotlin, so the rules (order, empty text, stale line, single-tap sends, the Stop confirm) are tested
 * without Compose. Every function runs on the main thread.
 */
class InboxModel(
    source: StateFlow<WatchState?>,
    private val isStale: (Long) -> Boolean,
    private val port: AnswerPort,
    private val opener: PhoneOpener,
    private val clock: () -> Long,
    private val requestIds: () -> String = { UUID.randomUUID().toString() },
) {
    val state: StateFlow<WatchState?> = source

    private val mutableBusy = MutableStateFlow(false)
    private val mutableResult = MutableStateFlow<ResultView?>(null)
    private val mutableStopPending = MutableStateFlow<String?>(null)
    private val mutablePhoneNotConnected = MutableStateFlow(false)

    /** True while a send waits for the phone; the buttons are off and a second tap is ignored. */
    val busy: StateFlow<Boolean> = mutableBusy.asStateFlow()

    /** The outcome of the last send, shown by the result screen. */
    val result: StateFlow<ResultView?> = mutableResult.asStateFlow()

    /** The id of the item whose "Stop this session?" confirm is showing. */
    val stopPending: StateFlow<String?> = mutableStopPending.asStateFlow()

    /** True after the last send found no phone; the inbox header says so. */
    val phoneNotConnected: StateFlow<Boolean> = mutablePhoneNotConnected.asStateFlow()

    /** The model's clock, epoch milliseconds; the screens redraw their "Updated N min ago" text from it. */
    fun now(): Long = clock()

    fun inbox(now: Long = clock()): InboxView {
        val current = state.value
        val items = current?.items.orEmpty().sortedByDescending { it.updatedAt }
        val updatedLine = if (current != null && isStale(now)) {
            "Updated ${((now - current.updatedAt) / 60_000L).coerceAtLeast(0)} min ago"
        } else {
            null
        }
        return InboxView(
            items = items,
            emptyMessage = if (items.isEmpty()) NOTHING_WAITING else null,
            updatedLine = updatedLine,
            phoneNotConnected = mutablePhoneNotConnected.value,
        )
    }

    fun item(itemId: String): WatchItem? = state.value?.items?.firstOrNull { it.itemId == itemId }

    /** The answer buttons for [item]: none for a multi-select question, which only the phone can answer. */
    fun optionsOf(item: WatchItem): List<String> = if (item.multi) emptyList() else item.options

    fun usage(now: Long = clock()): UsageView {
        val rows = state.value?.usage.orEmpty().map {
            UsageRow(it.machine, windowLabel(it.windowId), "${it.usedPercent.roundToInt()}%", resetText(it.resetsAt, now))
        }
        return UsageView(rows, if (rows.isEmpty()) NO_USAGE else null)
    }

    suspend fun refresh() = port.refresh()

    /** Sends option [optionIndex] (0-based position in the item's options); null when it was ignored. */
    suspend fun choose(item: WatchItem, optionIndex: Int): ResultView? {
        if (optionIndex !in optionsOf(item).indices) return null
        return send(WatchAnswer.Option(requestIds(), item.origin, item.itemId, listOf(optionIndex)))
    }

    fun requestStop(item: WatchItem) {
        mutableStopPending.value = item.itemId
    }

    fun cancelStop() {
        mutableStopPending.value = null
    }

    /** Stops the session behind [item], but only when [requestStop] was called for this very item. */
    suspend fun confirmStop(item: WatchItem): ResultView? {
        if (mutableStopPending.value != item.itemId) return null
        return send(WatchAnswer.Stop(requestIds(), item.origin, item.sessionId))
    }

    suspend fun openOnPhone(item: WatchItem): ResultView {
        val opened = opener.open(openOnPhoneUri(item))
        val view = if (opened) ResultView(true, "Opened on phone") else ResultView(false, "Couldn't open on phone")
        mutableResult.value = view
        return view
    }

    fun clearResult() {
        mutableResult.value = null
    }

    private suspend fun send(answer: WatchAnswer): ResultView? {
        if (!mutableBusy.compareAndSet(false, true)) return null
        try {
            val reply = port.answer(answer)
            mutablePhoneNotConnected.value = !reply.ok && reply.message == AnswerSender.PHONE_NOT_CONNECTED
            val view = ResultView(reply.ok, reply.message.ifBlank { if (reply.ok) "Sent" else "Not sent" })
            mutableResult.value = view
            mutableStopPending.value = null
            return view
        } finally {
            mutableBusy.value = false
        }
    }

    companion object {
        const val NOTHING_WAITING = "Nothing waiting"
        const val NO_USAGE = "No usage yet"
        const val STOP_PROMPT = "Stop this session?"

        /**
         * The `porthole://open?...` link the phone's `MainActivity` handles. **GUESS:** `item.machine` equals the
         * machine part of the page's `#/chat/<machine>/<sessionId>` route (the name `/v1/machine` reports); checked
         * on the device in E3 step 5g.
         */
        fun openOnPhoneUri(item: WatchItem): String =
            Routes.openLink(item.origin, "#/chat/" + Routes.segment(item.machine) + "/" + Routes.segment(item.sessionId))

        private fun windowLabel(id: String): String = when (id) {
            "5h" -> "5-hour"
            "7d" -> "7-day"
            else -> id
        }

        private fun resetText(resetsAt: String?, now: Long): String? {
            val at = runCatching { Instant.parse(resetsAt ?: return null).toEpochMilli() }.getOrNull() ?: return null
            val minutes = (at - now) / 60_000L
            if (minutes <= 0) return "Resetting now"
            val days = minutes / (24 * 60)
            val hours = minutes % (24 * 60) / 60
            val mins = minutes % 60
            val parts = buildList {
                if (days > 0) add("$days d")
                if (hours > 0) add("$hours h")
                if (days == 0L && mins > 0) add("$mins min")
            }
            return "Resets in " + parts.joinToString(" ")
        }
    }
}
