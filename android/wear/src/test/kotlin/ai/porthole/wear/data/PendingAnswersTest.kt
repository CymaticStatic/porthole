package ai.porthole.wear.data

import ai.porthole.shared.WatchAnswerResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PendingAnswersTest {
    @Test
    fun matchingResultWithin15SecondsCompletesTheAnswer() = runTest {
        val pending = PendingAnswers()
        pending.register("r1")
        val answer = async { pending.await("r1") }
        advanceTimeBy(14_999)
        runCurrent()
        assertFalse(answer.isCompleted)

        val result = WatchAnswerResult("r1", ok = true, message = "Sent: Yes")
        assertTrue(pending.complete(result))

        assertEquals(result, answer.await())
    }

    @Test
    fun resultForAnotherRequestIdIsIgnored() = runTest {
        val pending = PendingAnswers()
        pending.register("r1")
        val answer = async { pending.await("r1") }
        runCurrent()

        assertFalse(pending.complete(WatchAnswerResult("other", ok = true, message = "Sent: No")))
        runCurrent()
        assertFalse(answer.isCompleted)

        val result = WatchAnswerResult("r1", ok = true, message = "Sent: Yes")
        assertTrue(pending.complete(result))
        assertEquals(result, answer.await())
    }

    @Test
    fun nothingWithin15SecondsGivesPhoneDidntAnswer() = runTest {
        val pending = PendingAnswers()
        pending.register("r1")
        val answer = async { pending.await("r1") }
        advanceTimeBy(14_999)
        runCurrent()
        assertFalse(answer.isCompleted)

        advanceTimeBy(2)
        runCurrent()

        assertEquals(WatchAnswerResult("r1", ok = false, message = "Phone didn't answer"), answer.await())
    }

    @Test
    fun resultArrivingAfterTheTimeoutIsIgnored() = runTest {
        val pending = PendingAnswers()
        pending.register("r1")
        val answer = async { pending.await("r1") }
        advanceTimeBy(15_001)
        runCurrent()
        answer.await()

        assertFalse(pending.complete(WatchAnswerResult("r1", ok = true, message = "late")))
    }

    @Test
    fun twoRequestsAreAnsweredIndependently() = runTest {
        val pending = PendingAnswers()
        pending.register("a")
        pending.register("b")
        val a = async { pending.await("a") }
        val b = async { pending.await("b") }
        runCurrent()

        pending.complete(WatchAnswerResult("b", ok = true, message = "B"))
        runCurrent()

        assertFalse(a.isCompleted)
        assertEquals("B", b.await().message)
        pending.complete(WatchAnswerResult("a", ok = false, message = "A"))
        assertEquals("A", a.await().message)
    }
}
