package ai.porthole.shared

/** Wear Data Layer paths and the capability the phone advertises (design decision 11). */
object WatchPaths {
    const val STATE = "/porthole/state"
    const val ANSWER = "/porthole/answer"
    const val ANSWER_RESULT = "/porthole/answer-result"
    const val REFRESH = "/porthole/refresh"
    const val PHONE_CAPABILITY = "porthole_phone"
}
