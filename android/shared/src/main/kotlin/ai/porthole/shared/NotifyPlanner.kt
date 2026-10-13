package ai.porthole.shared

data class NotifyPlan(
    val tag: String,
    val id: Int,
    val title: String,
    val body: String,
    val subText: String,
    val answers: List<NotifyOption>,
    val itemId: String,
    val notifyId: Long,
)

object NotifyPlanner {
    const val MAX_TITLE = 80
    const val MAX_BODY = 200

    fun plan(n: ServerEvent.Notify, machine: Machine): NotifyPlan = NotifyPlan(
        tag = machine.origin,
        id = n.itemId.hashCode(),
        title = cut(n.title, MAX_TITLE),
        body = cut(n.body, MAX_BODY),
        subText = machine.name,
        answers = if (n.options.size in 2..3) n.options.take(2) else emptyList(),
        itemId = n.itemId,
        notifyId = n.id,
    )

    /** At most [max] characters, ending with an ellipsis when cut, never splitting a surrogate pair. */
    private fun cut(s: String, max: Int): String {
        if (s.length <= max) return s
        var end = max - 1
        if (end > 0 && Character.isHighSurrogate(s[end - 1])) end--
        return s.substring(0, end) + "…"
    }
}
