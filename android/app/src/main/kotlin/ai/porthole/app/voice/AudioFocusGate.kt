package ai.porthole.app.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager

/** The audio-focus seam of [Speaker]: ask for focus before speaking, give it back afterwards. */
interface AudioFocus {
    /** Asks other audio (music, podcasts) to duck. Speech goes ahead whether or not Android grants it. */
    fun request()

    fun abandon()
}

/** Transient-may-duck focus for speech, from the system [AudioManager]. */
class AndroidAudioFocus(context: Context) : AudioFocus {
    private val audioManager = context.applicationContext.getSystemService(AudioManager::class.java)
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .build()

    override fun request() {
        audioManager.requestAudioFocus(request)
    }

    override fun abandon() {
        audioManager.abandonAudioFocusRequest(request)
    }
}
