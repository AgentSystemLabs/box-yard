# Agent Instructions

- When doing work, please commit the work along the way in small chunk size commits with descriptive messages.
- When creating or updating a pull request, always use the `.claude/skills/pr-description` skill to draft the PR title/body so every PR uses the same review format.
- While iterating, run only affected tests: `npm run test:related` selects from the diff against the merge base with `origin/main` (including staged, unstaged and untracked files). Use `npm run test:related -- --base <ref>` for another base, or `npx vitest run <affected files>` when shared setup/config changes would select the entire suite.
- Commit before the final merge gate and keep HEAD stable: `npm run typecheck`, `npm run build`, and `npm run test:fast`. Fix failures with focused runs, then repeat the gate only if changes or unresolved failures require it. Never re-run main for a baseline or subtract its failures: green means all required checks passed.
- The Captain owns one local daily full-suite schedule (typecheck + build + `npm test`); full and slow runs are not merge gates. `npm run test:slow` selects integration coverage, while `npm run test:full` (or `npm test`) runs everything. Full, fast and slow commands all wait for the same machine-wide `~/.boxyard/locks/vitest-full` lock. Never message other tasks or the Captain about suite slots or suite completion. Focused runs use `npx vitest run <files>` and do not take the lock.
- `scripts/testTiers.ts` is the single slow inventory. New tests default fast; list end-to-end, real browser, Git/archive and full-server fixtures as slow regardless of duration, and other files over about 20 seconds. `npm run test:tiers` checks real Vitest discovery for coverage, overlap and stale entries. See `docs/testing.md` for timing and daily full-suite setup.

## Code conventions

### Server

- **MCP tool scoping.** `buildMcpServer(deps, caller)` in `server/mcp.ts` serves both the Coordinator and the per-project Captains (`caller = { kind: "captain", projectId }`). A new tool must do one of these, or a Captain can reach other projects:
  - resolve every ref through the scope helpers `project()`, `task()`, `schedule()` (and `projectFilter()` for optional filters). They throw `Out of scope: …` for another project's rows.
  - or wrap the registration in `coordinatorOnly(...)`, which removes the tool for Captains.
- **Status-only projects.** A project whose identity says "Coordinator sees: status only" shows the Coordinator its tasks' title, state and PR, never their content (`docs/identities.md`). A new tool that returns a project's content (replies, prompts, questions, errors, notes, artifacts, transcripts, history) must check `unsealed(projectId, what)` first, show tasks through `brief(t)`, and filter cross-project lists with `statusOnly()`. A tool that sets `coordinator_sees` goes through `mayLoosen`: only Cody loosens it.
- **Owner name.** Box Yard-written text that says "Cody" (prompts, labels, notices, events, tool descriptions) goes through `withOwner(text, ownerName)` from `shared/owner.ts`. In `TaskManager`/`CaptainManager` that's `withOwner(text, this.owner())`. Never apply it to user content (notes, messages, prompts).
- **Migrations.** `MIGRATIONS` in `server/db.ts` are append-only; never edit a shipped one. A test that seeds old-shaped rows stops before a specific migration by content, not by position, so later migrations don't break it:
  ```ts
  migrate(db, MIGRATIONS.findIndex((m) => m.includes("claude_usage_new")))
  ```
  Don't use `MIGRATIONS.length - 1`.
- **Notices.** `TaskManager.notice()` text has the shape `<emoji> **Title** verb: detail`, which `parseNotice` in `web/src/lib/captainTranscript.ts` reads. If you change the format or add an emoji, update `EMOJI_KIND` and `test/captain-transcript.test.ts` too.
- **Box sizes.** Per-size CPU, RAM, disk and price live only in `BOX_SIZE_SPECS` (`shared/boxSizes.ts`).
- **Box history.** Every code path that creates, resizes, deletes, loses, cleans up or sweeps a box must record it with `TaskManager.recordBoxEvent` (`server/tasks.ts`, types in `server/boxHistory.ts`), with an actor and a reason, so the box history log (#107, the `box_history` MCP tool) has no gaps.

### Web UI: shared pieces

Use these instead of hand-rolling:

| Need | Use | Where |
| --- | --- | --- |
| Any dialog, drawer or sheet | `<Modal>` (`size`, `placement="center\|top\|sheet"`, `dirty`, `onSubmit`, `footer`) | `web/src/components/Modal.tsx` |
| A Back or Close button | `<DismissButton kind="back\|close">`: Back (‹) top left for drill-ins, Close (×) top right for interruptions, never both on one surface (`docs/dismiss.md`) | `web/src/components/Modal.tsx` |
| A level inside a dialog or panel (a detail, a sub-view) | `useModalStep(active, back, label)` (or `<ModalStep>`): Esc and the header's Back leave it before the Modal closes | `Modal.tsx` |
| Yes/no prompt | `await confirmDialog({ title, body, confirmLabel, danger })`, not `window.confirm` | `web/src/lib/confirm.ts` |
| A dropdown | `<Select>` (width via `className`, `size="sm"` inline), not a raw `<select>` | `web/src/components/ui.tsx` |
| Link to another site | `<NewTabLink>`; never hand-write `target="_blank"`. It adds the ↗ (`ExternalMark`) and the URL tooltip: `mark="end"` in a flex chip, `mark={false}` only for icon buttons that already say where they go | `ui.tsx` |
| Link that may be in-app, a file or external (e.g. markdown) | `<AppLink>`, which routes by `linkTarget()` in `lib/linkify.ts` | `ui.tsx` |
| Link to an artifact or upload | `<FileLink>` / `<ArtifactLink>` (opens the preview modal; wrap lists in `{...PREVIEW_GROUP}` for the ←/→ gallery) | `web/src/components/FileLink.tsx` |
| Leading icon on a text row | `<LineIcon icon={X} className="h-4 w-4" />` in an `items-start` row, not a hand-tuned `mt-*` | `ui.tsx` |
| A chip in the task header (PR, preview, runner, files) | `HEADER_CHIP`: drawn 28px, 44px to a finger via `TAP_AREA` (use `TAP_AREA` alone on other compact controls). Chips elsewhere (cards, notices) use `META_CHIP` | `ui.tsx` |
| A list that re-sorts as it updates | `useStableOrder(items, { compare, include, resetKey })` | `web/src/lib/useStableOrder.ts` |
| Content that is still loading (a chat, a panel, a settings section) | `<Loading kind="chat\|rows\|field\|line" label>`, not a "Loading…" line or a spinner: it holds its space and shows a still skeleton only after 300 ms (`useDelayedFlag` in `lib/loading.ts`) | `web/src/components/Loading.tsx` |

- `AppLink`, `FileLink` and `NewTabLink` stop click propagation. Never wrap rendered Markdown in a `<Link>`/`<a>`: auto-linked URLs become nested anchors. Use a `role="link"` div card (see `NoticeCard` in `ChatLine.tsx`).
- Link colours: yellow = in-app, sky + ↗ = another site, PR glyph in its state colour + ↗ = a GitHub PR. A pasted GitHub PR/issue URL renders as "PR #154" / "owner/repo#154" (`shortGithubLabel` in `lib/linkify.ts`). Artifacts and uploads are in-app (preview modal, or download in place), so no ↗.
- PR links and task status: `<PrChip>` and `<StatusBadge status={badgeStatus(task)} />` from `ui.tsx` (`badgeStatus` is in `lib/prState.ts`). They show the purple Merged state, so don't hand-roll PR links.
- Settings: open it with `useOpenSettings()(section)` from `SettingsHost.tsx`. It's mounted once as `SettingsHost`, so don't render `<SettingsDialog>` yourself. New categories go in `SETTINGS_SECTIONS` (`lib/settingsNav.ts`); a panel's `Panel`/`Row`/`SourceHint` come from `SettingsBlocks.tsx`.
- `useStableOrder`: pass all candidate items and filter with `include` (pre-filtering makes rows vanish instead of dimming). `resetKey` is the sort/filter/search, never `now`.

### Web UI: performance

Long threads must stay fast while typing and while SSE events stream in.

- **The Composer owns its draft** and calls `onSubmit(text, attachments)`. Never lift the draft into `ChatPanel`, `CaptainTab` or `TaskView`. Chat footers use `COMPOSER_FOOTER` from `Composer.tsx`.
- **The transcript doesn't re-render on header or draft updates (#29).** Keep transcripts in their own memo'd component (`TaskThread` in `TaskView.tsx`). `ChatLine`, `ToolLine` and `Line` are memo'd, so keep their props stable (callbacks via `useCallback`).
- Long lists render through `useTail` (`web/src/lib/tail.ts`) plus `StickyScroll`'s `hidden`/`onLoadEarlier`, so only the newest items are in the DOM. To jump to an older chat message, call `revealChatMessage(id)` (`lib/reveal.ts`), not `getElementById`.
- `Markdown` is memo'd and cached; pass `live` for streaming text.
- **No broad `:has()` on a list's container.** A `has-[…]`/`group-has-[…]` whose argument can match any descendant (`:not(…)`, no leading `>`) makes Chrome restyle the container's whole subtree on every inserted row, which cost 50–120 ms a message in long chats (#301). Use a child-scoped `has-[>…]` on one row, or React state. Measure with `scripts/perf/long-transcript.mjs`.
- Views that read a list once (like the command palette) pass `QUIET` from `lib/queries.ts` to the list hooks, so they don't re-render on every live update.
- **Rarely opened surfaces stay out of the first load.** Settings, a project's settings and schedules load through `lazyPart` (`components/LazyPart.tsx`), warmed in the background once the app settles. Don't import from `SettingsDialog`, `ProjectView` or `Schedules` statically in code the first screen loads; `test/bundle-split.test.ts` fails if one comes back. `scripts/perf/first-load.mjs` measures it. An app-level UI test that opens one and checks it in the same render awaits `warmLazyParts()` in `beforeAll` first.
