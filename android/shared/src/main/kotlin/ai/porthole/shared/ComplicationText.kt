package ai.porthole.shared

import kotlin.math.roundToInt

object ComplicationText {
    data class Short(val text: String, val title: String, val description: String)

    data class Ranged(val value: Float, val text: String, val description: String)

    fun waiting(state: WatchState?): Short {
        val n = state?.items?.size ?: 0
        return Short(n.toString(), "waiting", "$n waiting")
    }

    /** Highest `usedPercent` over every machine and window, 0 to 100; null when there are no windows. */
    fun usage(state: WatchState?): Ranged? {
        val highest = state?.usage?.maxOfOrNull { it.usedPercent } ?: return null
        val clamped = highest.coerceIn(0.0, 100.0)
        val n = clamped.roundToInt()
        return Ranged(clamped.toFloat(), "$n%", "Highest Claude usage $n percent")
    }
}
