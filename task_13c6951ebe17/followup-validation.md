# Failed task actions and chat focus

Source commit: d587331 (failed-task-actions-and-chat-focus).

## Reproduction

A running browser with a failed task containing five queued messages reproduced both entry points: no confirmation, no DELETE request and no visible toast. The shared resting-delete guard rejected any pending input; its info toast was filtered out by quiet mode. Original regression fixtures had zero queued inputs. This fixture matches the reported failed-plus-queued state; the cropped screenshot did not establish the clicked task's identity.

## Verification

- Three deletion regression files: 95 tests passed.
- Eight affected UI/API, modal, composer and shortcut files: 169 tests passed.
- Held-delivery API regression rerun: 15 tests passed.
- Disposable real API/database browser checks at 1440px and 400px: header plus selected/unselected row actions opened the shared confirmation; Cancel preserved all five inputs with no DELETE; confirm sent exactly one DELETE with consented message count, received HTTP 200 and removed rows and inputs from SQLite and subsequent GET /api/tasks.
- Real right-swipe then touchscreen tap covered selected/unselected phone rows.
- Separate held-delivery and late-input browser cases received HTTP 409, displayed actionable shared dialogs and preserved every row/input.
- Layout/focus checks: 320/400/560/800/1440px at 100%/125%, restrained touch hint, menu-only phone Mark done, Undo, visible aligned desktop Delete, no harness header chip, runner/harness details retained, actual current-row focus on Escape, immediate arrow navigation, draft/route retained, dialog priority, no overflow or page errors.
- Combined-main row/tree regression rerun: four files, 141 tests passed.
- Native PR link pointer/keyboard activation, folded rows and title navigation passed at 1440px mouse and 400px touch, with no page errors. The browser checker measures visible trailing controls because touch Mark done now lives in its menu.
- Production tasks and queued messages were untouched. Only isolated example fixtures were deleted.

## Stable-HEAD gate

On committed HEAD `d587331bd7fb4b8bef4f90df4e3984d185c8d7dd`, `npm run typecheck`, `npm run build` and `npm run test:fast` all passed; fast coverage: 284 files, 3,352 tests. HEAD remained stable and the source worktree was clean throughout the gate.
