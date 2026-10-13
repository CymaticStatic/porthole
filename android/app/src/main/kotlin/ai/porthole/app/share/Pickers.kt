package ai.porthole.app.share

import ai.porthole.app.Graph
import ai.porthole.shared.Machine
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** A file now on the machine: [path] there, [name] as the user knows it. This is the bridge's `pickFile` reply. */
data class PickedFile(val path: String, val name: String)

/**
 * Backs the bridge's `pickFile({source})` with three sources: `camera`, `photo` and `file` (the page pastes from the
 * clipboard itself). Create it while [activity] is still before `STARTED` (the launchers register in the constructor),
 * and call [pick] from the main thread. The chosen file goes to the machine the bridge resolved from the verified
 * origin, through [uploads].
 */
class Pickers(
    private val activity: ComponentActivity,
    private val uploads: Uploads = Graph.once<Uploads> { Uploads(Graph.host) },
    registry: ActivityResultRegistry = activity.activityResultRegistry,
) {
    private val lock = Mutex()
    private var waiting: CompletableDeferred<Uri?>? = null
    private var cameraUri: Uri? = null

    private val camera = activity.registerForActivityResult(ActivityResultContracts.TakePicture(), registry) { taken ->
        settle(if (taken) cameraUri else null)
    }
    private val photo = activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia(), registry, ::settle)
    private val file = activity.registerForActivityResult(ActivityResultContracts.OpenDocument(), registry, ::settle)

    /**
     * Opens the picker for [source], uploads the choice to [m] and returns it, or returns `null` when the user backs
     * out. An upload that fails (too big, unreachable) throws, so the bridge can tell the page why.
     * @throws IllegalArgumentException `Unknown source` for anything but `camera`, `photo` and `file`.
     */
    suspend fun pick(source: String, m: Machine): PickedFile? {
        require(source in SOURCES) { "Unknown source" }
        return lock.withLock {
            var shot: File? = null
            try {
                val chosen = CompletableDeferred<Uri?>()
                waiting = chosen
                when (source) {
                    "camera" -> {
                        shot = newPhotoFile()
                        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", shot)
                        cameraUri = uri
                        camera.launch(uri)
                    }
                    "photo" -> photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    else -> file.launch(arrayOf("*/*"))
                }
                val uri = chosen.await() ?: return@withLock null
                val done = uploads.upload(m, uri, activity.contentResolver).getOrThrow()
                PickedFile(done.path, done.name)
            } finally {
                waiting = null
                cameraUri = null
                shot?.delete()
            }
        }
    }

    private fun settle(uri: Uri?) {
        waiting?.complete(uri)
    }

    /** `cacheDir/camera/` holds nothing between shots: the previous photo, if a crash left one, goes first. */
    private fun newPhotoFile(): File {
        val dir = File(activity.cacheDir, "camera")
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        return File.createTempFile("photo-", ".jpg", dir)
    }

    private companion object {
        val SOURCES = setOf("camera", "photo", "file")
    }
}
