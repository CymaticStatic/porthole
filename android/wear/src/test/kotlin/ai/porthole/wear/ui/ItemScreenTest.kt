package ai.porthole.wear.ui

import ai.porthole.shared.WatchAnswer
import ai.porthole.shared.WatchAnswerResult
import ai.porthole.shared.WatchItem
import ai.porthole.shared.WatchState
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.wear.compose.material3.MaterialTheme
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class ScreenPort : AnswerPort {
    val answered = mutableListOf<WatchAnswer>()

    override suspend fun answer(a: WatchAnswer): WatchAnswerResult {
        answered += a
        return WatchAnswerResult(a.requestId, true, "Sent")
    }

    override suspend fun refresh() = Unit
}

private class ScreenOpener : PhoneOpener {
    val opened = mutableListOf<String>()

    override suspend fun open(uri: String): Boolean {
        opened += uri
        return true
    }
}

/** A tall screen so every row of the scrolling column is composed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h2400dp")
class ItemScreenTest {
    @get:Rule
    val rule = createComposeRule()

    private val port = ScreenPort()
    private val opener = ScreenOpener()
    private var results = 0

    private fun item(options: List<String>, multi: Boolean = false) = WatchItem(
        origin = "https://desk.example.ts.net",
        machine = "desk",
        itemId = "item-1",
        sessionId = "tmux:t:main:0.0",
        project = "porthole",
        title = "Run the tests",
        question = "Run the tests now?",
        options = options,
        multi = multi,
        updatedAt = 1_000L,
    )

    private fun show(item: WatchItem) {
        val model = InboxModel(
            source = MutableStateFlow(WatchState(1_000L, listOf(item), emptyList())),
            isStale = { false },
            port = port,
            opener = opener,
            clock = { 1_000L },
            requestIds = { "req-1" },
        )
        rule.setContent {
            MaterialTheme { ItemScreen(model, "item-1", onResult = { results++ }) }
        }
    }

    @Test
    fun showsQuestionAndOneButtonPerOption() {
        show(item(listOf("Yes", "No", "Always")))

        rule.onNodeWithText("Run the tests now?").assertIsDisplayed()
        rule.onNodeWithText("Yes").assertIsDisplayed()
        rule.onNodeWithText("No").assertIsDisplayed()
        rule.onNodeWithText("Always").assertIsDisplayed()
        rule.onNodeWithText("Open on phone").assertIsDisplayed()
        rule.onNodeWithText("Stop").assertIsDisplayed()
    }

    @Test
    fun tappingAnOptionSendsItsIndexOnceAndShowsTheResult() {
        show(item(listOf("Yes", "No", "Always")))

        rule.onNodeWithText("Always").performClick()
        rule.waitForIdle()

        assertEquals(
            listOf<WatchAnswer>(WatchAnswer.Option("req-1", "https://desk.example.ts.net", "item-1", listOf(2))),
            port.answered,
        )
        assertEquals(1, results)
    }

    @Test
    fun multiSelectItemOffersNoOptionButtonsButStillOpenOnPhone() {
        show(item(listOf("Red", "Green"), multi = true))

        rule.onNodeWithText("Red").assertDoesNotExist()
        rule.onNodeWithText("Green").assertDoesNotExist()
        rule.onNodeWithText("Open on phone").assertIsDisplayed()
    }

    @Test
    fun stopAsksFirstAndSendsNothingUntilConfirmed() {
        show(item(listOf("Yes", "No")))
        rule.onNodeWithText("Stop this session?").assertDoesNotExist()

        rule.onNodeWithText("Stop").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("Stop this session?").assertIsDisplayed()
        assertTrue(port.answered.isEmpty())
        assertEquals(0, results)

        rule.onNodeWithText("Stop").performClick()
        rule.waitForIdle()

        assertEquals(
            listOf<WatchAnswer>(WatchAnswer.Stop("req-1", "https://desk.example.ts.net", "tmux:t:main:0.0")),
            port.answered,
        )
        assertEquals(1, results)
    }

    @Test
    fun cancelLeavesTheConfirmAndSendsNothing() {
        show(item(listOf("Yes", "No")))

        rule.onNodeWithText("Stop").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Cancel").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("Stop this session?").assertDoesNotExist()
        assertTrue(port.answered.isEmpty())
        assertEquals(0, results)
    }

    @Test
    fun openOnPhoneSendsTheChatLinkToThePhone() {
        val shown = item(listOf("Yes", "No"))
        show(shown)

        rule.onNodeWithText("Open on phone").performClick()
        rule.waitForIdle()

        assertEquals(listOf(InboxModel.openOnPhoneUri(shown)), opener.opened)
        assertEquals(1, results)
    }
}
