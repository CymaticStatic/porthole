package ai.porthole.app.events

import android.app.Application
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BootReceiverTest {
    private val app: Application get() = RuntimeEnvironment.getApplication()

    private fun started(action: String): Intent? {
        BootReceiver().onReceive(app, Intent(action))
        return shadowOf(app).nextStartedService
    }

    @Test
    fun bootCompletedStartsTheEventsService() {
        val intent = started(Intent.ACTION_BOOT_COMPLETED)!!
        assertEquals(EventsService::class.java.name, intent.component!!.className)
    }

    @Test
    fun packageReplacedStartsTheEventsService() {
        val intent = started(Intent.ACTION_MY_PACKAGE_REPLACED)!!
        assertEquals(EventsService::class.java.name, intent.component!!.className)
    }

    @Test
    fun whileStayConnectedIsOffNeitherBootNorAnUpdateStartsTheService() {
        BackgroundPref(app).enabled = false
        assertNull(started(Intent.ACTION_BOOT_COMPLETED))
        assertNull(started(Intent.ACTION_MY_PACKAGE_REPLACED))
    }

    @Test
    fun anyOtherActionStartsNothing() {
        assertNull(started(Intent.ACTION_USER_PRESENT))
        assertNull(started("com.example.BOOT_COMPLETED"))
    }
}
