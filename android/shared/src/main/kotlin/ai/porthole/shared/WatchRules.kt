package ai.porthole.shared

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

object WatchRules {
    const val MAX_ITEMS = 30
    const val MAX_BYTES = 90_000
    const val MAX_QUESTION_CHARS = 300

    fun build(now: Long, inbox: Map<Machine, List<InboxItem>>, usage: Map<Machine, Usage>): WatchState {
        val items = inbox.flatMap { (machine, list) ->
            list.filter { it.column == "needs-you" && it.archivedAt == null }.map { toWatchItem(machine, it) }
        }.sortedByDescending { it.updatedAt }.take(MAX_ITEMS).toMutableList()

        val windows = usage.flatMap { (machine, u) ->
            u.windows.mapNotNull { w ->
                val pct = w.usedPercent ?: return@mapNotNull null
                val resets = (w.resetsAt as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
                WatchUsage(machine.name, w.id, pct, resets)
            }
        }

        var state = WatchState(now, items, windows)
        while (items.isNotEmpty() && state.encode().size > MAX_BYTES) {
            items.removeAt(items.lastIndex)
            state = WatchState(now, items.toList(), windows)
        }
        return state
    }

    private fun toWatchItem(machine: Machine, i: InboxItem): WatchItem {
        val q = i.question
        return WatchItem(
            origin = machine.origin,
            machine = i.machine,
            itemId = i.id,
            sessionId = i.sessionId,
            project = i.project,
            title = i.title,
            question = q?.text?.let { cutText(it) },
            options = if (q != null && !q.multi) q.options else emptyList(),
            multi = q?.multi ?: false,
            updatedAt = i.updatedAt,
        )
    }

    private fun cutText(s: String): String {
        if (s.length <= MAX_QUESTION_CHARS) return s
        var end = MAX_QUESTION_CHARS - 1
        if (Character.isHighSurrogate(s[end - 1])) end--
        return s.substring(0, end) + "…"
    }
}
