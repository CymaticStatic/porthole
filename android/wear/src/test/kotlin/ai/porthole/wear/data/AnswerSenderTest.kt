package ai.porthole.wear.data

import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class FakeLink(var node: String? = "phone-1", var sendOk: Boolean = true) : WearLink {
    class Sent(val nodeId: String, val path: String, val bytes: ByteArray)

    val sent = mutableListOf<Sent>()

    override suspend fun phoneNodeId(): String? = node

    override suspend fun send(nodeId: String, path: String, bytes: ByteArray): Boolean {
        sent += Sent(nodeId, path, bytes)
        return sendOk
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AnswerSenderTest {
    private val option = WatchAnswer.Option("req-1", "https://desk.ts.net", "item-9", listOf(1))

    @Test
    fun noPhoneNodeGivesPhoneNotConnectedAndSendsNothing() = runTest {
        val link = FakeLink(node = null)

        val result = AnswerSender(link, PendingAnswers()).answer(option)

        assertEquals(WatchAnswerResult("req-1", ok = false, message = "Phone not connected"), result)
        assertTrue(link.sent.isEmpty())
    }

    @Test
    fun answerIsSentOnAnswerPathWithTheEncodedAnswerAndReturnsThePhonesResult() = runTest {
        val link = FakeLink()
        val pending = PendingAnswers()
        val sender = AnswerSender(link, pending)

        val result = async { sender.answer(option) }
        runCurrent()

        assertEquals(1, link.sent.size)
        assertEquals("phone-1", link.sent[0].nodeId)
        assertEquals("/porthole/answer", link.sent[0].path)
        assertArrayEquals(option.encode(), link.sent[0].bytes)
        assertEquals(option, WatchAnswer.decode(link.sent[0].bytes))
        assertFalse(result.isCompleted)

        val phoneResult = WatchAnswerResult("req-1", ok = true, message = "Sent: Yes")
        assertTrue(pending.complete(phoneResult))
        assertEquals(phoneResult, result.await())
    }

    @Test
    fun stopAnswerIsSentOnTheSamePath() = runTest {
        val link = FakeLink()
        val stop = WatchAnswer.Stop("req-2", "https://desk.ts.net", "tmux:t:main:0.0")
        val sender = AnswerSender(link, PendingAnswers())

        val result = async { sender.answer(stop) }
        runCurrent()

        assertEquals("/porthole/answer", link.sent.single().path)
        assertEquals(stop, WatchAnswer.decode(link.sent.single().bytes))
        advanceTimeBy(15_001)
        runCurrent()
        assertEquals(WatchAnswerResult("req-2", ok = false, message = "Phone didn't answer"), result.await())
    }

    @Test
    fun phoneThatNeverAnswersGivesPhoneDidntAnswerAfter15Seconds() = runTest {
        val sender = AnswerSender(FakeLink(), PendingAnswers())

        val result = async { sender.answer(option) }
        advanceTimeBy(14_999)
        runCurrent()
        assertFalse(result.isCompleted)
        advanceTimeBy(2)
        runCurrent()

        assertEquals(WatchAnswerResult("req-1", ok = false, message = "Phone didn't answer"), result.await())
    }

    @Test
    fun failedSendGivesPhoneNotConnectedWithoutWaiting() = runTest {
        val link = FakeLink(sendOk = false)

        val result = AnswerSender(link, PendingAnswers()).answer(option)

        assertEquals(WatchAnswerResult("req-1", ok = false, message = "Phone not connected"), result)
        assertEquals(1, link.sent.size)
    }

    @Test
    fun refreshSendsOnRefreshPathAndNothingWithoutAPhone() = runTest {
        val link = FakeLink()
        AnswerSender(link, PendingAnswers()).refresh()
        assertEquals("/porthole/refresh", link.sent.single().path)
        assertEquals("phone-1", link.sent.single().nodeId)

        val none = FakeLink(node = null)
        AnswerSender(none, PendingAnswers()).refresh()
        assertTrue(none.sent.isEmpty())
    }

    @Test
    fun answerResultMessageCompletesThePendingAnswerAndBadBytesAreIgnored() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val pending = PendingAnswers()
        val handler = WearDataHandler(StateRepository(context), pending) {}
        pending.register("req-1")
        val answer = async { pending.await("req-1") }
        runCurrent()

        handler.onAnswerResultBytes("not json".toByteArray())
        handler.onAnswerResultBytes(WatchAnswerResult("other", ok = true, message = "x").encode())
        runCurrent()
        assertFalse(answer.isCompleted)

        val result = WatchAnswerResult("req-1", ok = false, message = "Not sent: question closed")
        handler.onAnswerResultBytes(result.encode())

        assertEquals(result, answer.await())
    }
}
