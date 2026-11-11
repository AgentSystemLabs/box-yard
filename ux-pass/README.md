# Box Yard: user-facing features, and how this UX pass covers them

Taken from `web/src` on main at `0f51567` (Nov 11). Each **numbered feature** gets its own sub-task on its own Upstash box. Each sub-task runs up to 5 revision rounds. Three high-effort reviewers (Sonnet 5.5, Opus 5.5, Fable 5.2) score every round, and a Fable 5.2 (high) implementer makes the changes. A sub-task stops once every category averages 9 or more. Each one opens its own PR.

Score categories, 1–10 each: **Clarity · Discoverability · Efficiency · Visual design & hierarchy · Mobile & touch · Accessibility · Feedback & states · Consistency**

| # | Feature | What it covers (main components) | Left out / owned elsewhere |
|---|---|---|---|
| 1 | **Coordinator chat, Days date bar & side questions** | Centre chat (`ChatPanel`, `ChatLine` notice/task cards, `MessageActions`, `ReplySources`, `RecommendedNextSteps`, streaming reply), Days date bar and history (`ChatHistory`, `lib/chatDays`, Jump to start/end), side questions (`SideThread`, `ThreadRoute`) | Composer internals (#4) |
| 2 | **Captain chat** | `CaptainTab` (centre and side-panel headers, Captain menu, context meter, compaction history), `EmptyCaptain`, `CaptainForward`, Captain icon | Sidebar/rails (#5), composer (#4) |
| 3 | **Task page** | `TaskView`, `TaskHeader` and its chips (PR, Files, previews, context, timing, placement), transcript lines, `TaskAsk`, `TaskFailure`, `WaitReason`, `SubtaskLines`, `QueuedMessages` (Steer), `ContinueTask`, `MergePr`, `PrStatus` | Per-task cost icon (task_d8a74c55b92d); Send To / runner / harness pickers (task_b549b9089f84) |
| 4 | **Composer** | `Composer`, `ComposerMenu`, `ComposerTags`, `ComposerAttachments`, `Attachments`, `Dictation`, `GithubReferenceMenu`, `DockComposer`, prompt history | Send To, runner, harness and model pickers (task_b549b9089f84) |
| 5 | **Sidebar, Inbox & navigation** | `Sidebar` (Coordinator row, "Waiting on you" inbox, project groups, task tree, Mark done, pins), `TreeNav`, `TaskFilters`, `SidebarPane` (resize), `Rails`/`ChatBar` (folded rail), phone drawer, `ChatSwitcher`, `ResortPill`, `HistoryNavigation`, panel chrome (`OverlayHost`, `ColumnControls`) | |
| 6 | **Command palette, shortcuts & New task dialog** | `CommandPalette` (search, ranking, actions), `ShortcutsHelp`, `NewTask` dialog, `SelectionToTask` | Pickers inside New task (task_b549b9089f84) |
| 7 | **Settings & project settings** | `SettingsDialog` shell (nav, search, unsaved-draft/Save flow, phone layout) and its sections (Coordinator, Box agents, Credentials, Connectors, Identities, providers, Machines, limits, Notifications, Voice, Appearance, About), `ProjectSettings`/`ProjectSettingsDialog`, `NewProjectDialog` | Hooks section (#8) |
| 8 | **Schedules & Hooks** | `Schedules` (list, editor, schedule panel), `Hooks` (Settings › Hooks list and editor) | |
| 9 | **Usage & meters** | `UsageModal` (periods, charts, breakdowns), `CloudMeter`, `ContextMeter`, `LoginLimits` | Per-task cost icon (task_d8a74c55b92d) |
| 10 | **Files, artifacts & previews** | `TaskFiles` (Files chip panel), `FilePreview` modal (image/markdown/HTML/code, ←/→ gallery), `Lightbox`, `FileLink`/`ArtifactLink`, published-artifact notices | |

## Not covered in this run
A task can start at most 10 sub-tasks (Settings › Box agents › Sub-tasks per task), so these features are left for a second batch:

- **Onboarding & login**: `Setup` wizard, `TryFirst`, `Login`, `HealthBanner`, empty-yard state (`NoProjects`)
- **Voice**: `VoiceControl` and read-aloud (TTS) playback in chats
- **Notifications & toasts**: `Toasts`, browser notifications, app-update chips (`UpdateChips`), connection line
- **Box actions**: `BoxActionDialog`, `SizeCards` (resize, clear, delete a box)

## Project rules every sub-task keeps
- Phone-first: 44px touch targets and no hover-only controls.
- Container queries, not viewport breakpoints. Check at 320/400/560/800px and at 125% zoom.
- No new animations: the working pulse is the only one.
- Keep the accessible sidebar tree.
- Use the shared pieces (`Modal`, `DismissButton`, `Select`, `NewTabLink`, `Loading`, …).
- Keep the performance rules for long chats.
- Follow Cody's earlier product decisions (no Clear/Compact buttons, Mark done, Steer, the task-row rules, the date-bar rules, …).
