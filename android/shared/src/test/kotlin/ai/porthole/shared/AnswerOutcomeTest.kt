package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class AnswerOutcomeTest {
    @Test fun sentOnStatusSent() {
        val o = AnswerOutcome.from(200, """{"status":"sent","reason":"ok"}""", "Yes")
        assertEquals(AnswerOutcome.Sent("Yes"), o)
        assertEquals("Sent: Yes", o.text())
    }

    @Test fun refusedKeepsTheReason() {
        val o = AnswerOutcome.from(409, """{"status":"refused","reason":"question closed"}""", "Yes")
        assertEquals(AnswerOutcome.Refused("question closed"), o)
        assertEquals("Not sent: question closed", o.text())
    }

    @Test fun refusedWithoutReasonOrBodyStillWorks() {
        assertEquals(AnswerOutcome.Refused("not sent"), AnswerOutcome.from(409, """{"status":"refused"}""", "Yes"))
        assertEquals(AnswerOutcome.Refused("not sent"), AnswerOutcome.from(409, null, "Yes"))
        assertEquals(AnswerOutcome.Refused("not sent"), AnswerOutcome.from(409, "<html>", "Yes"))
    }

    @Test fun goneOn404() {
        val o = AnswerOutcome.from(404, """{"error":"nope"}""", "Yes")
        assertEquals(AnswerOutcome.Gone, o)
        assertEquals("This question is gone", o.text())
    }

    @Test fun everythingElseFails() {
        for (code in listOf(-1, 400, 500, 502, 204)) {
            val o = AnswerOutcome.from(code, null, "Yes")
            assertEquals("code $code", true, o is AnswerOutcome.Failed)
            assertEquals("Couldn't send. Open Porthole to try again", o.text())
        }
    }

    @Test fun a200WithoutSentStatusIsNotSent() {
        assertEquals(true, AnswerOutcome.from(200, """{"status":"refused"}""", "Yes") is AnswerOutcome.Failed)
        assertEquals(true, AnswerOutcome.from(200, null, "Yes") is AnswerOutcome.Failed)
        assertEquals(true, AnswerOutcome.from(200, "garbage", "Yes") is AnswerOutcome.Failed)
    }
}
