package ai.porthole.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** Watch → phone, over `MessageClient` on [WatchPaths.ANSWER]. Sealed-class JSON uses kotlinx's `type` discriminator. */
@Serializable
sealed interface WatchAnswer {
    val requestId: String

    @Serializable
    data class Option(
        override val requestId: String,
        val origin: String,
        val itemId: String,
        val optionIndexes: List<Int>,
    ) : WatchAnswer

    @Serializable
    data class Stop(
        override val requestId: String,
        val origin: String,
        val sessionId: String,
    ) : WatchAnswer

    fun encode(): ByteArray = Wire.json.encodeToString<WatchAnswer>(this).toByteArray(Charsets.UTF_8)

    companion object {
        /** Null for bytes that are not an answer. */
        fun decode(bytes: ByteArray): WatchAnswer? =
            runCatching { Wire.json.decodeFromString<WatchAnswer>(bytes.toString(Charsets.UTF_8)) }.getOrNull()
    }
}

/** Phone → watch, over `MessageClient` on [WatchPaths.ANSWER_RESULT]. */
@Serializable
data class WatchAnswerResult(val requestId: String, val ok: Boolean, val message: String) {
    fun encode(): ByteArray = Wire.json.encodeToString(this).toByteArray(Charsets.UTF_8)

    companion object {
        fun decode(bytes: ByteArray): WatchAnswerResult? =
            runCatching { Wire.json.decodeFromString<WatchAnswerResult>(bytes.toString(Charsets.UTF_8)) }.getOrNull()
    }
}
