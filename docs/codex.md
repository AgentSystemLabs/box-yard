# Codex

Box Yard's agents can run on OpenAI's [Codex CLI](https://developers.openai.com/codex/cli) as well as Claude Code (task agents can also run on [Cursor's CLI](cursor.md)). Pick the harness here:

| What | Where you pick it |
| --- | --- |
| The Coordinator | Settings › Coordinator › Agent |
| Every project's Captain | Settings › Coordinator › Captains › Agent |
| A project's task agents | Project › Settings › Agent (or Settings › Box agents › Agent for every project that doesn't pick one) |
| One task | `agent: "codex"` on `create_task` / `create_tasks`, or a `gpt-*` / `o*` model, which picks Codex on its own |

Changing a project's Agent or Settings' default only changes new tasks. To switch existing work explicitly, use **Continue with…** on a resting task or `continue_task {task, agent: "codex"}` (choose `claude` or `cursor` as needed). This keeps the same task and workspace; see [continuing tasks](task-continuation.md). The Coordinator and Captains switch from their next turn: their old session belongs to the other CLI, so the next turn starts a new one with a recap of the conversation, the same way as when a session goes missing.

## Logging in

Codex needs a login wherever it runs. Box Yard hands it one of these, first match wins:

1. **A project's own `CODEX_API_KEY`** in its env (or a task's). That project's tasks then get boxes of their own, like a project with its own Claude login.
2. **Settings › Credentials › Codex ChatGPT login.** Uses your ChatGPT plan. Run `codex login` on a computer with a browser, then paste the whole of `~/.codex/auth.json`. On the server you can set `CODEX_AUTH_JSON` instead (the file, or it base64-encoded), or explicitly reference a server-readable login with `CODEX_AUTH_FILE` as described below.
3. **Settings › Credentials › OpenAI API key for Codex** (`CODEX_API_KEY` on the server). Pay per use. When both are set, Box Yard uses the ChatGPT login.
4. **Nothing set, on this computer:** agents running here (Runs on: This computer) and the Coordinator use this computer's own `codex login` (`~/.codex`). Boxes, RunPod pods and Docker containers can't, so they need one of the above.

On an SSH machine ([docs/machines.md](machines.md#codex)), the ChatGPT login goes only to a Linux machine, which keeps it in memory during and between turns. Elsewhere the API key is used in its place, or else the machine's own `codex login`.

The Test button next to each runs a real one-word `codex exec` with only that login.

### Forward a login by server-side file reference

To let remote tasks use an existing login without copying tokens through chat, logs or shell arguments, set only its path in the server's environment:

```dotenv
CODEX_AUTH_FILE=~/.codex/auth.json
```

This is an explicit opt-in to share that login with the tasks that use the global Codex credential. Keep the file private to the server's user (`chmod 600`), and use trusted worker machines. Box Yard never exports this computer's login just because it exists. A secret mount outside the repository works too; the path is resolved on the server, never on the worker.

`CODEX_AUTH_JSON` takes precedence over the file reference; the file takes precedence over the saved ChatGPT login and global API key. A project's or task's own `CODEX_API_KEY` still wins. An unreadable, invalid or oversized file fails with a generic setup error, without falling back to a different account. The file is read again on use, so replacing it takes effect without a restart; changing the environment variable itself requires the normal server restart.

The existing turn handoff delivers the login to an isolated worker Codex home with mode 600 and excludes it from archives. Newer same-account tokens refreshed by remote turns are kept in Box Yard's credential store; Box Yard does not modify the referenced file. Avoid independently refreshing copies of the same login on several machines (see below).

If a remote Codex task fails with `401 Unauthorized: Missing bearer or basic authentication in header`, check for a configured Codex login first. A successful local `codex login` alone does not authenticate boxes. On an already running server, the existing authenticated `PUT /api/setup/credentials` can save `codexAuthJson` without a restart; automation should read the file and send it in the request body in memory, print only redacted status, and never put it in a prompt, command argument, or temporary request file. Retry the original task on its original runner after setup; changing its model alone does not change its CLI. To switch harness explicitly, use same-task continuation.

OpenAI documents credential caching and remote login setup in [Codex authentication](https://developers.openai.com/codex/auth).

### The ChatGPT login is refreshed, so Box Yard keeps the newest copy

Codex refreshes a ChatGPT login's tokens when they're about a week old, and the refresh token it replaces stops working. A copy of `auth.json` pasted on several machines would leave all but one with a spent token. So Box Yard keeps the login itself:

- Each turn gets the current copy as `codex-auth.json` in its task folder (a link into tmpfs on SSH machines). The runner moves it into the task's own Codex home (`<task>/codex/auth.json`, mode 600), unless the copy already there is the same account refreshed later: the newer one always wins.
- When the turn ends, Box Yard reads that file back and keeps it if Codex refreshed it, for every later turn, box and Captain. The Coordinator's own runs use `<data>/codex` and are taken back the same way.
- On an SSH machine, the forwarded ChatGPT login and its temporary replacement files stay in a task-specific `CODEX_HOME` in tmpfs. Its `sessions` folder points back into `<task>/codex/sessions`, so conversations still archive and resume. The task folder only links to the login for the server to read it back.
- Task archives never include the login, and box snapshots strip `~/.codex/auth.json`.

Two turns that both refresh at the same moment (a week-old login, two agents starting at once) can still race: the loser's turn fails with "refresh token was already used", and the next turn gets the winner's tokens. If you run many Codex agents at once, an API key avoids the question.

Project identities (docs/identities.md) have no Codex login of their own yet: a Codex task in a project with a non-Default identity uses Settings' Codex login, with the identity's GitHub token and git author as usual.

Settings › Credentials › More Codex logins takes more ChatGPT logins: new sessions take them in turn with Settings' own, and a session stays on the account that started it (docs/logins.md).

## How a Codex agent runs

**Task agents** run `codex app-server --listen stdio://` on their worker through `runner/box-runner.mjs`. Each Box Yard turn owns a process and a native turn, with:

- Box Yard's tools (ask_user, create_pull_request, finish…) as an MCP server, approved to run without asking.
- `approvalPolicy: never` and `sandbox: danger-full-access`, the same footing as Claude Code's `bypassPermissions`: the box is the sandbox. On This computer that means unsandboxed, as with Claude Code. Unexpected interactive requests fail the turn; steering never grants approval.
- A clean task-owned `CODEX_HOME` (app-server has no `--ignore-user-config`), with ChatGPT apps, plugins, memories and computer use switched off. Local-login tasks import only the login and, when resuming a legacy local session, its matching rollout. The owner's home configuration/MCP servers are not imported; repository instructions still apply.
- Sessions in `<task>/codex/sessions`, so archives/moves retain the conversation. `thread/start` names a fresh session; later turns use `thread/resume` with that same thread ID. Stop uses `turn/interrupt` and a process kill fallback.
- Model, effort, auto-compact threshold and Box Yard developer instructions passed explicitly. Attachments keep the existing task-file delivery path; Box Yard MCP uses the same stdio adapter.

The adapter is verified with Codex CLI **0.166.0**. Workers need app-server's `turn/steer`, required `expectedTurnId`, and `clientUserMessageId`/`userMessage.clientId` correlation. Unsupported versions fail or hold uncertain input; Box Yard does not silently switch harnesses. See [delivery states, diagnosis and validation](codex-steering.md).

Codex is installed the first time a Codex task lands on an Upstash box or RunPod pod (`npm install -g @openai/codex`); Box Yard's Docker image and server image already have it. On This computer and on SSH machines it's yours to install: a Codex task only goes to a machine whose connection test found `codex`.

Codex tasks also run on [SSH machines](machines.md#codex). Install the CLI as the SSH user and test the machine; Box Yard selects one with Codex installed and either a forwarded credential or its own login. It never installs software on an SSH machine.

**The Coordinator and Captains** run `codex exec` on the server with Box Yard's MCP tools over HTTP (the token comes through an env var, never the command line), a read-only sandbox, and no shell: they act through Box Yard's tools, and a shell could read Box Yard's data folder past what a status-only project allows. Images you attach are attached to the message; small text files come inline. With no file tools, a Codex Captain has no read-only clone of its repo to answer code questions from (a Claude Code Captain's `repo_clone`): it creates a task for them.

**Side threads** on a Codex chat start from the chat's summary and its messages up to the highlight (Codex can't fork a session at a message), and stay read-only through their own MCP token. They run on the chat's Codex model and effort: Settings › Coordinator › Quick questions (a Claude model, e.g. Haiku) only applies to chats on Claude.

## What's different from Claude Code

| | Claude Code | Codex |
| --- | --- | --- |
| Model | Settings › Model, routing, the task's model | Settings › Codex model select (task default: gpt-6.1-sol; an explicitly saved empty choice retains Codex's default). A task's or routing's model is used when it's an OpenAI one; a Claude model gives way to the Codex model |
| Effort | `--effort` | `model_reasoning_effort` (task default: xhigh; independent from Claude's effort). Ultra is offered only for Codex models that support it |
| Context meter | from each API call | from the session's rollout file, at the end of each turn |
| Subscription limits ([limits.md](limits.md)) | `rate_limit_event`, while it runs | the rollout file's `rate_limits`, at the end of each turn |
| Compact (task) | Box Yard runs `/compact` | Codex compacts on its own; Settings › Box agents › Auto-compact sets `model_auto_compact_token_limit`. The Compact button refuses |
| Compact (Coordinator, Captain) | summary, then `/compact` | summary, then the next turn starts a new session from it |
| Cost | the CLI's `total_cost_usd` | not reported (tokens are) |
| Streaming replies | word by word | a message at a time |
| Steer (a queued message into the running turn) | written to open stream-json stdin; a successful pipe write does not prove model processing | `turn/steer` scoped to the active native turn; queued → requested → accepted. Input stays locked through turn completion; ambiguous delivery is held for review, never automatically replayed. Acceptance does not prove model processing |

Settings shows only the selected harness's model and effort controls, and keeps changes as drafts until Save. See the [verified catalog, supported reasoning values and discovery limits](codex-model-catalog.md). Existing explicit task effort settings are inherited for Codex until its separate effort is saved; existing custom model names remain visible with a warning.

## Trying it without an OpenAI account

`scripts/fake-codex.mjs` speaks app-server JSON-RPC for tasks and `codex exec --json` for managers, and does the work with `scripts/fake-claude.mjs`, so every fake-claude prompt marker works. Mock mode (`./yard demo`) uses it, and so do the tests (`test/codex*.test.ts`):

```sh
CODEX_BIN="node scripts/fake-codex.mjs" npm run dev
```

[OpenCode](opencode.md) is also available for task agents, with a separate model default and provider API logins. See its version contract and supported differences before switching a task.
