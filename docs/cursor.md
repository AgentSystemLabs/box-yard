# Cursor

Box Yard's task agents can run on [Cursor's CLI](https://cursor.com/docs/cli/overview) (`cursor-agent`) as well as Claude Code and [Codex](codex.md). Claude Code stays the default. Pick Cursor where you want it:

| What | Where you pick it |
| --- | --- |
| A project's task agents | Project › Settings › Agent (or Settings › Box agents › Agent for every project that doesn't pick one) |
| One task | `agent: "cursor"` on `create_task` / `create_tasks`, `!cursor` in the composer, or a model only Cursor runs (`auto`, `composer-…`, `gemini-…`, `grok-…`, `kimi-…`, `glm-…`, `deepseek-…`), which picks Cursor on its own |

Changing a project's Agent or Settings' default only changes new tasks. To switch existing work explicitly, use **Continue with…** on a resting task or `continue_task {task, agent: "cursor"}` (choose `claude` or `codex` for the other harnesses). This keeps the same task and workspace; see [continuing tasks](task-continuation.md).

The Coordinator and the Captains don't run on Cursor. Managers have no shell or write tools; Claude Code managers have restricted read tools, including a Captain’s own repo clone. Codex managers act through Box Yard’s tools without file tools. `cursor-agent` has no way to turn its built-in tools off. Settings › Coordinator still offers only Claude Code and Codex.

## Logging in

Box Yard gives Cursor one of these logins. The first one found wins:

1. **A project's own `CURSOR_API_KEY`** in its env (or a task's).
2. **Settings › Credentials › Cursor API key** (`CURSOR_API_KEY` on the server). To make one, open the [Cursor dashboard](https://cursor.com/dashboard?tab=integrations), go to Integrations › User API Keys, and create a key. Usage is billed to your Cursor plan.
3. **Nothing set: this computer's or the SSH machine's own `cursor-agent login`.** Upstash boxes, RunPod and Vast.ai pods, Daytona and Docker containers have no login of their own, so they need a key. Box Yard says so before it creates a box.

A turn gets the key in its environment, through the task's `task.json` (as Claude Code's token does). Box Yard’s launch path puts no key on a command line and excludes the delivery file from archives. An agent can still read or copy credentials available to its process; see [Docker credential limits](docker.md#credentials-and-isolation). An SSH machine drops `task.json` when the turn ends.

The Test button runs `cursor-agent models` with only that key, in a throwaway config folder. This costs no model request. Cursor refuses a key it doesn't know ("The provided API key is invalid").

`cursor-agent` has no command that creates an API key. A key comes from the dashboard.

## Models

Settings › Box agents › Cursor model (shown once Agent is Cursor) lists the models `cursor-agent models` gives for your account, grouped by family. The New task dialog uses the same list.

- **Where the list comes from.** The server runs `cursor-agent models` with the key agents use, or with this computer's login. It keeps the list for 6 hours and saves it to `<data>/cursor-models.json`. The source line under the select says where the list came from. **Refresh** reads it again.
- **When the CLI can't run.** If the CLI isn't installed, isn't logged in or is offline, the saved list stands in. With no saved list, a snapshot from November 2026 (`CURSOR_FALLBACK_MODELS` in `shared/agentCli.ts`) does. The source line then shows the CLI's error.
- **Effort is part of the id.** Cursor's ids carry the effort and speed (`claude-opus-5-5-high`, `gpt-5.6-sol-high-fast`), so there's no separate Effort control for Cursor.
- **Default.** The default is `auto`, Cursor's own choice per request. An explicitly saved empty choice leaves it to the CLI's default.
- **Exact task pins.** A model supplied to `create_task`, `send_to_task` or `set_task_model` is passed unchanged to Cursor on first and resumed turns, even when absent from the server's catalog. The runner's CLI accepts or rejects it; Box Yard does not replace it with Auto or guess a suffix. `continue_task` currently checks a newly supplied Cursor model against the server catalog and rejects unknown IDs before queuing; an omitted model keeps the saved pin.
- **Inherited routing.** Without a task pin, a routing model is used when it is Cursor-only or appears in the server's held catalog. Otherwise Settings' Cursor model stands in, so a shared route's `opus` or `gpt-6.1-sol` doesn't reach Cursor. Settings' Cursor model itself is passed through; an empty setting omits `--model`.
- **Context is separate evidence.** Use the exact ID and label from the relevant CLI's catalog when selecting a variant. Never append `-1m`, `-high` or another suffix by guesswork. Box Yard has no separate Cursor context-selection flag; its context meter reads a window stated in the CLI's session-init label. A catalog label describes an offered model, not what a running task used.

### Tracing and verifying a launch

Keep requested settings, launch evidence and CLI reporting distinct:

| Stage | Evidence | Meaning |
| --- | --- | --- |
| UI selection | The selected option's `id`; labels are displayed separately | Settings/New task and the `!cursor` picker keep the catalog ID, including its variant suffixes |
| Task creation | Explicit `agent`, otherwise model's harness, then project, then Settings | Claude/GPT-shaped IDs need explicit `agent: "cursor"` to select Cursor |
| Saved request | Task `model` in `get_task`; creation/model-update inputs | The task's pin for subsequent turns, not confirmation of the current launch |
| Per-turn resolution | `task_turns.model`, or only `model`, `effort`, `resume`, `sessionId`, `turnId` from that task's `turn.json` | The resolved request; Cursor effort is null and resume does not remove the model argument |
| Spawn | `[box-yard] Cursor launch` JSON in that task's `runner.log` | After a successful spawn: turn ID, PID, requested model, session ID and whether this attempt resumed |
| CLI session init | `[box-yard] Cursor model` JSON in that task's `runner.log` | The CLI's reported model label and any context window stated in it, correlated by turn/session |

Extract only these model-specific fields or lines. Never dump full argv, environment, configs, session transcripts or runner logs. The launch record proves what Box Yard passed to the CLI; the init label is what the CLI reported, not independent provider attestation. `auto` may choose per request, so an Auto label does not identify an underlying provider model. A missing init label/window leaves that part unverified.

A separate `cursor-agent models` invocation (including its `(current)` / `(default)` markers), global `cli-config.json`, and an agent's self-identification do not establish a running session's model. The server discovery profile, runner profile, account and cached-list age may differ. Do not change global Cursor config to verify or repair a task. On builds without the model-only log lines, request narrowly filtered launch args/session model metadata through the task's Captain; cross-project evidence goes through the Coordinator.

## How a Cursor agent runs

`runner/box-runner.mjs` runs each turn on the task's box with:

```sh
cursor-agent -p --output-format stream-json --force --trust --approve-mcps --sandbox disabled \
  --plugin-dir <task>/cursor-plugin/boxyard [--model <id>] --resume <session id>
```

- **The prompt goes on stdin.** Box Yard's instructions open the first prompt of a session in a `<boxyard_instructions>` block. They come again only when they change: `cursor-agent` has no system-prompt flag.
- **Box Yard's tools come as a plugin.** Box Yard's MCP server (ask_user, create_pull_request, finish…) is loaded with `--plugin-dir`, so `cursor-agent` names it `plugin-boxyard-boxyard`. Every other MCP server it would load is turned off for the task's folder: yours in `~/.cursor/mcp.json`, the repo's `.cursor/mcp.json`, and installed plugins'.
- **Nothing to approve.** `--force --trust --sandbox disabled` puts Cursor on the same footing as Claude Code's `bypassPermissions`: the CLI adds no task-level sandbox. The runner’s container/VM and application permissions determine its reach; tasks sharing that environment can read each other’s files. On This computer it runs as the server’s OS user.
- **The task has its own Cursor folder.** `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` point at `<task>/cursor`, so its chats move with the task between boxes. Box Yard names the session, and `--resume <id>` starts a chat under that id the first time. If the chat has gone missing (a fresh box, a lost archive), the runner starts a new chat with a recap instead of failing, as it does for Claude Code.
- **Its stream is mapped to Box Yard's events.** Replies, tool calls (named the way Claude Code's are, e.g. `Bash`, `Edit`), tool errors, and the context size after each model call (`CURSOR_EMIT_MODEL_CALL_USAGE=1`). When a model's name states a context window ("… 1M High"), the context meter uses it.
- **Installing it.** Box Yard installs `cursor-agent` the first time a Cursor task lands on an Upstash box, RunPod or Vast.ai pod, Daytona sandbox, or Docker container (`curl https://cursor.com/install -fsS | bash`, into `~/.local/bin`). On This computer and on SSH machines it's yours to install. A Cursor task only goes to a machine whose connection test found `cursor-agent` and a login: Box Yard's key, or the machine's own `cursor-agent login`.

The server finds `cursor-agent` on `PATH`, else in `~/.local/bin` (`CURSOR_BIN` overrides both).

## What's different from Claude Code and Codex

| | Claude Code | Codex | Cursor |
| --- | --- | --- | --- |
| Coordinator, Captains | yes | yes | no: task agents only |
| Model | Settings › Model, routing, the task's model | Settings › Codex model | Settings › Cursor model, from the CLI's live list |
| Effort | `--effort` | `model_reasoning_effort` | part of the model id |
| Cost | the CLI's `total_cost_usd` | not reported (tokens are) | not reported: tokens are recorded at $0, since Cursor bills your plan |
| Subscription limits ([limits.md](limits.md)) | `rate_limit_event` | the rollout's `rate_limits` | not reported |
| More logins ([logins.md](logins.md)) | rotation | rotation | one key (the project's or Settings') |
| Compact | Box Yard runs `/compact` | Codex compacts on its own | Cursor summarizes on its own: the Compact button refuses |
| Steer (a queued message into the running turn) | open stream-json stdin | app-server `turn/steer`, scoped to the active turn | waits for the turn's end, with a note: `cursor-agent -p` reads its prompt once |

## Trying it without a Cursor account

`scripts/fake-cursor.mjs` speaks `cursor-agent -p --output-format stream-json` (plus `models`, `status` and `--version`) and does the work with `scripts/fake-claude.mjs`, so every fake-claude prompt marker works. Mock mode (`./yard demo`) uses it, and so do the tests (`test/cursor*.test.ts`):

```sh
CURSOR_BIN="node scripts/fake-cursor.mjs" npm run dev
```

`FAKE_CURSOR_LOGIN=required` makes it fail like a CLI with no login, and `FAKE_CURSOR_MODELS=fail` makes `models` fail. A `CURSOR_API_KEY` containing `invalid` is refused like a key Cursor doesn't know.

[OpenCode](opencode.md) is also available for task agents, with a separate model default and provider API logins. See its version contract and supported differences before switching a task.
