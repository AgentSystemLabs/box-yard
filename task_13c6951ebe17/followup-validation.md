# Failed-task actions and chat focus validation

Validated source commit: `1e38938882e93b452423ef670e9b0fb46090125c`.

## Focused regressions while iterating

- Sidebar deletion, tree focus, row rendering, dialogs, shortcut handling, task headers, composer drafts and pickers: 13 files, 248 tests passed.
- Subtask tree folding and rail indentation after adding the action wrapper: 1 file, 24 tests passed.
- Final shell/phone focus change plus dialogs, dismissal, shortcuts and composer pickers: 6 files, 119 tests passed. Includes phone Coordinator, Captain and task drafts, IME, actual focus, immediate arrow navigation and unchanged route.

## Browser checks

Chrome, using intercepted example API data only. Every API write was blocked; no actual tasks were deleted or marked done. Browser contexts were closed and the preview server stopped after verification.

Checked widths: 320, 400, 560, 800 and 1440px, each at 100% and 125% scale (CSS viewport divided by the scale). No horizontal sidebar overflow and no page errors.

- Touch: real touch-event right swipe followed by hit-tested touchscreen tap, for both the selected and an unselected failed task. Delete opens confirmation without navigating. Cancel keeps the task and closes the reveal.
- Touch: the restrained hint and 44px Actions control expose the menu. Inline Delete and Mark done are hidden. Mark done and its existing Undo work from the swipe menu.
- Desktop: failed-row Delete is visible without hover, with opacity 1 and its center aligned to the Mark done check within 1px.
- All widths: failed-task header Delete opens confirmation, and the header has no harness chip.
- All widths: Escape from the task composer returns actual focus to its current row, keeps the draft and route, and the next arrow moves focus. Phone layouts open the drawer; folded desktop layouts expand as needed.
- Task details still show runner placement and the selected harness; their dialog consumes Escape first.

Per-context results: [followup-checks.json](followup-checks.json).

## Stable-HEAD final gate

All commands passed after committing, with HEAD held at the source commit above:

```text
npm run typecheck    exit 0
npm run build        exit 0
npm run test:fast    exit 0
Test Files          283 passed (283)
Tests               3319 passed (3319)
```

The final fast run took 186.37 seconds, excluding the machine-wide lock wait. No full or slow suite was run.
