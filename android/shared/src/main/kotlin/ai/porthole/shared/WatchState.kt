package ai.porthole.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class WatchItem(
    val origin: String,
    val machine: String,
    val itemId: String,
    val sessionId: String,
    val project: String,
    val title: String,
    val question: String?,
    val options: List<String>,
    val multi: Boolean,
    val updatedAt: Long,
)

@Serializable
data class WatchUsage(
    val machine: String,
    val windowId: String,
    val usedPercent: Double,
    val resetsAt: String?,
)

@Serializable
data class WatchState(
    val updatedAt: Long,
    val items: List<WatchItem>,
    val usage: List<WatchUsage>,
) {
    fun encode(): ByteArray = Wire.json.encodeToString(this).toByteArray(Charsets.UTF_8)

    companion object {
        /** Null for bytes that are not a state. */
        fun decode(bytes: ByteArray): WatchState? =
            runCatching { Wire.json.decodeFromString<WatchState>(bytes.toString(Charsets.UTF_8)) }.getOrNull()
    }
}
