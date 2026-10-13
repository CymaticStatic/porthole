package ai.porthole.shared

/** Reconnect delays 1, 2, 4, 8, then [capMs] (15 s) until [reset]; [nudge] retries at once and restarts the schedule. */
class Backoff(private val capMs: Long = 15_000) {
    private var attempt = 0

    fun nextDelayMs(): Long = minOf(1_000L shl minOf(attempt, 4), capMs).also { if (attempt < 30) attempt++ }

    fun reset() {
        attempt = 0
    }

    /** Android reported a network change: retry now (SPEC 4.13). */
    fun nudge(): Long {
        reset()
        return 0
    }
}
