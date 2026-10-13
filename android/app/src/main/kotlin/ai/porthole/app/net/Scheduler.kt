package ai.porthole.app.net

import kotlinx.coroutines.delay

/** The one place in `:app` that owns `delay`: tests run it in `kotlinx-coroutines-test` virtual time. */
object Scheduler {
    suspend fun pause(ms: Long) = delay(ms)
}
