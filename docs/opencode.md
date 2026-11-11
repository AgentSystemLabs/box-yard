# OpenCode task agents

Box Yard supports **OpenCode 1.19.5** as a task harness alongside Claude Code, Codex and Cursor. Existing tasks keep their harness; existing saved defaults and manager chats are unchanged. OpenCode is task-only in this integration. The Coordinator and Captains continue to offer Claude Code and Codex.

## Choose OpenCode

- Settings › Box agents › Agent: OpenCode. **OpenCode model** is an independent default and stays a draft until Save.
- Project › Settings › Agent: OpenCode, or choose it for one task in the New task dialog.
- `!opencode` in a chat selects it for tasks that message creates. The model submenu offers the saved OpenCode model, when set.
- `create_task` / `create_tasks`: `agent: "opencode"`. A new task with a `provider/model` ID also selects OpenCode unless an agent was explicitly chosen.
- On a resting task, **Continue with another agent…**, or `continue_task {task, agent: "opencode"}`. A harness change retains the task/workspace and starts a fresh native session with the existing handoff recap. Ordinary messages and Retry keep the saved harness.

Use `provider/model`, optionally followed by `#variant`, for example `example/model#high`. List real IDs with `opencode models` on the runner; Box Yard does not invent a catalog or validate account access by making a model request. `#variant` becomes the CLI's separate `--variant` flag. There is no generic Effort setting for OpenCode: omit `effort`. Unknown providers/models fail through the CLI rather than switching harnesses or models. Before passing a #variant, Box Yard checks the runner’s `opencode models <provider> --verbose` metadata and fails before generation if the variant is absent or cannot be verified; v1 itself would silently ignore an unknown variant. An empty model uses OpenCode's automatic default in the isolated task profile, **not** a model from your host's OpenCode configuration.

The usual task/project/settings/routing precedence applies to models. OpenCode accepts provider-qualified models only; an incompatible routing entry fails with an actionable error. Claude/Codex defaults are never passed to OpenCode. Box Yard's auto-compact threshold is not passed; OpenCode manages its own context.

## Provider API credentials

Settings › Credentials › **OpenCode API logins** accepts a JSON object of provider API entries, using the shape from OpenCode's `auth.json`:

```json
{"example":{"type":"api","key":"example-api-key"}}
```

Use actual provider IDs and keys. On a machine where OpenCode is installed, `opencode auth login` offers provider sign-in; choose an API key method, then copy the API entries from `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`. **OAuth and well-known logins are rejected**, because this adapter does not implement refresh-token ownership or propagation. Do not paste OAuth entries from a mixed login file.

Priority for a task's credentials:

1. Project/task `OPENCODE_AUTH_CONTENT` or an explicitly supplied supported provider key (`OPENCODE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`). These replace the global OpenCode login, rather than being combined with it.
2. Settings' OpenCode API logins (`OPENCODE_AUTH_CONTENT` on the server takes precedence over a saved value).
3. On This computer or SSH only, the runner's own API-only OpenCode auth file, read into the process environment without copying it into the task profile.

A model still needs a credential for its provider. A login being present is not proof that the selected provider accepts it. The credential **Test** button checks JSON format only and says so; it does not contact a model provider. Fix an authentication error before retrying. There is no credential rotation, subscription-limit reporting, or automatic retry with another account/harness.

Credentials follow the existing turn environment delivery. Individual provider keys are redacted from errors. Task JSON, OpenCode auth files, caches/config/logs are excluded from workspace archives. On SSH, task JSON is removed at turn end. As with the other harnesses, task processes can read their own credentials and files; the runner is the execution boundary.

## Runners and installation

| Runner | Availability |
| --- | --- |
| This computer | Install `npm install -g opencode-ai@1.19.5` yourself; `OPENCODE_BIN` may name another binary. Settings' local tool check shows the version and API login guidance. Box Yard never installs on the host. |
| SSH | Install the same version as the SSH user and test the machine again. Placement requires the CLI/version and a forwarded or native API login. Old machine tests must be refreshed. |
| Upstash, Docker, RunPod, Vast.ai, Daytona | The common runner installs the pinned npm package on first use into `~/.boxyard-tools/opencode`, inside the managed sandbox. API credentials are required before provisioning. Existing binaries with unsupported versions fail clearly rather than being replaced. |
| Local box provider / mock mode | Local folders use the configured CLI; mock mode uses `scripts/fake-opencode.mjs`, with no network or real login. |

All providers use the same worker adapter. Credential preflight covers every provider with mocks; common execution, MCP and restore paths use a fake local CLI fixture; no paid cloud or model smoke test was performed. Other OpenCode versions, including v2, are rejected until their protocol/configuration has been verified. An install failure suggests checking registry access and disk; a missing local binary says how to install and retest.

## Execution, sessions and tools

Each turn runs an in-process, noninteractive CLI, without attaching to a shared daemon:

```text
opencode run --format json --auto --pure [--model provider/model] [--variant name] [--session ses_…]
```

The prompt goes on stdin and stdin closes. Box Yard's instructions prefix each turn. Uploaded attachments use Box Yard's usual staged file paths in that prompt; this integration does not promise native image/PDF attachment parsing. Agents can use their file-reading tools within the model's capabilities.

XDG data/config/cache/state directories point at `<task>/opencode/*`. Repository/global OpenCode config and external plugins are disabled. The generated configuration supplies only Box Yard's local stdio MCP server and permissions, including denying OpenCode's native `task`/question/plan tools. Agents use Box Yard's `spawn_subtasks`/`ask_user` instead, retaining the existing environment lineage, credentials, budgets and coordination. Claude connector MCP servers and custom OpenCode provider/plugin configurations are not loaded. The task still reads repository instructions/files through its regular tools.

- The CLI generates a `ses_…` ID, recorded from its output. Later turns use exactly `--session <id>`, never the ambiguous “last session” option.
- Session data travels in whole, partial and git-first workspace archives. A restore resumes the same native session; if that session is missing, the standard visible session-reset event accompanies a fresh session with a recap.
- Completed text parts become assistant messages. Completed tools and tool errors get Box Yard names; Box Yard's MCP tools emit their own events. The CLI's JSON mode emits completed parts, so this is **not token-by-token text streaming**.
- Steer leaves input queued until the next turn and explains why. Stop uses the existing runner process-group cancellation and turn-end reporting.
- Provider errors, malformed/empty output and incomplete/non-stop finish reasons fail the turn, even if the CLI exits zero. Error events do not trigger a harness fallback.
- Each `step_finish` contributes tokens and cost once per part ID. Cached reads/writes stay separate; reasoning counts as output. The context count is the last step, not the run sum; the CLI does not provide a context-window size in this stream. Cost is per run, including on resumed sessions, rather than Claude's cumulative session cost. OpenCode's reported price is not an invoice; unreported usage remains unavailable.

## Verified upstream contract and tests

Verified on 2026-11-08 against the stable npm **1.19.5** binary (`--version`, `run --help`, isolated `debug config`; no model calls) and these official release sources:

- [Noninteractive arguments, stdin, JSON event envelopes and session lookup](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/run.ts).
- [Auth file and OPENCODE_AUTH_CONTENT](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/auth/index.ts), [XDG paths](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/global.ts).
- [v1 MCP configuration](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/v1/config/mcp.ts), [config loading](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/config/config.ts).
- [Model/variant catalog](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/cli/cmd/models.ts), [variant selection](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/llm/request.ts).
- [Step token/cost normalization](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/session.ts).

Current [official docs](https://opencode.ai/docs/cli/) describe v2, whose shared service and configuration differ; they are not used to guess v1 commands. See the [integration inventory](harness-integration.md) before adding another harness. `test/opencode.test.ts`, `test/opencode-ui.test.ts` and `test/opencode-task.e2e.test.ts` cover the cross-surface contract with safe fixtures.
