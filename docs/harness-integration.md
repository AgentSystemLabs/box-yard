# Harness integration inventory

This is the integration checklist for adding a task harness, mapped from the Claude Code, Codex and Cursor implementations before adding OpenCode. The shared `AGENT_CLIS` registry drives accepted API/MCP values and ordinary harness selects; it does **not** imply manager support or equal CLI capabilities. Keep this inventory with a new adapter's regression tests.

| Surface | Actual integration points | OpenCode requirement |
| --- | --- | --- |
| Identity, validation, legacy defaults | `shared/agentCli.ts`; `server/store.ts`, `server/app.ts`, `server/mcp.ts`; persisted `agent_cli` | Add to task registry, preserve null → Claude, leave manager allowlist explicit |
| Defaults, env overrides, draft/save/search | `shared/types.ts`, `shared/harnessDefaults.ts`, `server/settings.ts`, `web/src/components/SettingsDialog.tsx`, `web/src/lib/settingsNav.ts`; drafts registered by `settingsDraft.ts` | Independent model default; no live default edits; draft until Save |
| Project/new task/continuation/composer picks | `NewProjectDialog.tsx`, `ProjectView.tsx`, `NewTask.tsx`, `RunTargetMenu.tsx`, `shared/runTargets.ts`, `shared/harnessPicks.ts`, `server/runTargets.ts` | Show OpenCode, preserve explicit harness and provider/model, no Claude model/effort leakage |
| Model routing and effort | `server/routing.ts`, `TaskManager.agentSettings`, `cliForModel`, `continueTask` | Provider/model IDs route to OpenCode; provider variant stays explicit; generic effort unsupported |
| CLI detection and auth guidance | `server/config.ts`, `server/localCheck.ts`, `shared/setup.ts`, `server/setup.ts`, `server/turnCredentials.ts` | Detect configurable binary, scoped login, actionable missing/auth errors |
| Local/SSH placement | `server/machines/probe.ts`, `service.ts`, `shared/machines.ts`, `web/src/lib/machines.ts`, `TaskManager.machineAgentFor` | Detect OpenCode without installing on owner machines; old probe rows remain valid |
| Isolated providers | `server/providers/*`, `TaskManager.ensureCodex/ensureCursor`, `requireRunner`, `dockerTaskProblem` | Upstash/Docker/RunPod/Vast/Daytona use the common runner; install only in managed sandboxes, require credentials |
| Execution/stop/errors/events | `runner/box-runner.mjs` `runTurn`, `activeChild`, signal handling; `server/bus.ts`, `TaskManager.applyEvent`; `web/src/lib/failure.ts` | Dedicated noninteractive adapter; normalize completed text/tools, fail on error/empty output, no harness fallback |
| Session/resume/continue/switch | runner session state; `shared/taskContinuation.ts`, `TaskManager.continueTask`, resume/archive restoration | Record CLI-generated session ID; explicit session resume; existing handoff/recap mechanism |
| Usage/context/limits | runner `turn_end`; `TaskManager.recordUsage`, `server/usage.ts`, `shared/usageLedger.ts`, `shared/loginLimits.ts` | Sum per-step tokens/cost once per run; do not treat as Claude session cumulative totals; unknown window/limits stay unknown |
| Prompt/attachments/MCP/subtasks | `server/prompts.ts`, task turn construction; runner MCP mode and `workerTool`; `spawn_subtasks` lineage | Scoped Box Yard stdio server, instructions and uploaded file paths; same worker tools/subtask boundaries |
| External connectors and managers | `TaskManager.taskConnectors`, manager harness allowlist | Document actual support explicitly; no implicit Claude connectors or manager execution |
| Archives/snapshots/restores | `TaskManager.archiveExcludes`, `server/archive.ts`, `server/gitFirst.ts`, `server/boxSnapshot.ts` | Session database included, credentials/config/cache excluded, sequence preserved |
| Verification and documentation | `test/cursor*.test.ts`, `test/codex*.test.ts`, `scripts/fake-*.mjs`, `scripts/testTiers.ts`, `docs/*` | Safe fake CLI adapter tests and cross-surface settings/creation/resume tests; no paid smoke calls |

OpenCode's release contract and supported differences are documented in [opencode.md](opencode.md). Existing manager chats, defaults and saved task harnesses remain unchanged.
