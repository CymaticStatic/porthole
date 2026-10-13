package ai.porthole.app

import ai.porthole.shared.Machine
import ai.porthole.shared.MachineInfo
import ai.porthole.shared.MachineList
import ai.porthole.shared.You
import android.content.Context
import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MachineStoreTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val desk = Machine("bendesk-omarchy", "https://bendesk-omarchy.tailafe04c.ts.net")
    private val other = "https://studio.tailafe04c.ts.net"

    @Test
    fun firstRunHoldsTheDefaultMachines() {
        assertEquals(MachineList.defaults, MachineStore(context).machines.value)
    }

    @Test
    fun addedMachineSurvivesANewStoreInstance() {
        val store = MachineStore(context)
        val result = store.add("studio", other)
        assertTrue(result.isSuccess)
        val expected = MachineList.defaults + Machine("studio", other)
        assertEquals(expected, store.machines.value)
        assertEquals(expected, MachineStore(context).machines.value)
    }

    @Test
    fun removedMachineStaysRemovedInANewStoreInstance() {
        val store = MachineStore(context)
        store.remove("benacer-omarchy")
        assertEquals(listOf(desk), store.machines.value)
        assertEquals(listOf(desk), MachineStore(context).machines.value)
    }

    @Test
    fun removingEveryMachineLeavesAnEmptyListNotTheDefaults() {
        val store = MachineStore(context)
        MachineList.defaults.forEach { store.remove(it.name) }
        assertEquals(emptyList<Machine>(), MachineStore(context).machines.value)
    }

    @Test
    fun renameSurvivesANewStoreInstance() {
        val store = MachineStore(context)
        assertTrue(store.rename("benacer-omarchy", "laptop").isSuccess)
        assertEquals(
            listOf(desk, Machine("laptop", MachineList.defaults[1].origin)),
            MachineStore(context).machines.value,
        )
    }

    @Test
    fun refusedChangeReportsTheReasonAndStoresNothing() {
        val store = MachineStore(context)
        val result = store.add("Desk Top", other)
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.startsWith("Name must be"))
        assertTrue(store.add("studio", "http://studio.tailafe04c.ts.net").isFailure)
        assertTrue(store.rename("nobody", "x").isFailure)
        assertEquals(MachineList.defaults, store.machines.value)
        assertEquals(MachineList.defaults, MachineStore(context).machines.value)
    }

    @Test
    fun deviceFallsBackToBencellWhenTheMachineCannotBeReached() = runTest {
        val store = MachineStore(context)
        assertEquals("bencell", store.device(desk) { Result.failure(IOException("down")) })
    }

    @Test
    fun deviceFallsBackToBencellWhenTheMachineReportsNone() = runTest {
        val store = MachineStore(context)
        assertEquals("bencell", store.device(desk) { Result.success(MachineInfo("bendesk-omarchy", null)) })
        assertEquals("bencell", store.device(desk) { Result.success(MachineInfo("bendesk-omarchy", You(null))) })
        assertEquals("bencell", store.device(desk) { Result.success(MachineInfo("bendesk-omarchy", You(" "))) })
    }

    @Test
    fun deviceIsFetchedOnceThenKeptEvenByANewStoreInstance() = runTest {
        var fetches = 0
        val fetch: suspend (Machine) -> Result<MachineInfo> = {
            fetches++
            Result.success(MachineInfo(it.name, You("pixel-7-pro")))
        }
        assertEquals("pixel-7-pro", MachineStore(context).device(desk, fetch))
        assertEquals("pixel-7-pro", MachineStore(context).device(desk, fetch))
        assertEquals(1, fetches)
    }

    @Test
    fun aFailedFetchIsNotKeptSoTheNextCallAsksAgain() = runTest {
        val store = MachineStore(context)
        assertEquals("bencell", store.device(desk) { Result.failure(IOException("down")) })
        assertEquals("pixel", store.device(desk) { Result.success(MachineInfo(it.name, You("pixel"))) })
    }

    @Test
    fun removingAMachineForgetsItsDevice() = runTest {
        val store = MachineStore(context)
        assertEquals("pixel", store.device(desk) { Result.success(MachineInfo(it.name, You("pixel"))) })
        store.remove(desk.name)
        store.add(desk.name, desk.origin)
        assertEquals("phone-2", store.device(desk) { Result.success(MachineInfo(it.name, You("phone-2"))) })
    }
}
