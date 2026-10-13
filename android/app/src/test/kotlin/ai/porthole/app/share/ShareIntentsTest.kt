package ai.porthole.app.share

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShareIntentsTest {
    private val a = Uri.parse("content://media/external/images/1")
    private val b = Uri.parse("content://media/external/images/2")

    @Test
    fun singleStream() {
        val intent = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, a)
        assertEquals(listOf(a), ShareIntents.uris(intent))
        assertNull(ShareIntents.text(intent))
    }

    @Test
    fun multipleStreams() {
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE)
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(a, b))
        assertEquals(listOf(a, b), ShareIntents.uris(intent))
    }

    @Test
    fun textOnly() {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "https://example.com/x")
        assertEquals(emptyList<Uri>(), ShareIntents.uris(intent))
        assertEquals("https://example.com/x", ShareIntents.text(intent))
    }

    @Test
    fun blankTextIsNoText() {
        val intent = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "  \n")
        assertNull(ShareIntents.text(intent))
    }

    @Test
    fun clipDataOnly() {
        val intent = Intent(Intent.ACTION_SEND)
        intent.clipData = ClipData.newRawUri("shared", a).apply { addItem(ClipData.Item(b)) }
        assertEquals(listOf(a, b), ShareIntents.uris(intent))
    }

    @Test
    fun clipDataTextWithoutUriIsTheText() {
        val intent = Intent(Intent.ACTION_SEND)
        intent.clipData = ClipData.newPlainText("shared", "hello from a note")
        assertEquals(emptyList<Uri>(), ShareIntents.uris(intent))
        assertEquals("hello from a note", ShareIntents.text(intent))
    }

    @Test
    fun theSameUriInExtraAndClipDataIsListedOnce() {
        val intent = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, a)
        intent.clipData = ClipData.newRawUri("shared", a)
        assertEquals(listOf(a), ShareIntents.uris(intent))
    }

    @Test
    fun onlyContentUrisAreAccepted() {
        val ours = Uri.parse("file:///data/data/ai.porthole.app/shared_prefs/machines.xml")
        val web = Uri.parse("https://example.com/x.png")
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE)
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(ours, a, web))
        assertEquals(listOf(a), ShareIntents.uris(intent))
    }

    @Test
    fun otherActionsShareNothing() {
        val intent = Intent(Intent.ACTION_VIEW).putExtra(Intent.EXTRA_STREAM, a).putExtra(Intent.EXTRA_TEXT, "x")
        assertEquals(emptyList<Uri>(), ShareIntents.uris(intent))
        assertNull(ShareIntents.text(intent))
    }

    private val openList = """
        [{"machine":"desk","sessionId":"tmux:x:0","view":"term"},
         {"machine":"desk","sessionId":"tmux:x:1.2","view":"chat"}]
    """.trimIndent()

    @Test
    fun lastChatRouteTakesTheFirstChatEntryNotTheNewerTerminal() {
        assertEquals("#/chat/desk/tmux%3Ax%3A1.2", ShareIntents.lastChatRoute(openList, "desk"))
    }

    @Test
    fun lastChatRouteForAnotherMachineIsTheInbox() {
        assertEquals("#/inbox", ShareIntents.lastChatRoute(openList, "laptop"))
    }

    @Test
    fun lastChatRouteWithNoUsableListIsTheInbox() {
        for (bad in listOf(null, "", "not json", "{}", "[]", "\"chat\"", "null")) {
            assertEquals("for $bad", "#/inbox", ShareIntents.lastChatRoute(bad, "desk"))
        }
    }

    @Test
    fun lastChatRouteSkipsMalformedAndOtherMachineEntries() {
        val json = """
            [1, "x", null, [], {"machine":"desk","view":"chat"},
             {"machine":"desk","sessionId":5,"view":"chat"},
             {"machine":"laptop","sessionId":"s1","view":"chat"},
             {"machine":"desk","sessionId":"s2","view":"Chat"},
             {"machine":"desk","sessionId":"s3 x/y","view":"chat"},
             {"machine":"desk","sessionId":"s4","view":"chat"}]
        """.trimIndent()
        assertEquals("#/chat/desk/s3%20x%2Fy", ShareIntents.lastChatRoute(json, "desk"))
    }

    @Test
    fun lastChatRouteEncodesTheMachineName() {
        val json = """[{"machine":"my desk","sessionId":"a","view":"chat"}]"""
        assertEquals("#/chat/my%20desk/a", ShareIntents.lastChatRoute(json, "my desk"))
    }
}
