package ai.porthole.shared

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

object Routes {
    private val openRoute = Regex("^#/(inbox|chat/[A-Za-z0-9._~%-]+/[A-Za-z0-9._~%-]+)$")

    /** Percent-encodes every UTF-8 byte except `A-Z a-z 0-9 - . _ ~`. */
    fun segment(s: String): String {
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xFF
            val plain = (c in 'A'.code..'Z'.code) || (c in 'a'.code..'z'.code) || (c in '0'.code..'9'.code) ||
                c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code
            if (plain) sb.append(c.toChar()) else sb.append('%').append("%02X".format(c))
        }
        return sb.toString()
    }

    private fun base(origin: String) = origin.trimEnd('/')

    fun events(origin: String, device: String, since: Long): String =
        "wss://" + base(origin).removePrefix("https://") + "/v1/events?device=" + segment(device) + "&since=" + since

    fun answer(origin: String, itemId: String): String = base(origin) + "/v1/inbox/" + segment(itemId) + "/answer"

    fun keys(origin: String, sessionId: String): String = base(origin) + "/v1/sessions/" + segment(sessionId) + "/keys"

    fun usage(origin: String): String = base(origin) + "/v1/usage"

    fun machine(origin: String): String = base(origin) + "/v1/machine"

    fun uploads(origin: String): String = base(origin) + "/v1/uploads"

    /** The watch's "Open on phone" link, e.g. `porthole://open?origin=https%3A%2F%2F...&route=%23%2Finbox`. */
    fun openLink(origin: String, route: String): String =
        "porthole://open?origin=" + segment(origin) + "&route=" + segment(route)

    /**
     * The URL to load for an `openLink`, or `null` when the scheme or host is wrong, the origin is not a
     * configured machine, or the route is not `#/inbox` / `#/chat/<part>/<part>`.
     */
    fun parseOpenLink(uri: String, machines: List<Machine>): String? {
        val parsed = try {
            URI(uri)
        } catch (_: URISyntaxException) {
            return null
        }
        if (parsed.scheme != "porthole" || parsed.host != "open") return null
        val params = HashMap<String, String>()
        for (pair in (parsed.rawQuery ?: return null).split('&')) {
            val eq = pair.indexOf('=')
            if (eq < 0) return null
            val key = pair.substring(0, eq)
            val value = try {
                URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
            } catch (_: IllegalArgumentException) {
                return null
            }
            if (params.put(key, value) != null) return null
        }
        val origin = Origins.normalize(params["origin"] ?: return null) ?: return null
        if (origin !in BridgeAllowlist.originRules(machines)) return null
        val route = params["route"] ?: return null
        if (!openRoute.matches(route)) return null
        return "$origin/$route"
    }
}
