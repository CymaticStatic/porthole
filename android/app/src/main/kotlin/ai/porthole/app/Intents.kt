package ai.porthole.app

/** Every action string and intent extra key the app's own components use. */
object Intents {
    /** Broadcast from a notification answer button to `AnswerReceiver`. */
    const val ACTION_ANSWER = "ai.porthole.app.ANSWER"

    /** The machine origin (`https://<name>.ts.net`) the item belongs to. */
    const val EXTRA_ORIGIN = "ai.porthole.app.extra.ORIGIN"

    /** The inbox item id being answered. */
    const val EXTRA_ITEM = "ai.porthole.app.extra.ITEM"

    /** The option index sent to hostd. */
    const val EXTRA_INDEX = "ai.porthole.app.extra.INDEX"

    /** The button text the user tapped, shown in the "Sent: ..." result. */
    const val EXTRA_LABEL = "ai.porthole.app.extra.LABEL"

    /** The hostd notify id of the notification the button belongs to. */
    const val EXTRA_NOTIFY_ID = "ai.porthole.app.extra.NOTIFY_ID"

    /** Boolean on the intent `ShareActivity` sends to `MainActivity`: a shared file is waiting to be posted to the page. */
    const val EXTRA_SHARE = "ai.porthole.app.extra.SHARE"
}
