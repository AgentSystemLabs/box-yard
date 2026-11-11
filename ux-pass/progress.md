# UX pass: progress index

Parent: task_289f839c2f5c. Feature inventory: /artifacts/art_6ff80fb12945/feature-inventory.md

Each feature sub-task runs on an Upstash box at low effort. It spawns three high-effort reviewers (Sonnet 5.5, Opus 5.5, Fable 5.2) and one Fable 5.2 (high) implementer, and runs up to 5 revisions. **Target (Cody, updated): every category averages at least 8.5** (it was 9). Every round publishes a "<Feature> UX: round N" report with the score table and before/after shots.

Status is the mean of the 8 category means (Clarity, Discoverability, Efficiency, Visual, Mobile, Accessibility, Feedback, Consistency), from the first score to the latest reported.

| # | Feature | Sub-task | Baseline | Status |
|---|---|---|---|---|
| 1 | Coordinator chat, Days date bar & side questions | [task_aa9d979da31a](/tasks/task_aa9d979da31a) | [baseline](/artifacts/art_501d5e9fb7cc/report-round-0.html) | 6.6 → 8.4, revision 4 in progress; Mobile is lowest at 8.0 ([report](/artifacts/art_a0726454872e/report-round-3.html)) |
| 2 | Captain chat | [task_8924dd5e427f](/tasks/task_8924dd5e427f) | [baseline](/artifacts/art_c6e15dcf2ade/report-round-0.html) | 7.2 → 8.7, round 3 ([report](/artifacts/art_44c431efbe1d/report-round-3.html)) |
| 3 | Task page | [task_bc4bb9285429](/tasks/task_bc4bb9285429) | [baseline](/artifacts/art_e78f8b4669e8/report-round-0.html) | 6.6 → 8.5, revision 4 in progress ([report](/artifacts/art_d00459a035d0/report-round-3.html)) |
| 4 | Composer | [task_2301a7ba8a2b](/tasks/task_2301a7ba8a2b) | [baseline](/artifacts/art_d7b2a59d6212/report-round-0.html) | 7.0 → 8.6, round 4 being scored |
| 5 | Sidebar, Inbox & navigation | [task_80a67bc0598b](/tasks/task_80a67bc0598b) | [baseline](/artifacts/art_8668f59e2f9c/report-round-0.html) | **done**: 7.0 → 8.7 after 4 revisions, [PR #48](https://github.com/AgentSystemLabs/box-yard/pull/48) |
| 6 | Command palette, shortcuts & New task | [task_c4527a4bba98](/tasks/task_c4527a4bba98) | [baseline](/artifacts/art_b238db797c71/report-round-0.html) | 6.0 → 8.2, round 3 being scored ([report](/artifacts/art_e047f176bbd0/report-round-3.html)) |
| 7 | Settings & project settings | [task_2d089595f1b8](/tasks/task_2d089595f1b8) | [baseline](/artifacts/art_eb3cd4985d5e/report-round-0.html) | 6.8 → 8.2, round 3 being scored ([report](/artifacts/art_10ec9645ec21/report-round-3.html)) |
| 8 | Schedules & Hooks | [task_b6e0b706f6df](/tasks/task_b6e0b706f6df) | [baseline](/artifacts/art_6a2d66816da9/report-round-0.html) | 6.1 → 8.6, round 2 ([report](/artifacts/art_baad85bf47ff/report-round-2.html)) |
| 9 | Usage & meters | [task_a463f3af99e6](/tasks/task_a463f3af99e6) | [baseline](/artifacts/art_6753f5439573/report-round-0.html) | 6.9 → 8.4, 3rd revision landed and round 3 being scored |
| 10 | Files, artifacts & previews | [task_ac31327224f8](/tasks/task_ac31327224f8) | [baseline](/artifacts/art_fa7de58a1a8c/report-round-0.html) | in progress, no scores reported yet |

Biggest jumps so far:
- **Command palette, Discoverability:** 4.3 → 8.0.
- **Schedules & Hooks, Accessibility:** 5.3 → 9.0.
- **Schedules & Hooks, Efficiency:** 5.0 → 8.5.

Cross-feature follow-ups (outside any one sub-task's scope):
- **Phone search button in the sidebar:** the Command palette sub-task asked for it, but the Sidebar sub-task had already finished.
- **Undo toast:** it hides under the phone drawer.
- **Folded strips at 125% zoom.**

Baseline notes:
- **New task:** only the selection popover's "More options" opens the dialog. `NewTaskButton` and `?new=task` are dead code.
- **Schedules:** they had no edit form (the Schedules sub-task added one).
- **Task page:** a pending agent question shows only as a faint line (the Task page sub-task added an ask card).
