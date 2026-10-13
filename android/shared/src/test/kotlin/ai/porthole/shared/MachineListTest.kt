package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MachineListTest {
    private val desk = Machine("desk", "https://desk.example.ts.net")
    private val lap = Machine("lap", "https://lap.example.ts.net")
    private val list = listOf(desk, lap)

    @Test fun defaultsContainTheDesktopOrigin() {
        assertTrue(MachineList.defaults.contains(Machine("bendesk-omarchy", "https://bendesk-omarchy.tailafe04c.ts.net")))
        assertTrue(MachineList.defaults.all { Origins.normalize(it.origin) == it.origin })
    }

    @Test fun addNormalisesTheOrigin() {
        val r = MachineList.add(list, "third", "https://Third.Example.ts.net:443/").getOrThrow()
        assertEquals(list + Machine("third", "https://third.example.ts.net"), r)
    }

    @Test fun addRefusesBadInputWithAMessage() {
        val cases = mapOf(
            "duplicate name" to ("desk" to "https://new.example.ts.net"),
            "duplicate origin" to ("new" to "https://DESK.example.ts.net/"),
            "bad name" to ("Desk Top" to "https://new.example.ts.net"),
            "upper case name" to ("Desk" to "https://new.example.ts.net"),
            "empty name" to ("" to "https://new.example.ts.net"),
            "33 chars" to ("a".repeat(33) to "https://new.example.ts.net"),
            "http origin" to ("new" to "http://new.example.ts.net"),
            "not ts.net" to ("new" to "https://example.com"),
            "has path" to ("new" to "https://new.example.ts.net/x"),
        )
        for ((label, c) in cases) {
            val r = MachineList.add(list, c.first, c.second)
            assertTrue(label, r.isFailure)
            assertFalse(label, r.exceptionOrNull()!!.message.isNullOrBlank())
        }
        assertTrue(MachineList.add(list, "a".repeat(32), "https://new.example.ts.net").isSuccess)
    }

    @Test fun renameChangesOnlyTheName() {
        assertEquals(listOf(desk.copy(name = "office"), lap), MachineList.rename(list, "desk", "office").getOrThrow())
        assertEquals(list, MachineList.rename(list, "desk", "desk").getOrThrow())
    }

    @Test fun renameRefusesTakenUnknownAndBadNames() {
        assertTrue(MachineList.rename(list, "desk", "lap").isFailure)
        assertTrue(MachineList.rename(list, "nobody", "x").isFailure)
        assertTrue(MachineList.rename(list, "desk", "Bad Name").isFailure)
        assertFalse(MachineList.rename(list, "desk", "lap").exceptionOrNull()!!.message.isNullOrBlank())
    }

    @Test fun removeDropsOneAndIgnoresUnknown() {
        assertEquals(listOf(lap), MachineList.remove(list, "desk"))
        assertSame(list, MachineList.remove(list, "nobody"))
        assertEquals(emptyList<Machine>(), MachineList.remove(listOf(desk), "desk"))
    }

    @Test fun encodeDecodeRoundTrips() {
        assertEquals(list, MachineList.decode(MachineList.encode(list)))
        assertEquals(emptyList<Machine>(), MachineList.decode(MachineList.encode(emptyList())))
        assertEquals(MachineList.defaults, MachineList.decode(MachineList.encode(MachineList.defaults)))
    }

    @Test fun decodeFallsBackToDefaults() {
        assertEquals(MachineList.defaults, MachineList.decode("garbage"))
        assertEquals(MachineList.defaults, MachineList.decode(""))
        assertEquals(MachineList.defaults, MachineList.decode("""{"name":"x"}"""))
        assertEquals(MachineList.defaults, MachineList.decode("""[{"name":"x"}]"""))
        assertEquals(MachineList.defaults, MachineList.decode("""[{"name":"x","origin":"http://x.ts.net"}]"""))
        assertEquals(MachineList.defaults, MachineList.decode(MachineList.encode(listOf(desk, desk))))
    }
}
