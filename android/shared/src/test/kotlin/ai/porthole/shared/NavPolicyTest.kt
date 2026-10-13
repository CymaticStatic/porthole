package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Test

class NavPolicyTest {
    private val ms = listOf(Machine("desk", "https://desk.example.ts.net"))

    private fun decide(url: String) = NavPolicy.decide(url, ms)

    @Test fun configuredOriginStaysWithAnyPathOrHash() {
        assertEquals(Nav.STAY, decide("https://desk.example.ts.net/"))
        assertEquals(Nav.STAY, decide("https://desk.example.ts.net"))
        assertEquals(Nav.STAY, decide("https://desk.example.ts.net/#/chat/a/b"))
        assertEquals(Nav.STAY, decide("https://desk.example.ts.net/v1/x?y=1"))
        assertEquals(Nav.STAY, decide("https://DESK.example.ts.net:443/#/inbox"))
    }

    @Test fun previewsAndOutsideSitesGoToCustomTab() {
        assertEquals(Nav.CUSTOM_TAB, decide("https://desk.example.ts.net:8443/"))
        assertEquals(Nav.CUSTOM_TAB, decide("https://example.com/"))
        assertEquals(Nav.CUSTOM_TAB, decide("https://desk.example.ts.net.evil.com/"))
        assertEquals(Nav.CUSTOM_TAB, decide("https://desk.example.ts.net@evil.com/"))
        assertEquals(Nav.CUSTOM_TAB, decide("https://other.example.ts.net/"))
    }

    @Test fun everyOtherSchemeIsBlocked() {
        for (u in listOf(
            "http://desk.example.ts.net/", "intent://x", "javascript:alert(1)", "file:///sdcard/x", "content://x",
            "porthole://open?origin=x", "data:text/html,x", "about:blank", "", "not a url",
        )) assertEquals(u, Nav.BLOCK, decide(u))
    }

    @Test fun noMachinesMeansNothingStays() =
        assertEquals(Nav.CUSTOM_TAB, NavPolicy.decide("https://desk.example.ts.net/", emptyList()))
}
