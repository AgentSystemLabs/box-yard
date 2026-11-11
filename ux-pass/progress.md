# UX pass: progress index

Parent: task_289f839c2f5c. Feature inventory: /artifacts/art_6ff80fb12945/feature-inventory.md

Each feature sub-task runs on an Upstash box at low effort. It spawns three high-effort reviewers (Sonnet 5.5, Opus 5.5, Fable 5.2) and one Fable 5.2 (high) implementer, and runs up to 5 revisions. **Target (Cody, updated): every category averages at least 8.5** (it was 9). Every round publishes a "<Feature> UX: round N" report with the score table and before/after shots.

Scores are the per-category means of the three reviewers, shown as lowest–highest across the 8 categories (Clarity, Discoverability, Efficiency, Visual, Mobile, Accessibility, Feedback, Consistency).

| # | Feature | Sub-task | Start | End | Revisions | PR | Merge |
|---|---|---|---|---|---|---|---|
| 1 | Coordinator chat, Days date bar & side questions | [task_aa9d979da31a](/tasks/task_aa9d979da31a) | 6.0–7.0 | 8.3–9.0 (Visual 8.3; its fix landed unscored) | 5 | [#56](https://github.com/AgentSystemLabs/box-yard/pull/56) | merged by Cody |
| 2 | Captain chat | [task_8924dd5e427f](/tasks/task_8924dd5e427f) | 6.7–7.7 | 8.7–9.0 | 4 | [#54](https://github.com/AgentSystemLabs/box-yard/pull/54) | merged (train) |
| 3 | Task page | [task_bc4bb9285429](/tasks/task_bc4bb9285429) | 6.0–7.3 | 8.8–9.0 | 5 | [#52](https://github.com/AgentSystemLabs/box-yard/pull/52) | in the merge train |
| 4 | Composer | [task_2301a7ba8a2b](/tasks/task_2301a7ba8a2b) | 6.3–7.7 | 8.3–9.0 (Discoverability 8.3) | 5 | [#49](https://github.com/AgentSystemLabs/box-yard/pull/49) | merged by Cody |
| 5 | Sidebar, Inbox & navigation | [task_80a67bc0598b](/tasks/task_80a67bc0598b) | 6.7–7.3 | 8.3–9.0 (Clarity, Efficiency, Feedback 8.3) | 4 | [#48](https://github.com/AgentSystemLabs/box-yard/pull/48) | merged (train) |
| 6 | Command palette, shortcuts & New task | [task_c4527a4bba98](/tasks/task_c4527a4bba98) | 4.3–7.0 | 8.7–9.0 | 4 | [#53](https://github.com/AgentSystemLabs/box-yard/pull/53) | merged by Cody |
| 7 | Settings & project settings | [task_2d089595f1b8](/tasks/task_2d089595f1b8) | 6.0–8.0 | 8.5–9.0 (round 4 from 2 reviewers; Fable failed) | 4 | [#50](https://github.com/AgentSystemLabs/box-yard/pull/50) | merged by Cody |
| 8 | Schedules & Hooks | [task_b6e0b706f6df](/tasks/task_b6e0b706f6df) | 5.0–7.0 | 8.7–9.0 | 3 | [#51](https://github.com/AgentSystemLabs/box-yard/pull/51) | merged (train) |
| 9 | Usage & meters | [task_a463f3af99e6](/tasks/task_a463f3af99e6) | 6.3–7.7 | 8.3–9.0 (Discoverability 8.3; revision 5 unscored) | 5 | [#55](https://github.com/AgentSystemLabs/box-yard/pull/55) | merged by Cody |
| 10 | Files, artifacts & previews | [task_ac31327224f8](/tasks/task_ac31327224f8) | 6.3–7.0 | 8.7–9.0 | 5 | [#58](https://github.com/AgentSystemLabs/box-yard/pull/58) | in the merge train |

Merge train (Cody: "work through merging the finished prs"):
- **#57:** five PRs merged without their test updates, which left main's fast suite red (132 tests in 42 files). The feature tasks fixed their own stale tests, and #57 merged all five fixes. It also makes project settings close at once again when nothing changed.
- **#48, #51, #54:** main merged in with conflicts resolved hunk by hunk, then each passed typecheck, build and `test:fast` before its squash-merge.
- **#52, #58:** their tests are being updated, then they merge the same way.

Biggest jumps:
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
