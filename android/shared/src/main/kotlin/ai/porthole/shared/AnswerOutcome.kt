package ai.porthole.shared

sealed interface AnswerOutcome {
    data class Sent(val label: String) : AnswerOutcome
    data class Refused(val reason: String) : AnswerOutcome
    data object Gone : AnswerOutcome
    data class Failed(val message: String) : AnswerOutcome

    companion object
}

/** [code] is the HTTP status of `POST /v1/inbox/:itemId/answer`, or -1 when the request itself failed. */
fun AnswerOutcome.Companion.from(code: Int, body: String?, label: String): AnswerOutcome {
    val reply = body?.let { runCatching { Wire.parseAnswer(it) }.getOrNull() }
    return when (code) {
        200 -> if (reply?.status == "sent") AnswerOutcome.Sent(label) else AnswerOutcome.Failed("Unexpected reply")
        409 -> AnswerOutcome.Refused(reply?.reason?.takeIf { it.isNotBlank() } ?: "not sent")
        404 -> AnswerOutcome.Gone
        -1 -> AnswerOutcome.Failed("No connection")
        else -> AnswerOutcome.Failed("HTTP $code")
    }
}

fun AnswerOutcome.text(): String = when (this) {
    is AnswerOutcome.Sent -> "Sent: $label"
    is AnswerOutcome.Refused -> "Not sent: $reason"
    AnswerOutcome.Gone -> "This question is gone"
    is AnswerOutcome.Failed -> "Couldn't send. Open Porthole to try again"
}
