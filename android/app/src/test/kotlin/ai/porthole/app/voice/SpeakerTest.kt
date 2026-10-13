package ai.porthole.app.voice

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeEngine : TtsEngine {
    override var listener: ((id: String, done: Boolean) -> Unit)? = null
    val spoken = mutableListOf<Pair<String, String>>() // text, id
    var stops = 0
    val log = mutableListOf<String>()

    override fun speak(text: String, id: String) {
        spoken.add(text to id)
        log.add("speak")
    }

    override fun stop() {
        stops++
        log.add("stop")
    }

    fun texts() = spoken.map { it.first }
    fun started(i: Int) = listener!!.invoke(spoken[i].second, false)
    fun ended(i: Int) = listener!!.invoke(spoken[i].second, true)
}

private class FakeFocus(private val log: MutableList<String>) : AudioFocus {
    var requests = 0
    var abandons = 0

    override fun request() {
        requests++
        log.add("focus")
    }

    override fun abandon() {
        abandons++
        log.add("abandon")
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class SpeakerTest {
    private val engine = FakeEngine()
    private val focus = FakeFocus(engine.log)
    private val speaker = Speaker(engine, focus)

    @Test fun threeUtterancesReachTheEngineInOrderAndSpeakFinishesAfterTheThird() = runTest {
        val result = async { speaker.speak(listOf("one", "two", "three")) }
        runCurrent()

        assertEquals(listOf("one", "two", "three"), engine.texts())
        assertEquals(3, engine.spoken.map { it.second }.toSet().size) // distinct ids
        assertFalse(result.isCompleted)
        engine.started(0); engine.ended(0)
        engine.started(1); engine.ended(1)
        runCurrent()
        assertFalse("not finished before the third ends", result.isCompleted)
        engine.started(2)
        runCurrent()
        assertFalse("starting the third is not finishing it", result.isCompleted)
        engine.ended(2)
        assertTrue(result.await())
    }

    @Test fun focusIsRequestedBeforeTheFirstUtteranceAndAbandonedAfterTheLast() = runTest {
        val result = async { speaker.speak(listOf("a", "b")) }
        runCurrent()
        assertEquals(listOf("focus", "speak", "speak"), engine.log)
        assertEquals(0, focus.abandons)
        engine.ended(0); engine.ended(1)
        result.await()
        assertEquals(1, focus.requests)
        assertEquals(1, focus.abandons)
        assertEquals("abandon", engine.log.last())
    }

    @Test fun aNineThousandCharacterUtteranceIsSplitIntoPiecesOfAtMostFourThousand() = runTest {
        val text = (1..1_200).joinToString(" ") { "w$it" }.let { it + "x".repeat(9_000 - it.length) }
        assertEquals(9_000, text.length)
        val result = async { speaker.speak(listOf(text)) }
        runCurrent()

        assertTrue(engine.spoken.size >= 3)
        assertTrue(engine.texts().all { it.length in 1..4_000 })
        assertEquals(text, engine.texts().joinToString(""))
        engine.spoken.indices.forEach { engine.ended(it) }
        assertTrue(result.await())
    }

    @Test fun anUnbrokenUtteranceIsCutHardAtTheMaximum() = runTest {
        val text = "y".repeat(9_000)
        val result = async { speaker.speak(listOf(text)) }
        runCurrent()

        assertEquals(listOf(4_000, 4_000, 1_000), engine.texts().map { it.length })
        engine.spoken.indices.forEach { engine.ended(it) }
        result.await()
    }

    @Test fun splitPrefersTheLastSpaceThatFits() {
        val pieces = Speaker.split("aaaa bbbb cccc dddd", 9)
        assertEquals(listOf("aaaa ", "bbbb ", "cccc dddd"), pieces)
        assertEquals("aaaa bbbb cccc dddd", pieces.joinToString(""))
    }

    @Test fun splitNeverCutsASurrogatePairInHalf() {
        val text = "a" + "\uD83D\uDE00".repeat(5) // 1 + 10 chars
        val pieces = Speaker.split(text, 4)
        assertEquals(text, pieces.joinToString(""))
        pieces.forEach { assertFalse(it.last().isHighSurrogate()) }
        assertTrue(pieces.all { it.length <= 4 })
    }

    @Test fun textWithinTheMaximumIsNotSplit() {
        assertEquals(listOf("x".repeat(4_000)), Speaker.split("x".repeat(4_000), 4_000))
    }

    @Test fun stopStopsTheEngineAndSpeakReturnsFalse() = runTest {
        val result = async { speaker.speak(listOf("one", "two")) }
        runCurrent()
        engine.started(0)
        speaker.stop()

        assertEquals(1, engine.stops)
        assertFalse(result.await())
        assertEquals(1, focus.abandons)
    }

    @Test fun anEndEventAfterStopDoesNotRevive() = runTest {
        val result = async { speaker.speak(listOf("one")) }
        runCurrent()
        speaker.stop()
        engine.ended(0) // the engine reports the cut-off utterance afterwards
        assertFalse(result.await())
        assertEquals(1, focus.abandons)
    }

    @Test fun stopWithNothingSpeakingStillStopsTheEngineButTouchesNoFocus() {
        speaker.stop()
        assertEquals(1, engine.stops)
        assertEquals(0, focus.abandons)
    }

    @Test fun anEndedUtteranceThatFailedStillLetsTheReadingFinish() = runTest {
        // the engine reports failed utterances as ended too (TtsEngine contract)
        val result = async { speaker.speak(listOf("one", "two")) }
        runCurrent()
        engine.ended(0)
        engine.ended(1)
        assertTrue(result.await())
    }

    @Test fun eventsForOtherIdsAreIgnored() = runTest {
        val result = async { speaker.speak(listOf("one")) }
        runCurrent()
        engine.listener!!.invoke("someone-else", true)
        runCurrent()
        assertFalse(result.isCompleted)
        engine.ended(0)
        assertTrue(result.await())
    }

    @Test fun aNewSpeakStopsTheOneInProgress() = runTest {
        val first = async { speaker.speak(listOf("old")) }
        runCurrent()
        val second = async { speaker.speak(listOf("new")) }
        runCurrent()

        assertFalse(first.await())
        assertEquals(1, engine.stops)
        assertEquals(listOf("old", "new"), engine.texts())
        assertFalse(second.isCompleted)
        engine.ended(1)
        assertTrue(second.await())
        assertEquals("focus is given back once, by the reading that is last", 1, focus.abandons)
    }

    @Test fun cancellingSpeakStopsTheEngineAndGivesFocusBack() = runTest {
        val job = async { speaker.speak(listOf("one")) }
        runCurrent()
        job.cancel()
        runCurrent()

        assertEquals(1, engine.stops)
        assertEquals(1, focus.abandons)
    }

    @Test fun blankUtterancesAreSkippedAndAllBlankFinishesAtOnce() = runTest {
        assertTrue(speaker.speak(listOf("", "   ")))
        assertEquals(0, engine.spoken.size)
        assertEquals(0, focus.requests)

        val result = async { speaker.speak(listOf("", "hello", " ")) }
        runCurrent()
        assertEquals(listOf("hello"), engine.texts())
        engine.ended(0)
        assertTrue(result.await())
    }

    @Test fun aCustomMaximumIsHonoured() = runTest {
        val small = Speaker(engine, focus, maxChars = 5)
        val result = async { small.speak(listOf("abc def ghi")) }
        runCurrent()
        assertTrue(engine.texts().all { it.length <= 5 })
        assertEquals("abc def ghi", engine.texts().joinToString(""))
        engine.spoken.indices.forEach { engine.ended(it) }
        result.await()
    }
}
