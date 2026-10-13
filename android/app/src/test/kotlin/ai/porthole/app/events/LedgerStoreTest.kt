package ai.porthole.app.events

import ai.porthole.shared.LedgerState
import ai.porthole.shared.ShownNotify
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LedgerStoreTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val desk = "https://desk.tailafe04c.ts.net"
    private val lap = "https://lap.tailafe04c.ts.net"

    @Test
    fun aNewMachineStartsWithAnEmptyLedger() {
        assertEquals(LedgerState(), LedgerStore(context).ledger(desk).state)
    }

    @Test
    fun stateSurvivesANewInstance() {
        val store = LedgerStore(context)
        store.ledger(desk).apply {
            markShown(7, "a")
            markShown(8, "b")
            markAcked(7)
            noteNeedsYou("b")
        }
        store.save(desk)

        val reloaded = LedgerStore(context).ledger(desk).state
        assertEquals(8L, reloaded.highest)
        assertEquals(listOf(ShownNotify(7, "a"), ShownNotify(8, "b")), reloaded.shown)
        assertEquals(listOf(8L), reloaded.unacked)
        assertEquals(listOf("b"), reloaded.needsYou)
    }

    @Test
    fun eachOriginKeepsItsOwnState() {
        val store = LedgerStore(context)
        store.ledger(desk).markShown(5, "a")
        store.ledger(lap).markShown(9, "z")
        store.save(desk)
        store.save(lap)

        val reloaded = LedgerStore(context)
        assertEquals(5L, reloaded.ledger(desk).since())
        assertEquals(9L, reloaded.ledger(lap).since())
    }

    @Test
    fun theSameOriginGivesTheSameLedgerObject() {
        val store = LedgerStore(context)
        assertSame(store.ledger(desk), store.ledger(desk))
    }

    @Test
    fun changesAreNotPersistedUntilSaved() {
        val store = LedgerStore(context)
        store.ledger(desk).markShown(5, "a")

        assertEquals(0L, LedgerStore(context).ledger(desk).since())
    }

    @Test
    fun forgetRemovesTheStoredState() {
        val store = LedgerStore(context)
        store.ledger(desk).markShown(5, "a")
        store.save(desk)
        store.forget(desk)

        assertEquals(LedgerState(), LedgerStore(context).ledger(desk).state)
        assertEquals(LedgerState(), store.ledger(desk).state)
    }

    @Test
    fun aCorruptStoredStateIsReplacedByAnEmptyLedger() {
        context.getSharedPreferences("ledger", Context.MODE_PRIVATE).edit().putString(desk, "{not json").commit()

        assertEquals(LedgerState(), LedgerStore(context).ledger(desk).state)
    }
}
