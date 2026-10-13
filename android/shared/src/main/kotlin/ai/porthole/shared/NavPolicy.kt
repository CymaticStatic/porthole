package ai.porthole.shared

import java.net.URI
import java.net.URISyntaxException

enum class Nav { STAY, CUSTOM_TAB, BLOCK }

object NavPolicy {
    /**
     * A configured machine origin stays in the WebView; any other https URL (a preview on another port,
     * an outside site) goes to a Custom Tab, which has no bridge; every other scheme is blocked.
     */
    fun decide(url: String, machines: List<Machine>): Nav {
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            return Nav.BLOCK
        }
        if (uri.scheme != "https") return Nav.BLOCK
        if (uri.rawUserInfo != null) return Nav.CUSTOM_TAB
        val host = uri.host ?: return Nav.BLOCK
        val origin = Origins.normalize("https://" + host + (if (uri.port == -1) "" else ":${uri.port}"))
        return if (origin != null && origin in BridgeAllowlist.originRules(machines)) Nav.STAY else Nav.CUSTOM_TAB
    }
}
