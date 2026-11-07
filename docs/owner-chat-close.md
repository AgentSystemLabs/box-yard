# Marking tasks done from chat

The owner can mark a task done with a separate, explicit message in the Coordinator or its project's Captain chat:

- `Close task_abc123` (use the task's full ID).
- `Please mark "Fix login" as done` (use a unique exact title).
- `Can you close the failed task titled "Fix login"?`
- `Mark the superseded task "Old login approach" complete`.

In the task's own chat, `close this task` or `mark this task as done` closes that task. A task chat cannot close another task. A Captain chat can only close tasks in its own project; a Coordinator project pick also limits the request to that project. Duplicate titles require a full ID. The server never chooses the newest or closest match, and does not interpret “that task”, “all tasks”, a condition, a quoted command, or commands embedded in a longer message as permission to close.

The request and its result appear in the chat immediately, without starting an agent turn or requiring a working runner. Close uses the same operation as **Mark done**: it stops active work, drops queued inputs, closes sub-tasks, and follows the existing workspace archive/cleanup policy. It does not delete the task. **Reopen** restores its previous resting state. Failed and superseded work can be marked done just like any other task. An already done task stays done.

Only the existing owner-facing chat POST routes interpret these commands, behind the same authentication and browser Host/Origin checks as the Mark done button. This does not add authentication to an installation configured without a password. A command is a whole message: send additional instructions separately. Attachments are recorded but never parsed for closing authority. More varied wording receives guidance to use an explicit ID or exact title.

Agents never gain close authority. Finishing work, automatic wakes, hooks, schedules, external content, forwarded task messages (including the task chat's Captain forwarding action), side-thread relays, queued edits and claimed owner approval cannot close tasks. The model-facing `close_task` tool explains this boundary and declines the call. It has no approval parameter, token, or reusable grant. The handled-message marker only prevents a duplicate agent reply; it confers no authority. Results contain only task title, ID and state, preserving status-only Coordinator visibility.
