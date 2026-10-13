package ai.porthole.app.events

import ai.porthole.shared.InboxItem
import ai.porthole.shared.NotifyOption
import ai.porthole.shared.ServerEvent

internal const val TEST_SESSION = "tmux:/run/t.sock:main:0.0"

internal fun inboxItem(
    id: String,
    column: String = "needs-you",
    sessionId: String = TEST_SESSION,
    machine: String = "testdesk",
    archivedAt: Long? = null,
) = InboxItem(
    id = id,
    key = id,
    sessionId = sessionId,
    machine = machine,
    project = "proj",
    kind = "question",
    column = column,
    title = "Title of $id",
    body = "Body",
    question = null,
    createdAt = 1,
    updatedAt = 2,
    archivedAt = archivedAt,
)

internal fun notifyEvent(
    id: Long,
    itemId: String,
    title: String = "Question",
    body: String = "Proceed?",
    options: List<NotifyOption> = listOf(NotifyOption(0, "Yes"), NotifyOption(1, "No")),
) = ServerEvent.Notify(id, itemId, title, body, options)
