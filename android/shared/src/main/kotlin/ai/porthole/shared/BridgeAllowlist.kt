package ai.porthole.shared

object BridgeAllowlist {
    /** Exactly the origin rules `WebViewCompat.addWebMessageListener` receives: normalised origins, no wildcard. */
    fun originRules(machines: List<Machine>): Set<String> =
        machines.mapNotNull { Origins.normalize(it.origin) }.toSet()

    /** True only for a main frame whose normalised origin is one of the configured machines. */
    fun allows(sourceOrigin: String?, isMainFrame: Boolean, machines: List<Machine>): Boolean {
        if (!isMainFrame || sourceOrigin == null) return false
        val origin = Origins.normalize(sourceOrigin) ?: return false
        return origin in originRules(machines)
    }
}
