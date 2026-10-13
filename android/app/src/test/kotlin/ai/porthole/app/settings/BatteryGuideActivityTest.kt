package ai.porthole.app.settings

import android.content.Intent
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BatteryGuideActivityTest {
    @get:Rule
    val rule = createAndroidComposeRule<BatteryGuideActivity>()

    private val limited = "Android may stop Porthole when the screen is off."
    private val allowed = "Android is not limiting Porthole. You are all set."

    private fun nextStarted(): Intent? = shadowOf(rule.activity).nextStartedActivity

    @Test
    fun theButtonAsksAndroidToLeavePortholeAloneForThisPackage() {
        rule.onNodeWithText("Keep Porthole running").assertIsDisplayed()
        assertNull("nothing starts before the tap", nextStarted())

        rule.onNodeWithTag(TAG_BATTERY_BUTTON).performClick()

        val intent = nextStarted()!!
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, intent.action)
        assertEquals("package:ai.porthole.app", intent.data.toString())
    }

    @Test
    fun theScreenSaysAndroidMayStopPortholeWhileItIsNotExempt() {
        rule.onNodeWithText(limited).assertIsDisplayed()
    }

    @Test
    fun theResultIsReadAgainWhenTheUserComesBack() {
        val power = shadowOf(rule.activity.getSystemService(PowerManager::class.java))
        rule.onNodeWithText(limited).assertIsDisplayed()

        power.setIgnoringBatteryOptimizations("ai.porthole.app", true)
        rule.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        rule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)

        rule.onNodeWithText(allowed).assertIsDisplayed()
    }
}
