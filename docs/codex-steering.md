# Mid-turn delivery: Codex and Claude

## Diagnosis and supported transport

Previously task `runCodex` in `runner/box-runner.mjs` launched `codex exec --json`, ended stdin after the initial prompt, and parsed output-only JSONL. Resuming starts a later turn; it cannot inject input into that running process. `canSteer` in `shared/agentCli.ts` therefore allowed only Claude. Cursor still uses a single-input CLI and retains next-turn delivery.

Task Codex runs now use [Codex app-server](https://developers.openai.com/codex/app-server), JSON-RPC over local stdio. The documented `turn/steer` takes the thread ID, required `expectedTurnId`, input, and optional client message ID. The response acknowledges acceptance for that native turn. It does **not** establish that the model processed or followed the instruction. Using the existing Codex harness retains its tools, MCP, authentication and rollouts; replacing it with a Responses-based agent would require rebuilding those responsibilities.

`runClaude` and `steerInbox` in `runner/box-runner.mjs` actually use the Claude Code CLI, **not** the Claude Agent SDK. They start `--input-format stream-json`, keep stdin open until the first result, and write additional user JSON lines. The `steer` acknowledgment is a successful pipe-write callback. That does not prove provider acceptance or model processing; a late result, process exit or broken pipe can race it. Claude's existing delivery semantics remain intact. The [Claude Agent SDK streaming-input documentation](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) supports an asynchronous input stream, sessions and interruption, but that does not make this CLI implementation lossless.

Coordinator, Captain and side-thread Codex chats retain `server/codex.ts`'s read-only exec adapter. This migration concerns task agents, whose shared worker runner is installed through the existing local, box, Docker, SSH and GPU paths. It creates no worker-to-server callback or network RPC listener.

## Queue and lifecycle guarantees

- `TaskManager.writeSteer` serializes mailbox publication per task, prepares attachments, then checks the Box Yard turn again. A persistent publication sequence preserves batch order even when timestamps tie. Messages stay locked in SQLite while delivery is requested. A native `expectedTurnId` prevents a stale request targeting a new turn.
- `runCodex` journals input IDs before sending the RPC, then journals acceptance. Journals use a temporary file, fsync and atomic rename. The native client message ID is matched against `userMessage.clientId`; completion waits for an in-flight steer response even if the completion notification arrived first.
- `Store.codexDelivery` records the accepted transcript once and keeps claims across server restarts. `TaskManager.reconcileCodexDelivery` recovers from the worker journal even when acceptance events were lost. Successful native completion with client-ID correlation settles the claim; this is session correlation, not proof of model processing.
- An explicit stale/validation rejection, or a readable journal establishing no submission, permits next-turn delivery. A timeout, disconnect, internal server error, interrupted accepted turn, unreadable journal or missing correlation is held as **Delivery uncertain**. Automatic replay and automatic turn retry pause. This deliberately avoids claiming exactly-once delivery across a crash.
- Removing an uncertain hold does not unsend anything. The transcript retains the input and uncertainty; Undo cannot replay it. New messages wait until outstanding uncertainty is resolved.
- Pending instructions clear obsolete finish flags. Both the runner's `finish` tool and server finish handling reject premature completion. Pending or uncertain messages prevent ready/finished hooks and merge readiness; a held merge instruction stays pending. This cannot retract an external merge already requested before the follow-up arrived.

## Sessions, settings and permissions

Each Box Yard turn starts its own app-server process, calls `initialize` / `initialized`, then `thread/start` or `thread/resume`, and `turn/start`. The early session event persists the thread ID. Native `turn/interrupt` handles Stop, with process termination as a fallback. Interrupted/ambiguous input is never silently retried into a fresh session.

Model, effort, developer instructions, auto-compact settings, attachment file delivery and Box Yard's MCP adapter are retained. Token usage subtracts the session's prior cumulative total; resumed turns do not charge the previous turn again. Context/limit information still comes from the rollout.

Task policy remains `never` approval with `danger-full-access`, as before on task workers. MCP tools are preapproved; unexpected interactive requests fail closed. A follow-up is never an approval answer. Task-owned Codex homes exclude unrelated user configuration/MCP servers because app-server does not offer exec's `--ignore-user-config`. Local-login tasks copy only their login and, for a legacy resume, the matching rollout. Remote tmpfs credentials, session archives and same-account refresh readback retain their existing lifecycle. Concurrent refreshes of one shared ChatGPT login can still race.

## Evidence and practical limits

Verified with installed **codex-cli 0.166.0**:

```sh
node scripts/smoke-codex-protocol.mjs
node scripts/smoke-codex-runner.mjs
```

The protocol check generates the installed binary's schemas and verifies required turn IDs and client-ID support, initializes an isolated thread, and checks inactive steering rejection without starting a model turn. The runner smoke uses isolated HOME/CODEX_HOME and a loopback fake Responses provider: the real binary accepts an active steer, carries the text into a subsequent API input, correlates the client ID, resumes the same session, reports only the resumed turn's usage, and handles Stop. It uses no real login, model service or production session.

Focused coverage includes `test/codex-app-server.test.ts` (completion-before-ack, stale IDs, transport/internal errors, unexpected approvals, resume/usage/Stop), `test/codex-delivery-store.test.ts` (restart persistence and transcript deduplication), `test/steer.e2e.test.ts` (lost acknowledgment recovery, next-turn fallback, uncertain holds, finish/readiness guards, Claude and Cursor behavior), and `test/steer-ui.test.ts` (accurate requested/accepted/uncertain labels).

Workers need the app-server protocol features above; no minimum historical CLI version is inferred. Older/incompatible versions fail explicitly or leave an uncertain hold rather than silently switching harnesses. Live remote-provider deployments and real-model instruction following were not smoke-tested. Steer does not interrupt or undo tools already running. Manual review remains necessary when acceptance/completion cannot be established.
