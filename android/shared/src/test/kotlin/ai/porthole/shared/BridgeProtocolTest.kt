package ai.porthole.shared

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {
    private fun args(json: String): JsonObject =
        (BridgeProtocol.parse("""{"id":1,"method":"speak","args":$json}""") as BridgeProtocol.Parsed.Call).args

    private fun speak(vararg parts: String): Result<List<String>> = BridgeProtocol.speakArgs(
        buildJsonObject { put("utterances", JsonArray(parts.map { JsonPrimitive(it) })) },
    )

    @Test fun machinesCallParses() {
        val p = BridgeProtocol.parse("""{"id":7,"method":"machines","args":{}}""")
        assertEquals(BridgeProtocol.Parsed.Call(JsonPrimitive(7), "machines", JsonObject(emptyMap())), p)
    }

    @Test fun argsDefaultToEmptyObject() {
        val p = BridgeProtocol.parse("""{"id":2,"method":"stopSpeaking"}""") as BridgeProtocol.Parsed.Call
        assertEquals(JsonObject(emptyMap()), p.args)
    }

    @Test fun methodsAreExactlyTheEightThePageSends() {
        assertEquals(
            setOf("machines", "speak", "stopSpeaking", "startRecording", "stopRecording", "pickFile", "openExternal", "openSettings"),
            BridgeProtocol.METHODS,
        )
        for (m in BridgeProtocol.METHODS) {
            assertTrue(m, BridgeProtocol.parse("""{"id":1,"method":"$m","args":{}}""") is BridgeProtocol.Parsed.Call)
        }
    }

    @Test fun unknownMethodsAreBadWithThePageAdapterWords() {
        for (m in listOf("readFile", "eval", "openSettings ", "")) {
            val p = BridgeProtocol.parse("""{"id":3,"method":"$m","args":{}}""")
            assertEquals(BridgeProtocol.Parsed.Bad(JsonPrimitive(3), "Bridge method not allowed: $m"), p)
        }
    }

    @Test fun openSettingsParsesAndNamesOneOfTwoScreens() {
        val p = BridgeProtocol.parse("""{"id":4,"method":"openSettings","args":{"screen":"battery"}}""") as BridgeProtocol.Parsed.Call
        assertEquals("openSettings", p.method)
        assertEquals(BridgeProtocol.SettingsScreen.BATTERY, BridgeProtocol.settingsArgs(p.args).getOrThrow())
        assertEquals(
            BridgeProtocol.SettingsScreen.MACHINES,
            BridgeProtocol.settingsArgs(buildJsonObject { put("screen", "machines") }).getOrThrow(),
        )
    }

    @Test fun openSettingsRefusesAnyOtherScreen() {
        assertTrue(BridgeProtocol.settingsArgs(JsonObject(emptyMap())).isFailure)
        for (s in listOf("", "Machines", "battery ", "notifications", "../battery", "porthole://machines")) {
            assertTrue(s, BridgeProtocol.settingsArgs(buildJsonObject { put("screen", s) }).isFailure)
        }
        assertTrue(BridgeProtocol.settingsArgs(buildJsonObject { put("screen", 1) }).isFailure)
        assertTrue(BridgeProtocol.settingsArgs(buildJsonObject { put("screen", JsonArray(listOf(JsonPrimitive("machines")))) }).isFailure)
    }

    @Test fun malformedMessagesAreBad() {
        assertTrue(BridgeProtocol.parse("not json") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("[1,2]") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("\"str\"") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("""{"id":1,"args":{}}""") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("""{"id":1,"method":5,"args":{}}""") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("""{"method":"machines","args":{}}""") is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse("""{"id":1,"method":"machines","args":[1]}""") is BridgeProtocol.Parsed.Bad)
    }

    @Test fun badKeepsTheIdWhenItCouldBeRead() {
        val p = BridgeProtocol.parse("""{"id":9,"args":{}}""") as BridgeProtocol.Parsed.Bad
        assertEquals(JsonPrimitive(9), p.id)
        assertEquals(null, (BridgeProtocol.parse("nope") as BridgeProtocol.Parsed.Bad).id)
    }

    @Test fun messageSizeLimit() {
        val head = """{"id":1,"method":"speak","args":{"utterances":["""
        val tail = """]}}"""
        fun withBody(total: Int): String {
            val body = "\"" + "a".repeat(total - head.length - tail.length - 2) + "\""
            return head + body + tail
        }
        assertEquals(BridgeProtocol.MAX_MESSAGE_CHARS, 262_144)
        val atLimit = withBody(BridgeProtocol.MAX_MESSAGE_CHARS)
        assertEquals(262_144, atLimit.length)
        assertTrue(BridgeProtocol.parse(atLimit) is BridgeProtocol.Parsed.Call)
        val over = withBody(BridgeProtocol.MAX_MESSAGE_CHARS + 1)
        assertEquals(262_145, over.length)
        assertTrue(BridgeProtocol.parse(over) is BridgeProtocol.Parsed.Bad)
        assertTrue(BridgeProtocol.parse(withBody(70_000)) is BridgeProtocol.Parsed.Call)
    }

    @Test fun repliesAndEventsHaveTheExactShape() {
        assertEquals("""{"id":1,"ok":true,"result":[]}""", BridgeProtocol.ok(JsonPrimitive(1), JsonArray(emptyList())))
        assertEquals("""{"id":1,"ok":false,"error":"x"}""", BridgeProtocol.error(JsonPrimitive(1), "x"))
        assertEquals(
            """{"event":"network","data":{"online":true}}""",
            BridgeProtocol.event("network", buildJsonObject { put("online", true) }),
        )
    }

    @Test fun speakAcceptsManyShortUtterances() {
        val r = speak(*Array(21) { "line $it" })
        assertTrue(r.isSuccess)
        assertEquals(21, r.getOrThrow().size)
    }

    @Test fun speakRefusesEmptyListEmptyStringAndMissingKey() {
        assertTrue(speak().isFailure)
        assertTrue(speak("ok", "").isFailure)
        assertTrue(BridgeProtocol.speakArgs(JsonObject(emptyMap())).isFailure)
        assertTrue(BridgeProtocol.speakArgs(buildJsonObject { put("utterances", "text") }).isFailure)
        assertTrue(BridgeProtocol.speakArgs(buildJsonObject { put("utterances", JsonArray(listOf(JsonPrimitive(5)))) }).isFailure)
    }

    @Test fun speakTotalIsCountedInUtf8Bytes() {
        assertTrue(speak("a".repeat(100_000)).isSuccess)
        assertTrue(speak("a".repeat(100_001)).isFailure)
        assertTrue(speak("a".repeat(50_000), "b".repeat(50_000)).isSuccess)
        assertTrue(speak("a".repeat(50_000), "b".repeat(50_001)).isFailure)
        // "é" is two bytes: 50 000 of them are exactly 100 000 bytes, one more byte over.
        assertTrue(speak("é".repeat(50_000)).isSuccess)
        assertTrue(speak("é".repeat(50_000), "x").isFailure)
        // a single long utterance is not capped per string, only by the total
        assertTrue(speak("a".repeat(99_999)).isSuccess)
    }

    @Test fun autoStopDefaultsToFalse() {
        assertTrue(BridgeProtocol.autoStopArg(buildJsonObject { put("autoStop", true) }))
        assertFalse(BridgeProtocol.autoStopArg(buildJsonObject { put("autoStop", false) }))
        assertFalse(BridgeProtocol.autoStopArg(JsonObject(emptyMap())))
        assertFalse(BridgeProtocol.autoStopArg(buildJsonObject { put("autoStop", "yes") }))
        assertFalse(BridgeProtocol.autoStopArg(buildJsonObject { put("autoStop", "true") }))
    }

    @Test fun pickSourceMustBeCameraPhotoOrFile() {
        for (s in listOf("camera", "photo", "file")) {
            assertEquals(s, BridgeProtocol.pickArgs(buildJsonObject { put("source", s) }).getOrThrow())
        }
        for (s in listOf("clipboard", "", "Camera")) {
            assertTrue(s, BridgeProtocol.pickArgs(buildJsonObject { put("source", s) }).isFailure)
        }
        assertTrue(BridgeProtocol.pickArgs(JsonObject(emptyMap())).isFailure)
        assertTrue(BridgeProtocol.pickArgs(buildJsonObject { put("source", 3) }).isFailure)
    }

    private fun external(url: String) = BridgeProtocol.externalArgs(buildJsonObject { put("url", url) })

    @Test fun externalTargets() {
        assertEquals(
            BridgeProtocol.ExternalTarget.NotificationSettings,
            external("porthole://notification-settings").getOrThrow(),
        )
        assertEquals(
            BridgeProtocol.ExternalTarget.Https("https://example.com/a"),
            external("https://example.com/a").getOrThrow(),
        )
        for (u in listOf(
            "http://x", "javascript:x", "intent://x", "porthole://other",
            "porthole://notification-settings/x", "https://", "https:///x", "", "https://exa mple.com",
        )) {
            assertTrue(u, external(u).isFailure)
        }
        assertTrue(BridgeProtocol.externalArgs(JsonObject(emptyMap())).isFailure)
    }

    @Test fun argsHelperReadsRealArgs() {
        assertEquals(JsonObject(mapOf("utterances" to JsonArray(listOf(JsonPrimitive("hi"))))), args("""{"utterances":["hi"]}"""))
    }
}
