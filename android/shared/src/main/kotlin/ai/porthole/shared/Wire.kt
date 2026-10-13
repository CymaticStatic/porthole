package ai.porthole.shared

import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put

@Serializable
data class NotifyOption(val index: Int, val label: String)

@Serializable
data class Question(
    val qid: String,
    val pid: Int,
    val text: String,
    val options: List<String>,
    val multi: Boolean,
    val count: Int,
    val open: Boolean,
    val outcome: String? = null,
)

@Serializable
data class InboxItem(
    val id: String,
    val key: String,
    val sessionId: String,
    val machine: String,
    val project: String,
    val kind: String,
    val column: String,
    val title: String,
    val body: String,
    val question: Question? = null,
    val contextLeft: Double? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val doneAt: Long? = null,
    val archivedAt: Long? = null,
)

@Serializable
data class AnswerReply(val status: String, val reason: String? = null)

@Serializable
data class UsageWindow(
    val id: String,
    val usedPercent: Double? = null,
    val resetsAt: JsonElement? = null,
    val status: String? = null,
)

@Serializable
data class Usage(val windows: List<UsageWindow>)

@Serializable
data class You(val device: String? = null)

@Serializable
data class MachineInfo(val name: String, val you: You? = null)

@Serializable
data class UploadReply(val path: String)

sealed interface ServerEvent {
    data class Sessions(val tree: JsonElement) : ServerEvent
    data class Inbox(val items: List<InboxItem>) : ServerEvent
    data class Notify(
        val id: Long,
        val itemId: String,
        val title: String,
        val body: String,
        val options: List<NotifyOption>,
    ) : ServerEvent
    data class Unknown(val type: String) : ServerEvent
}

@Serializable
private data class NotifyWire(
    val id: Long,
    val itemId: String,
    val title: String,
    val body: String,
    val options: List<NotifyOption>,
)

@Serializable
private data class InboxWire(val items: List<InboxItem>)

object Wire {
    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    /** Throws [SerializationException] for a message that is not a JSON object with a string `type`, or whose fields do not fit. */
    fun parseEvent(text: String): ServerEvent {
        val root = json.parseToJsonElement(text) as? JsonObject
            ?: throw SerializationException("event is not a JSON object")
        val type = (root["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw SerializationException("event has no string type")
        return when (type) {
            "notify" -> json.decodeFromJsonElement<NotifyWire>(root).let {
                ServerEvent.Notify(it.id, it.itemId, it.title, it.body, it.options)
            }
            "inbox" -> ServerEvent.Inbox(json.decodeFromJsonElement<InboxWire>(root).items)
            "sessions" -> ServerEvent.Sessions(root["tree"] ?: throw SerializationException("sessions event has no tree"))
            else -> ServerEvent.Unknown(type)
        }
    }

    fun ack(id: Long): String = buildJsonObject {
        put("type", "ack")
        put("id", id)
    }.toString()

    fun answerBody(optionIndexes: List<Int>): String = buildJsonObject {
        put("optionIndexes", JsonArray(optionIndexes.map { JsonPrimitive(it) }))
    }.toString()

    fun keysBody(keys: List<String>): String = buildJsonObject {
        put("keys", JsonArray(keys.map { JsonPrimitive(it) }))
    }.toString()

    fun parseAnswer(text: String): AnswerReply = json.decodeFromString(text)

    fun parseUsage(text: String): Usage = json.decodeFromString(text)

    fun parseMachineInfo(text: String): MachineInfo = json.decodeFromString(text)

    fun parseUpload(text: String): UploadReply = json.decodeFromString(text)
}
