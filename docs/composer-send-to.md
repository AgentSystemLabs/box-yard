# Send a draft to another chat

In a Coordinator, Captain or task composer, type `>` and search for a task, a project's Captain or the Coordinator.
Use Up/Down to choose, then Enter or Tab to select. Only the `>search` part disappears; the rest of the draft and its
attachments stay. Escape closes the list and leaves the text intact. Escape also lets you keep a literal Markdown
blockquote. Escaped `\>` and triggers inside code do not open the picker.

Cmd+Shift+Enter on macOS, or Ctrl+Shift+Enter, opens the same search in a dialog. On a touch screen use **Send to…**
(the arrow button, or its line in **More**). Picking a destination does not send anything. The selected destination,
a link to it, and **Clear destination** appear above the controls. Enter then sends the draft there. Clear returns
the draft to the current chat. Selecting a done task warns that sending will reopen it.

After a successful send, **Sent to…** links to the destination and the composer returns to its usual target. You
remain in the source chat. A failed send restores the draft, files and destination so you can retry. An unsent
destination stays with its draft when switching chats, in this tab's memory; reloading clears drafts as before.

The task's **Captain** chip still forwards with the task context and queue. **Side question** still opens the task's
separate conversation with the Coordinator. Selecting a general destination leaves those modes; pressing either
chip clears the general destination. Send to and Attach fold together before these chips, retaining their existing
15.5rem idle / 18.5rem working visibility thresholds. `%` projects, `#` GitHub references, `@` runners and `!`
harness/model/effort keep their existing behavior.

## Delivery and verification

The picker reads the existing project/task lists and reuses the three existing send mutations. Each request carries
its destination ID so changing or clearing the visible draft cannot retarget an in-flight request. Attachments use
their existing upload IDs. Server authorization, privacy, queueing and done-task behavior use the existing endpoints;
there is no new server route or agent tool.

`test/send-to.test.ts` covers parsing and target search. `test/composer-send-to.test.ts` covers all nine source/target
combinations, attachments, attachment-only sends, retry, source changes during a failed request, cancellation, clear,
IME, empty results and failed discovery. Existing Composer, Captain forwarding and prefix picker tests cover their
interaction with the feature.

The optional browser check exercises the real UI with public-safe fixtures and intercepts every write:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
  node scripts/check-composer-send-to.mjs http://localhost:4510 data/composer-proof/shots
```

Use an isolated mock server (`BOXYARD_MOCK=1`) on 4011 or higher. The check runs touch layouts at 320, 393, 400, 560
and 800 physical pixels, at 100% and emulated 125% browser zoom (a reduced CSS viewport), for idle and working tasks.
It checks fold thresholds, 44px controls, overflow, touch and typed selection, clearing, exact destination delivery
and remaining in the source chat. It saves screenshots and `checks.json`. It does not start agents.
