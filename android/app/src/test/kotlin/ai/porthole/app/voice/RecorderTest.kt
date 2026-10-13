package ai.porthole.app.voice

import ai.porthole.shared.Wav
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Assert.assertTrue
import kotlinx.coroutines.yield
import org.junit.Test
import org.junit.rules.TemporaryFolder

private const val BLOCK = Recorder.BLOCK_SAMPLES // 100 ms at 16 kHz

private fun loud() = ShortArray(BLOCK) { if (it % 2 == 0) 4_000 else -4_000 }
private fun quiet() = ShortArray(BLOCK) { if (it % 2 == 0) 10 else -10 }

/** A scripted microphone: block [i] is `script(i)`; [onRead] runs while the i-th block is being read. */
private class FakeMic(
    private val script: (Int) -> ShortArray,
    private val onRead: (Int) -> Unit = {},
) : Mic {
    var reads = 0
    var stops = 0

    override fun read(buf: ShortArray): Int {
        val block = script(reads)
        block.copyInto(buf, 0, 0, minOf(block.size, buf.size))
        onRead(reads)
        reads++
        return minOf(block.size, buf.size)
    }

    override fun stop() {
        stops++
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RecorderTest {
    @get:Rule val tmp = TemporaryFolder()

    private val dir get() = File(tmp.root, "voice")

    private fun TestScope.recorder(mic: Mic, maxDataBytes: Long = Wav.maxRecordingDataBytes()) =
        Recorder(mic, dir, maxDataBytes, StandardTestDispatcher(testScheduler))

    private fun dataBytes(file: File): Int =
        ByteBuffer.wrap(file.readBytes()).order(ByteOrder.LITTLE_ENDIAN).getInt(40)

    @Test fun stopSignalEndsWithStopped() = runTest {
        val signal = MutableStateFlow(false)
        val mic = FakeMic({ loud() }, onRead = { if (it == 4) signal.value = true })
        val rec = recorder(mic).record(autoStop = false, stopSignal = signal)

        assertEquals("stopped", rec.reason)
        assertEquals(dir, rec.file.parentFile)
        assertEquals(44L + 5 * BLOCK * 2, rec.file.length())
        assertEquals(5 * BLOCK * 2, dataBytes(rec.file))
        assertArrayEquals(Wav.header(5L * BLOCK * 2), rec.file.readBytes().copyOf(44))
        assertEquals(1, mic.stops)
    }

    @Test fun anotherCoroutineFlippingTheSignalEndsItToo() = runTest {
        val signal = MutableStateFlow(false)
        val mic = FakeMic({ loud() })
        val result = async { recorder(mic).record(autoStop = false, stopSignal = signal) }
        launch { repeat(5) { yield() }; signal.value = true }
        val rec = result.await()

        assertEquals("stopped", rec.reason)
        assertTrue("it read before the signal arrived", mic.reads > 0)
        assertEquals(44L + mic.reads * BLOCK * 2, rec.file.length())
    }

    @Test fun speechThenTwoSecondsOfSilenceEndsWithSilenceWhenAutoStop() = runTest {
        val signal = MutableStateFlow(false)
        val mic = FakeMic({ if (it < 3) loud() else quiet() }, onRead = { if (it == 500) signal.value = true })
        val rec = recorder(mic).record(autoStop = true, stopSignal = signal)

        assertEquals("silence", rec.reason)
        // 3 loud blocks, then exactly 20 quiet blocks (2.0 s) end it.
        assertEquals(23, mic.reads)
        assertEquals(44L + 23 * BLOCK * 2, rec.file.length())
    }

    @Test fun silenceAloneNeverEndsItWhenAutoStopIsOff() = runTest {
        val signal = MutableStateFlow(false)
        val mic = FakeMic({ if (it < 3) loud() else quiet() }, onRead = { if (it == 199) signal.value = true })
        val rec = recorder(mic).record(autoStop = false, stopSignal = signal)

        assertEquals("stopped", rec.reason)
        assertEquals(200, mic.reads) // 20 s of audio, ten times the silence window, still recording
        assertEquals(44L + 200 * BLOCK * 2, rec.file.length())
    }

    @Test fun quietFromTheStartNeverEndsItEvenWithAutoStop() = runTest {
        val signal = MutableStateFlow(false)
        val mic = FakeMic({ quiet() }, onRead = { if (it == 99) signal.value = true })
        val rec = recorder(mic).record(autoStop = true, stopSignal = signal)

        assertEquals("stopped", rec.reason)
        assertEquals(100, mic.reads)
    }

    @Test fun theCapEndsWithLimitAndAFileOfExactlyTheCap() = runTest {
        val mic = FakeMic({ ShortArray(1_000) { 3_000 } }) // 2 000 bytes per read
        val rec = recorder(mic, maxDataBytes = 5_000).record(autoStop = false, stopSignal = MutableStateFlow(false))

        assertEquals("limit", rec.reason)
        assertEquals(44L + 5_000, rec.file.length())
        assertEquals(5_000, dataBytes(rec.file))
        assertEquals(3, mic.reads) // 2 000 + 2 000 + the 1 000 bytes that fit
        assertEquals(1, mic.stops)
    }

    @Test fun theRealCapIsTenMinutes() = runTest {
        val mic = FakeMic({ loud() })
        val rec = recorder(mic).record(autoStop = false, stopSignal = MutableStateFlow(false))

        assertEquals("limit", rec.reason)
        assertEquals(19_200_000, dataBytes(rec.file))
        assertEquals(600_000 / 100, mic.reads) // 6 000 blocks of 100 ms
        assertEquals(44L + 19_200_000, rec.file.length())
    }

    @Test fun stopForBackgroundReturnsWhatWasRecordedSoFar() = runTest {
        lateinit var r: Recorder
        val mic = FakeMic({ loud() }, onRead = { if (it == 3) r.stopForBackground() })
        r = recorder(mic)
        val rec = r.record(autoStop = true, stopSignal = MutableStateFlow(false))

        assertEquals("background", rec.reason)
        assertEquals(44L + 4 * BLOCK * 2, rec.file.length())
        assertEquals(4 * BLOCK * 2, dataBytes(rec.file))
        assertEquals(1, mic.stops)
    }

    @Test fun stopForBackgroundBeforeTheFirstReadGivesAnEmptyWav() = runTest {
        val mic = FakeMic({ loud() })
        val r = recorder(mic)
        r.stopForBackground()
        val rec = r.record(autoStop = false, stopSignal = MutableStateFlow(false))

        assertEquals("background", rec.reason)
        assertEquals(0, mic.reads)
        assertArrayEquals(Wav.header(0), rec.file.readBytes())
    }

    @Test fun cancellingDiscardsTheFileAndStopsTheMic() = runTest {
        lateinit var job: Job
        val mic = FakeMic({ loud() }, onRead = { if (it == 2) job.cancel() })
        job = launch(start = CoroutineStart.LAZY) {
            recorder(mic).record(autoStop = false, stopSignal = MutableStateFlow(false))
        }
        job.start()
        job.join()

        assertTrue(job.isCancelled)
        assertEquals(1, mic.stops)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test fun aMicReadErrorThrowsAndLeavesNoFile() = runTest {
        val mic = object : Mic {
            var stops = 0
            override fun read(buf: ShortArray) = -3
            override fun stop() { stops++ }
        }
        val e = runCatching { recorder(mic).record(autoStop = false, stopSignal = MutableStateFlow(false)) }.exceptionOrNull()
        assertTrue("expected IOException, got $e", e is IOException)
        assertTrue(e!!.message!!.contains("-3"))
        assertEquals(1, mic.stops)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test fun aRecorderIsSingleUse() = runTest {
        val signal = MutableStateFlow(true)
        val r = recorder(FakeMic({ loud() }))
        r.record(autoStop = false, stopSignal = signal)
        val e = runCatching { r.record(autoStop = false, stopSignal = signal) }.exceptionOrNull()
        assertTrue("expected IllegalStateException, got $e", e is IllegalStateException)
    }

    // ---- LastRecording -------------------------------------------------------------------------------------

    private fun clip(name: String): Recording {
        val f = File(tmp.root, name).also { it.writeBytes(Wav.header(0)) }
        return Recording(f, "stopped")
    }

    @Test fun lastRecordingIsNullBeforeAnyKeep() {
        assertNull(LastRecording().current())
    }

    @Test fun keptRecordingIsReturnedOnEveryCallUntilDelivered() {
        val last = LastRecording()
        val r = clip("a.wav")
        last.keep(r)
        assertSame(r, last.current())
        assertSame(r, last.current()) // the page may ask twice
        assertTrue(r.file.exists())

        last.delivered()
        assertNull(last.current())
        assertFalse(r.file.exists())
    }

    @Test fun aSecondKeepDeletesTheFirstFile() {
        val last = LastRecording()
        val r = clip("a.wav")
        val r2 = clip("b.wav")
        last.keep(r)
        last.keep(r2)

        assertFalse(r.file.exists())
        assertTrue(r2.file.exists())
        assertSame(r2, last.current())
    }

    @Test fun keepingTheSameFileAgainDoesNotDeleteIt() {
        val last = LastRecording()
        val r = clip("a.wav")
        last.keep(r)
        last.keep(r.copy(reason = "silence"))
        assertTrue(r.file.exists())
        assertEquals("silence", last.current()!!.reason)
    }

    @Test fun discardDeletesTheFileAndForgetsIt() {
        val last = LastRecording()
        val r = clip("a.wav")
        last.keep(r)
        last.discard()

        assertNull(last.current())
        assertFalse(r.file.exists())
    }

    @Test fun deliveredOrDiscardWithNothingKeptIsHarmless() {
        val last = LastRecording()
        last.delivered()
        last.discard()
        assertNull(last.current())
        last.keep(clip("a.wav"))
        assertNotNull(last.current())
    }
}
