package ai.porthole.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginsTest {
    private val o = "https://desk.example.ts.net"
    private val ms = listOf(Machine("desk", o))

    @Test fun normalizeAcceptsPlainOrigins() {
        assertEquals(o, Origins.normalize(o))
        assertEquals(o, Origins.normalize("$o/"))
        assertEquals(o, Origins.normalize("$o:443"))
        assertEquals(o, Origins.normalize("https://Desk.Example.TS.NET:443/"))
    }

    @Test fun normalizeRefusesEverythingElse() {
        for (bad in listOf(
            "http://desk.example.ts.net", "$o:8443", "$o/x", "$o/?q=1", "$o#f", "https://u@desk.example.ts.net",
            "https://example.com", "https://ts.net", "https://*.example.ts.net", "ftp://desk.example.ts.net",
            "desk.example.ts.net", "", "https://", "https://desk.example.ts.net.evil.com", "https://desk_x.example.ts.net",
        )) assertNull(bad, Origins.normalize(bad))
    }

    @Test fun eventsUrlIsWssWithDeviceAndSince() =
        assertEquals("wss://desk.example.ts.net/v1/events?device=bencell&since=12", Routes.events(o, "bencell", 12))

    @Test fun otherUrlsEncodeSegments() {
        assertEquals("https://desk.example.ts.net/v1/sessions/tmux%3At%3Amain%3A0.0/keys", Routes.keys(o, "tmux:t:main:0.0"))
        assertTrue(Routes.answer(o, "a b").endsWith("/v1/inbox/a%20b/answer"))
        assertEquals("https://desk.example.ts.net/v1/usage", Routes.usage(o))
        assertEquals("https://desk.example.ts.net/v1/machine", Routes.machine("$o/"))
        assertEquals("https://desk.example.ts.net/v1/uploads", Routes.uploads(o))
    }

    @Test fun segmentKeepsOnlyUnreservedAndEncodesUtf8() {
        assertEquals("AZaz09-._~", Routes.segment("AZaz09-._~"))
        assertEquals("%2F%3F%23%25%20", Routes.segment("/?#% "))
        assertEquals("%C3%A9", Routes.segment("\u00e9"))
    }

    @Test fun openLinkRoundTrip() {
        val link = Routes.openLink(o, "#/chat/desk/tmux%3Ax%3A0")
        assertEquals("porthole://open?origin=https%3A%2F%2Fdesk.example.ts.net&route=%23%2Fchat%2Fdesk%2Ftmux%253Ax%253A0", link)
        assertEquals("https://desk.example.ts.net/#/chat/desk/tmux%3Ax%3A0", Routes.parseOpenLink(link, ms))
        assertEquals("https://desk.example.ts.net/#/inbox", Routes.parseOpenLink(Routes.openLink(o, "#/inbox"), ms))
    }

    @Test fun openLinkRefusesAnythingUnexpected() {
        val org = "origin=https%3A%2F%2Fdesk.example.ts.net"
        for (bad in listOf(
            "porthole://open?origin=https%3A%2F%2Fother.example.ts.net&route=%23%2Finbox",
            "porthole://open?$org&route=%23%2Fterm%2Fa%2Fb",
            "porthole://open?$org&route=%23%2Fchat%2Fa%2F..%2Fb",
            "porthole://open?$org&route=javascript%3Aalert(1)",
            "porthole://open?$org&route=%23%2Finbox%2Fitem1",
            "porthole://open?$org&route=%23%2Fchat%2Fa",
            "porthole://open?$org&route=%23%2Fchat%2F%2Fb",
            "porthole://open?$org&route=%23%2Fchat%2Fa%2Fb%2Fc",
            "porthole://open?$org&route=%23%2Finbox&route=%23%2Finbox",
            "porthole://open?$org",
            "porthole://open?route=%23%2Finbox",
            "porthole://open",
            "file://open?$org&route=%23%2Finbox",
            "https://open/?$org&route=%23%2Finbox",
            "porthole://evil?$org&route=%23%2Finbox",
            "porthole://open?origin=http%3A%2F%2Fdesk.example.ts.net&route=%23%2Finbox",
            "not a uri",
        )) assertNull(bad, Routes.parseOpenLink(bad, ms))
    }
}
