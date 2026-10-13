package ai.porthole.shared

import java.net.URI
import java.net.URISyntaxException

object Origins {
    private val host = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.ts\\.net$")

    /**
     * `https://<lowercase host>` for `https://<host>.ts.net` with an optional trailing `/` and optional `:443`;
     * `null` for anything else (other scheme, port, path, query, fragment, user info, wildcard, non-`.ts.net` host).
     */
    fun normalize(input: String): String? {
        val uri = try {
            URI(input.trim())
        } catch (_: URISyntaxException) {
            return null
        }
        if (uri.scheme != "https") return null
        if (uri.rawUserInfo != null) return null
        if (uri.port != -1 && uri.port != 443) return null
        if (uri.rawPath != null && uri.rawPath != "" && uri.rawPath != "/") return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        val h = uri.host?.lowercase() ?: return null
        if (!host.matches(h)) return null
        return "https://$h"
    }
}
