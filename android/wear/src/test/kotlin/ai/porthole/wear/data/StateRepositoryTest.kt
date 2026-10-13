package ai.porthole.wear.data

import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import ai.porthole.shared.WatchUsage
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class StateRepositoryTest {
    private lateinit var context: Context

    private val item = WatchItem(
        origin = "https://desk.ts.net",
        machine = "desk",
        itemId = "i1",
        sessionId = "tmux:t:main:0.0",
        project = "porthole",
        title = "Run tests?",
        question = "Run the tests?",
        options = listOf("Yes", "No"),
        multi = false,
        updatedAt = 5_000,
    )
    private val state = WatchState(
        updatedAt = 1_000_000,
        items = listOf(item),
        usage = listOf(WatchUsage("desk", "5h", 72.0, null)),
    )

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        File(context.filesDir, StateRepository.FILE_NAME).delete()
    }

    @Test
    fun startsEmpty() {
        assertNull(StateRepository(context).state.value)
    }

    @Test
    fun updateStoresTheStateInTheFlow() {
        val repo = StateRepository(context)

        assertTrue(repo.update(state.encode()))

        assertEquals(state, repo.state.value)
    }

    @Test
    fun stateSurvivesANewInstance() {
        StateRepository(context).update(state.encode())

        assertEquals(state, StateRepository(context).state.value)
    }

    @Test
    fun badBytesAreIgnoredAndKeepTheLastGoodState() {
        val repo = StateRepository(context)
        repo.update(state.encode())

        assertFalse(repo.update("not a state".toByteArray()))
        assertFalse(repo.update(ByteArray(0)))
        assertFalse(repo.update("""{"updatedAt":1}""".toByteArray()))

        assertEquals(state, repo.state.value)
        assertEquals(state, StateRepository(context).state.value)
    }

    @Test
    fun badBytesOnAnEmptyRepositoryLeaveItEmpty() {
        val repo = StateRepository(context)

        assertFalse(repo.update("{".toByteArray()))

        assertNull(repo.state.value)
        assertFalse(File(context.filesDir, StateRepository.FILE_NAME).exists())
    }

    @Test
    fun aCorruptSavedFileIsIgnoredAtStart() {
        File(context.filesDir, StateRepository.FILE_NAME).writeText("garbage")

        assertNull(StateRepository(context).state.value)
    }

    @Test
    fun isStaleOnlyWhenOlderThan15Minutes() {
        val repo = StateRepository(context)
        repo.update(state.encode())
        val fifteenMinutes = 15 * 60_000L

        assertFalse(repo.isStale(state.updatedAt))
        assertFalse(repo.isStale(state.updatedAt + fifteenMinutes))
        assertTrue(repo.isStale(state.updatedAt + fifteenMinutes + 1))
        assertTrue(repo.isStale(state.updatedAt + 60 * 60_000L))
    }

    @Test
    fun isNotStaleWithoutAState() {
        assertFalse(StateRepository(context).isStale(Long.MAX_VALUE))
    }

    @Test
    fun handlerStoresGoodStateAndSignalsOnceButIgnoresBadBytes() {
        val repo = StateRepository(context)
        var signals = 0
        val handler = WearDataHandler(repo, PendingAnswers()) { signals++ }

        handler.onStateBytes("nope".toByteArray())
        assertEquals(0, signals)
        assertNull(repo.state.value)

        handler.onStateBytes(state.encode())
        assertEquals(1, signals)
        assertEquals(state, repo.state.value)
    }
}
