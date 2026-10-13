package ai.porthole.shared

import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WireTest {
    @Test fun notifyParses() {
        val e = Wire.parseEvent("""{"type":"notify","id":7,"itemId":"i1","title":"t","body":"b","options":[{"index":0,"label":"Yes"},{"index":1,"label":"No"}],"at":"2026-10-13T10:00:00Z","extra":1}""")
        assertEquals(ServerEvent.Notify(7, "i1", "t", "b", listOf(NotifyOption(0, "Yes"), NotifyOption(1, "No"))), e)
    }
    @Test fun notifyWithEmptyOptionsParses() {
        val e = Wire.parseEvent("""{"type":"notify","id":8,"itemId":"i2","title":"t","body":"b","options":[],"at":1}""")
        assertEquals(ServerEvent.Notify(8, "i2", "t", "b", emptyList()), e)
    }
    @Test fun inboxParses() {
        val item = """{"id":"a","key":"k","sessionId":"tmux:t:main:0.0","machine":"testdesk","project":"p","kind":"omp","column":"needs-you","title":"T","body":"B","question":{"qid":"q","pid":1,"text":"Go?","options":["Yes","No"],"multi":false,"count":2,"open":true,"outcome":null},"contextLeft":null,"createdAt":1,"updatedAt":2,"doneAt":null,"archivedAt":null}"""
        val e = Wire.parseEvent("""{"type":"inbox","items":[$item]}""") as ServerEvent.Inbox
        assertEquals("needs-you", e.items[0].column)
        assertEquals(listOf("Yes", "No"), e.items[0].question!!.options)
        assertEquals(1, e.items[0].createdAt)
        assertNull(e.items[0].doneAt)
        assertNull(e.items[0].question!!.outcome)
    }
    @Test fun inboxItemWithoutQuestionParses() {
        val item = """{"id":"a","key":"k","sessionId":"s","machine":"m","project":"p","kind":"omp","column":"done","title":"T","body":"B","question":null,"contextLeft":0.42,"createdAt":1,"updatedAt":2,"doneAt":3,"archivedAt":null}"""
        val e = Wire.parseEvent("""{"type":"inbox","items":[$item]}""") as ServerEvent.Inbox
        assertNull(e.items[0].question)
        assertEquals(0.42, e.items[0].contextLeft!!, 0.0)
        assertEquals(3L, e.items[0].doneAt)
    }
    @Test fun unknownTypeIsKept() = assertEquals(ServerEvent.Unknown("hello"), Wire.parseEvent("""{"type":"hello"}"""))
    @Test fun sessionsKeepsTree() {
        val e = Wire.parseEvent("""{"type":"sessions","tree":{"machine":"m"}}""")
        assertTrue(e is ServerEvent.Sessions)
        assertEquals("""{"machine":"m"}""", (e as ServerEvent.Sessions).tree.toString())
    }
    @Test fun malformedMessageThrows() {
        for (bad in listOf("not json", """{"type":"notify","id":"x"}""", """{"id":1}""", """[1]""")) {
            try {
                Wire.parseEvent(bad)
                fail("expected SerializationException for $bad")
            } catch (_: SerializationException) {
            }
        }
    }
    @Test fun ackAndBodies() {
        assertEquals("""{"type":"ack","id":7}""", Wire.ack(7))
        assertEquals("""{"optionIndexes":[1]}""", Wire.answerBody(listOf(1)))
        assertEquals("""{"optionIndexes":[0,2]}""", Wire.answerBody(listOf(0, 2)))
        assertEquals("""{"keys":["Esc"]}""", Wire.keysBody(listOf("Esc")))
    }
    @Test fun repliesParse() {
        assertEquals(AnswerReply("refused", "question closed"), Wire.parseAnswer("""{"status":"refused","reason":"question closed"}"""))
        assertEquals(AnswerReply("refused", null), Wire.parseAnswer("""{"status":"refused","reason":null}"""))
        assertEquals(AnswerReply("sent", null), Wire.parseAnswer("""{"status":"sent"}"""))
        assertEquals(72.0, Wire.parseUsage("""{"windows":[{"id":"5h","usedPercent":72,"resetsAt":"x","status":"ok"}],"readAt":1}""").windows[0].usedPercent!!, 0.0)
        assertEquals("bencell", Wire.parseMachineInfo("""{"name":"bendesk-omarchy","version":"1","authMode":"tailscale","you":{"device":"bencell","via":"serve"},"features":{}}""").you!!.device)
        assertEquals("/tmp/x.png", Wire.parseUpload("""{"path":"/tmp/x.png"}""").path)
    }
    @Test fun usageWindowToleratesMissingFields() {
        val w = Wire.parseUsage("""{"windows":[{"id":"7d"}]}""").windows[0]
        assertEquals("7d", w.id)
        assertNull(w.usedPercent)
        assertNull(w.resetsAt)
        assertNull(w.status)
    }
    @Test fun machineInfoWithoutYouParses() {
        val m = Wire.parseMachineInfo("""{"name":"x"}""")
        assertEquals("x", m.name)
        assertNull(m.you)
    }
}
