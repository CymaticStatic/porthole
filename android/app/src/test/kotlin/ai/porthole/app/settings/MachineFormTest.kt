package ai.porthole.app.settings

import ai.porthole.app.MachineStore
import ai.porthole.app.events.BackgroundPref
import ai.porthole.app.events.EventsService
import ai.porthole.app.net.HostClient
import ai.porthole.app.net.Http
import ai.porthole.shared.Machine
import ai.porthole.shared.MachineList
import ai.porthole.shared.MachineInfo
import ai.porthole.shared.You
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.runtime.collectAsState
import java.io.IOException
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

private const val BAD_ORIGIN = "Use the https address ending in .ts.net"

private fun SemanticsNodeInteraction.typed(): String =
    fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.count(text: String): Int =
    onAllNodesWithText(text).fetchSemanticsNodes().size
private const val STUDIO = "https://studio.tailafe04c.ts.net"

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MachineFormTest {
    @get:Rule
    val rule = createComposeRule()

    private val store get() = MachineStore(RuntimeEnvironment.getApplication())
    private val desk = MachineList.defaults.first()

    // --- pure rules ---------------------------------------------------------------------------------------------

    @Test
    fun badOriginsGetTheGivenOriginText() {
        for (bad in listOf("", "http://studio.tailafe04c.ts.net", "https://example.com", "https://x.ts.net:8443", "studio")) {
            val check = MachineFormRules.check(MachineList.defaults, "studio", bad, BAD_ORIGIN)
            assertEquals(bad, MachineFormRules.Check.Invalid(null, BAD_ORIGIN), check)
        }
    }

    @Test
    fun aGoodOriginIsNormalisedAndTheNameTrimmed() {
        val check = MachineFormRules.check(MachineList.defaults, "  studio ", "  https://Studio.tailafe04c.ts.net/ ", BAD_ORIGIN)
        assertEquals(MachineFormRules.Check.Valid("studio", STUDIO), check)
    }

    @Test
    fun nameProblemsGoUnderTheNameField() {
        val bad = MachineFormRules.check(MachineList.defaults, "Not Valid!", STUDIO, BAD_ORIGIN) as MachineFormRules.Check.Invalid
        assertTrue(bad.nameError!!.startsWith("Name must be"))
        assertEquals(null, bad.originError)

        val dup = MachineFormRules.check(MachineList.defaults, desk.name, STUDIO, BAD_ORIGIN) as MachineFormRules.Check.Invalid
        assertEquals("A machine called ${desk.name} already exists", dup.nameError)
        assertEquals(null, dup.originError)
    }

    @Test
    fun anAddressAlreadyInTheListGoesUnderTheAddressField() {
        val check = MachineFormRules.check(MachineList.defaults, "second-desk", desk.origin, BAD_ORIGIN) as MachineFormRules.Check.Invalid
        assertEquals(null, check.nameError)
        assertEquals("That address is already in the list", check.originError)
    }

    @Test
    fun badNameAndBadOriginAreBothReported() {
        val check = MachineFormRules.check(MachineList.defaults, "", "nope", BAD_ORIGIN) as MachineFormRules.Check.Invalid
        assertTrue(check.nameError!!.startsWith("Name must be"))
        assertEquals(BAD_ORIGIN, check.originError)
    }

    // --- the form ------------------------------------------------------------------------------------------------

    private fun showForm(store: MachineStore) = rule.setContent {
        SettingsTheme {
            val machines by store.machines.collectAsState()
            MachineForm(existing = machines, onAdd = store::add)
        }
    }

    private fun fill(name: String, origin: String) {
        rule.onNodeWithTag(TAG_NAME).performTextInput(name)
        rule.onNodeWithTag(TAG_ORIGIN).performTextInput(origin)
        rule.onNodeWithTag(TAG_ADD).performClick()
    }

    @Test
    fun invalidOriginShowsTheMessageAndStoresNothing() {
        val store = store
        showForm(store)
        fill("studio", "http://studio.tailafe04c.ts.net")
        rule.onNodeWithText(BAD_ORIGIN).assertIsDisplayed()
        assertEquals(MachineList.defaults, store.machines.value)
    }

    @Test
    fun validAddLandsInTheStoreWithTheNormalisedOriginAndClearsTheForm() {
        val store = store
        showForm(store)
        fill("studio", "https://Studio.tailafe04c.ts.net/")
        assertEquals(MachineList.defaults + Machine("studio", STUDIO), store.machines.value)
        assertEquals("", rule.onNodeWithTag(TAG_NAME).typed())
        assertEquals("", rule.onNodeWithTag(TAG_ORIGIN).typed())
        assertEquals(0, rule.count(BAD_ORIGIN))
    }

    @Test
    fun aBadNameShowsTheListRulesMessage() {
        val store = store
        showForm(store)
        fill("Not Valid!", STUDIO)
        rule.onNodeWithText("Name must be 1 to 32 characters: a-z, 0-9 and -").assertIsDisplayed()
        assertEquals(MachineList.defaults, store.machines.value)
    }

    @Test
    fun theErrorClearsWhenTheUserTypesAgain() {
        showForm(store)
        fill("studio", "nope")
        rule.onNodeWithText(BAD_ORIGIN).assertIsDisplayed()
        rule.onNodeWithTag(TAG_ORIGIN).performTextInput("x")
        assertEquals(0, rule.count(BAD_ORIGIN))
    }

    // --- the Machines screen ---------------------------------------------------------------------------------------

    private fun hostAnswering(body: String?): HostClient = HostClient(
        Http(
            OkHttpClient.Builder().addInterceptor { chain ->
                if (body == null) throw IOException("no route to host")
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(body.toResponseBody())
                    .build()
            }.build(),
        ),
    )

    private fun showScreen(store: MachineStore, host: HostClient) = rule.setContent {
        SettingsTheme { MachinesRoute(store, host) }
    }

    @Test
    fun theMachinesScreenListsTheMachinesAndRemoveTakesOneAway() {
        val store = store
        showScreen(store, hostAnswering(null))
        rule.onNodeWithText("Your computers").assertIsDisplayed()
        for (m in MachineList.defaults) {
            rule.onNodeWithTag(TAG_LIST).performScrollToNode(hasTestTag("remove-${m.name}"))
            rule.onNodeWithText(m.name).assertIsDisplayed()
            rule.onNodeWithText(m.origin).assertIsDisplayed()
        }
        rule.onNodeWithTag(TAG_LIST).performScrollToNode(hasTestTag("remove-${desk.name}"))

        rule.onNodeWithTag("remove-${desk.name}").performClick()
        assertEquals("nothing removed before the user confirms", MachineList.defaults, store.machines.value)
        rule.onNodeWithTag(TAG_CONFIRM_REMOVE).performClick()

        assertEquals(MachineList.defaults.drop(1), store.machines.value)
        assertEquals(0, rule.count(desk.name))
    }

    @Test
    fun addingFromTheScreenShowsTheNewMachineInTheList() {
        val store = store
        showScreen(store, hostAnswering(null))
        rule.onNodeWithTag(TAG_LIST).performScrollToNode(hasTestTag(TAG_NAME))
        fill("studio", STUDIO)
        rule.onNodeWithTag(TAG_LIST).performScrollToNode(hasTestTag("rename-studio"))
        rule.onNodeWithTag("rename-studio").assertIsDisplayed()
        assertTrue(store.machines.value.contains(Machine("studio", STUDIO)))
    }

    @Test
    fun renameChangesTheNameInTheStore() {
        val store = store
        showScreen(store, hostAnswering(null))
        rule.onNodeWithTag("rename-${desk.name}").performClick()
        rule.onNodeWithTag(TAG_RENAME_FIELD).performTextReplacement("${desk.name}-two")
        rule.onNodeWithTag(TAG_CONFIRM_RENAME).performClick()
        assertEquals(desk.copy(name = "${desk.name}-two"), store.machines.value.first())
    }

    @Test
    fun renameToATakenNameShowsTheReasonAndChangesNothing() {
        val store = store
        showScreen(store, hostAnswering(null))
        val other = MachineList.defaults[1].name
        rule.onNodeWithTag("rename-${desk.name}").performClick()
        rule.onNodeWithTag(TAG_RENAME_FIELD).performTextReplacement(other)
        rule.onNodeWithTag(TAG_CONFIRM_RENAME).performClick()
        rule.onNodeWithText("A machine called $other already exists").assertIsDisplayed()
        assertEquals(MachineList.defaults, store.machines.value)
    }

    @Test
    fun testConnectionShowsTheMachineNameAndThisPhonesDeviceName() {
        showScreen(store, hostAnswering("""{"name":"Desk Omarchy","you":{"device":"bencell"}}"""))
        rule.onNodeWithTag("test-${desk.name}").performClick()
        rule.waitUntil(5_000) { rule.count("Connected to Desk Omarchy. This phone shows up there as bencell.") == 1 }
    }

    @Test
    fun testConnectionShowsWhyWhenTheMachineCannotBeReached() {
        showScreen(store, hostAnswering(null))
        rule.onNodeWithTag("test-${desk.name}").performClick()
        rule.waitUntil(5_000) { rule.count("Could not connect: no route to host") == 1 }
    }

    @Test
    fun testConnectionOverwritesTheKeptDeviceNameSoARenamedDeviceShowsItsNewName() {
        val store = store
        runBlocking { store.device(desk) { Result.success(MachineInfo("Desk Omarchy", You("old-name"))) } }
        showScreen(store, hostAnswering("""{"name":"Desk Omarchy","you":{"device":"new-name"}}"""))
        rule.onNodeWithTag("test-${desk.name}").performClick()
        rule.waitUntil(5_000) { rule.count("Connected to Desk Omarchy. This phone shows up there as new-name.") == 1 }
        assertEquals("new-name", runBlocking { store.device(desk) { error("must not fetch") } })
    }

    // --- Stay connected in the background -------------------------------------------------------------------------

    private val app get() = RuntimeEnvironment.getApplication()

    @Test
    fun theBackgroundSwitchIsOnByDefaultWithAnExplanationUnderIt() {
        showScreen(store, hostAnswering(null))
        rule.onNodeWithText("Stay connected in the background").assertIsDisplayed()
        rule.onNodeWithTag(TAG_STAY_CONNECTED).assertIsOn()
        rule.onNodeWithText("When this is on, Porthole keeps a quiet connection", substring = true).assertIsDisplayed()
    }

    @Test
    fun turningTheBackgroundSwitchOffSavesItAndStopsTheServiceAndOnStartsItAgain() {
        showScreen(store, hostAnswering(null))
        rule.onNodeWithTag(TAG_STAY_CONNECTED).performClick()
        rule.onNodeWithTag(TAG_STAY_CONNECTED).assertIsOff()
        assertFalse(BackgroundPref(app).enabled)
        assertEquals(EventsService::class.java.name, shadowOf(app).nextStoppedService.component!!.className)
        assertNull("nothing started it", shadowOf(app).nextStartedService)

        rule.onNodeWithTag(TAG_STAY_CONNECTED).performClick()
        rule.onNodeWithTag(TAG_STAY_CONNECTED).assertIsOn()
        assertTrue(BackgroundPref(app).enabled)
        assertEquals(EventsService::class.java.name, shadowOf(app).nextStartedService.component!!.className)
    }

    @Test
    fun theSwitchShowsTheSavedChoiceWhenTheScreenOpens() {
        BackgroundPref(app).enabled = false
        showScreen(store, hostAnswering(null))
        rule.onNodeWithTag(TAG_STAY_CONNECTED).assertIsOff()
    }
}
