package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAllowlistTest {
    private val ms = listOf(Machine("desk", "https://desk.example.ts.net"), Machine("lap", "https://LAP.example.ts.net/"))

    @Test fun rulesAreExactNormalisedOrigins() =
        assertEquals(setOf("https://desk.example.ts.net", "https://lap.example.ts.net"), BridgeAllowlist.originRules(ms))

    @Test fun configuredMainFrameGetsBridge() {
        assertTrue(BridgeAllowlist.allows("https://desk.example.ts.net", true, ms))
        assertTrue(BridgeAllowlist.allows("https://lap.example.ts.net:443", true, ms))
    }

    @Test fun unknownOriginsGetNoBridge() {
        for (o in listOf(
            "https://evil.example.ts.net", "http://desk.example.ts.net", "https://desk.example.ts.net:8443",
            "https://desk.example.ts.net.evil.com", "https://xdesk.example.ts.net", "https://desk.example.ts.net@evil.com",
            "null", "", "file://", "content://ai.porthole.app.files", "about:blank", "data:text/html,x",
        )) assertFalse(o, BridgeAllowlist.allows(o, true, ms))
        assertFalse(BridgeAllowlist.allows(null, true, ms))
    }

    @Test fun subframesGetNoBridgeEvenFromAllowedOrigin() = assertFalse(BridgeAllowlist.allows("https://desk.example.ts.net", false, ms))

    @Test fun invalidConfiguredOriginsAddNoRule() =
        assertEquals(emptySet<String>(), BridgeAllowlist.originRules(listOf(Machine("x", "https://*.ts.net"), Machine("y", "http://y.ts.net"))))

    @Test fun noMachinesMeansNoBridgeAnywhere() =
        assertFalse(BridgeAllowlist.allows("https://desk.example.ts.net", true, emptyList()))

    @Test fun normalizeRefusesWildcardsAndPaths() {
        assertNull(Origins.normalize("https://*.example.ts.net"))
        assertNull(Origins.normalize("https://desk.example.ts.net/x"))
        assertNull(Origins.normalize("https://desk.example.ts.net?q"))
        assertEquals("https://desk.example.ts.net", Origins.normalize("https://DESK.example.ts.net:443/"))
    }
}
