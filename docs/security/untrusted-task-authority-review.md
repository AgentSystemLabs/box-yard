# Task-message provenance and authority review

Reviewed 2026-11-07, scope 1 of the runner-isolation follow-up. The source under
review is public [PR #18](https://github.com/AgentSystemLabs/box-yard/pull/18),
`contain-task-runner-and-archive-boundaries`, pinned to
`ed152eaf5271ba84782003afe753a94ea1f4e24c`. GitHub reported it OPEN when inspected.
All implementation file:line references below refer to that commit, not this
report's branch. [Pinned source tree](https://github.com/AgentSystemLabs/box-yard/tree/ed152eaf5271ba84782003afe753a94ea1f4e24c).

## Assessment

**High: task text can cross into greater execution authority.** The pending PR
constrains a task's runner placement, but does not constrain where its messages,
reports or derived instructions can cause work. A worker can queue instructions
directly into an existing local/SSH task, or influence its Captain and then a
host task. An isolated child also reports automatically to its host parent.
None of these routes requires a container escape, shared control-plane token,
runner change, or new runner elevation.

The forwarding is demonstrated by source and inert fixtures. Host execution is
conditional on a recipient model following the supplied instructions and having
the relevant tools/credentials. No live recipient or host execution was tested.
This is a High confused-deputy exposure; it is not evidence of unconditional
remote code execution. Model brand is not an authority boundary: all worker,
repository and model-generated text must be treated as potentially hostile.

Correct attribution already exists in several places. Direct messages use
server-selected task/project IDs, and Captain input says it is not from Cody.
The gap is authorization: those labels do not limit a recipient's privileged
tools, and original origins disappear on relays, summaries and restored context.

## Worker ingress and what is actually server-derived

The runner appends JSON events to `events.jsonl` (`runner/box-runner.mjs:129–143`).
The server selects the task ID, box and directory being polled
(`server/tasks.ts:7136–7143`), and PR #18 forces file polling instead of the shared
Redis bus (`server/tasks.ts:809–810`). `EventReader` parses and deduplicates by
sequence; the file parser checks only a numeric `seq` and string `t`
(`server/bus.ts:42–55,120–126,141–144`).

That channel identifies the server-selected task record, not a trustworthy model
or event writer. A worker that can modify its task directory can forge event type,
body, timestamp, sequence and turn ID. Root in a shared worker may also modify
sibling event files; the server's correct task-ID lookup does not authenticate
which process wrote them. New Redis removal reduces one cross-task capability;
it does not authenticate files or revoke old workers' Redis credentials.

`TaskManager.apply` loads the task row rather than accepting an event's claimed
source ID (`server/tasks.ts:7177–7192`). `message_captain`'s project, source task ID
and title come from that row (`:8131–8155`); `message_parent`'s target comes from
`parent_task_id` (`:7267–7269`). The body, requested peer target, requested wait/FYI,
question, summary, artifact title/content, and result/error are worker-controlled.
Even a row-derived title may have originated in a worker's `spawn_subtasks` call
(`:7923–7937`); row-derived is not synonymous with safe prose.

**Medium defense-in-depth gap: stale control events are accepted.** There is no
common current-turn/generation guard before the event switch. Message, question,
spawn and parent routes accept stale/missing `turnId` (`:7227–7269`), unlike
`compaction_history` (`:7238`) and `finishTurn` (`:7416–7417`). Monotone sequence
deduplication is not authorization or freshness. This lets delayed or forged
events affect later turns, although a hostile current worker already has these
message capabilities. Require typed schemas, finite bounded integer sequences,
and current task/turn/assignment fencing for control events; scope intentional
late telemetry separately. A worker-visible turn ID alone is not a secret.

## Origin/target route table

“Stored source” below is immediate attribution, not a grant to execute work.

| Origin → target | Routing and persistence | Stored source / provenance loss | Enforcement now |
| --- | --- | --- | --- |
| Worker → existing task (`message_agent`) | `apply` → `deliverAgentMessage`; target ID or case-insensitive title; queues next turn and wakes resting task. `server/tasks.ts:7233–7234,8064–8124`. | Queue `agent:<from.id>`; transcript `from/fromTitle`. Body stays arbitrary. | Per-task rate cap; blocks cross-project status-only mismatch. No runner, ancestry, machine, credential-domain or authority comparison. Isolated → existing local/SSH works. |
| Worker → parent (`message_parent`) | Uses server-selected parent then the same peer route. `server/tasks.ts:7267–7269`. | Same direct agent source. | Requires an existing parent relation; no lower-to-higher execution check. |
| Worker → human/orchestrator alias | `to` matching `cody/user/human/orchestrator` produces `notice` instead of task input. `server/tasks.ts:8079–8082`. | Notice has task ID; body placed under server-written “says”. | Normally goes to the task's Captain; Coordinator sees it as an unseen update only when no Captain handles it. `fyi:true` is ignored in this alias path. |
| Worker → own Captain (`message_captain`) | Server selects project; `fromAgent` writes `captain_messages` role `user`; loop guard may hold, retain and later drain it. `server/tasks.ts:8131–8167`; `server/captains.ts:758–798,1184–1193`. | `meta.source=agent`, task ID/title, message ID, wait. Prompt includes “Not a message from Cody” (`server/captains.ts:179–188,1018–1019`). No execution-trust origin or ancestor lineage. | Own-project scope, body cap, rate limit and loop guard. These constrain routing/frequency, not recipient authority. |
| Worker FYI → transcript | Peer FYI skips queue/wake (`server/tasks.ts:8109–8113`); Captain FYI skips pending/turn input (`server/captains.ts:769–772`; `server/store.ts:2911–2919`). | Origin initially retained. Captain FYI is still role `user`; session-reset recap includes it without source/FYI metadata (`server/captains.ts:1278–1285`). | Log-only during normal delivery. Later history reads, recap, or forwarding can expose it to a model; display-only is not a durable classification yet. |
| Child final/question/error → parent report | `finishTurn` → `reportToParent`; input queue, transcript, `subtask_report:<id>` KV and parent `subtasks.json`. `server/tasks.ts:7511–7513,7955–7973,8037–8050`. | Queue `agent:<child.id>`; KV contains status/text/time/input ID, not origin trust; parent report text is server-framed worker prose (`server/subtasks.ts:85–119`). | Parent must exist and not be done; summary capped. No check that parent's local/SSH authority exceeds child's isolation. Reports can arrive next turn or via `wait_for_subtasks` mid-turn. |
| Worker `ask_user` → question, Captain, parent, human UI | Question persisted in flags/task and transcript (`server/tasks.ts:7227–7231`); at turn end parent receives report/question and Captain receives needs-you notice (`:7511–7513,7525`). | Question is worker prose embedded in server-written question/report/notice; no approval object. | Asking is not human authorization. A parent may answer with `message_agent`; that answer must not become human approval. |
| Worker final result / `finish` / error → manager update | Result/summary persisted; gist/failed/needs-input notices (`server/tasks.ts:7351–7355,7481–7517,7525–7530`). Top-level quiet agent wakes reach Captain without waking it; normal child finish update is suppressed in favor of parent report (`:7721–7727`). | Task ID survives in notice metadata, but manager prompt receives strings only. Worker text acquires a server “finished/failed/needs you” frame. | Status/rate/quiet guards reduce notification volume, not content authority. Summary whitespace normalization and truncation do not establish trust. |
| Worker artifact / PR / preview → stored output and notice | Artifact bytes/title and task/project saved; artifact and PR notices wake Captain (`server/tasks.ts:7291–7308,7311–7342`). Preview labels retained. | Artifact keeps task/project; title and bytes remain worker data. Manager artifact→upload copy drops those origins (`server/mcp.ts:393–399`; `server/uploads.ts:28–37`). | PR #18 adds bounded workspace file reads; filesystem/size controls do not prevent instruction content. PR state may later be GitHub-verified; arbitrary URL/text claims are not authorization. |
| Task notice → Captain/Coordinator | `TaskManager.notice` calls Captain router; Captain-owned notices are marked seen for Coordinator (`server/tasks.ts:9355–9361`; `server/app.ts:707–715`; `server/captains.ts:464–482`). | Captain maps notice entries to content strings (`server/captains.ts:1035–1045,1164–1176`). Coordinator `takeUnseenNotices` returns content/FYI strings, dropping IDs/meta (`server/store.ts:2687–2694`). | Project notice routing, wake controls, status-only rules. They are not execution-trust checks. Artifact batching groups by displayed task title rather than source ID (`server/noticeBatch.ts:13–38`). |
| Hook containing task text → Captain/Coordinator/new task | Summary/template expansion then message/create action (`server/hooks.ts:272–281,341–388`). | Immediate source becomes hook ID/name; original worker origin is not carried as authorization data. | Hook scope/filter/rate/lineage guards exist. A configured hook is not approval of arbitrary future `{summary}` text; new top-level task has no child containment ancestry. |
| Captain → Coordinator | Auto-turn report, or reply to Coordinator, becomes chat notice (`server/captains.ts:1093–1113,1128–1133`; `server/app.ts:808–816`). | `captain:true`, project, optional `replyTo`/FYI. No roots for notices/worker messages/history that informed the reply. In a mixed turn the same reply can answer Coordinator and worker. | Captain project scoping and reply wake heuristic; no transitive content restriction. |
| Captain/Coordinator → existing task | `send_to_task`/`reply_to_agent` call task send (`server/mcp.ts:1544–1579,1679–1683`). `inputSource` comes only from caller kind/project (`:423–424`). | Worker-derived text becomes `captain:<project>` or `orchestrator`; followup explicitly labels it “on Cody's behalf” (`server/prompts.ts:279–298`). Origin roots are lost. | Target scope and runner capability/placement checks; no source-content authorization. Omitting `runs_on` lets an existing host task execute without elevation. |
| Manager tool reads / related-work / repository → later dispatch | Task/history/artifact content can be read through scoped tools; related-work injects summaries into new prompts (`server/mcp.ts:405–410`). Claude managers have Read/WebFetch/WebSearch; Captains also Grep/Glob (`server/chatAgent.ts:16–28`). | Tool-response content and native repository/web reads have no durable session trust label. “Related earlier work” carries text, not original authority. | Scope/status-only protect visibility. Native shell restrictions do not restrict later privileged MCP dispatch. |

## Batching, continuation and apparent authority

Task inputs persist their immediate `source` in SQLite (`server/store.ts:2238–2244`).
Claiming takes every queued input together; delivery deletes the input rows and
only writes transcript entries when `message_json` exists (`:2261–2279`). Direct
agent transcript records are written separately. There is no durable graph linking
every consumed input to later output and dispatch. Editing queued text also has no
actor-aware provenance merge (`server/tasks.ts:1375–1383`). A manager must not be
able to replace a human queue entry's body while retaining its human authorization.

Task `turnTrigger` deliberately picks the highest-ranked source in a mixed queue
(`server/turnTrigger.ts:6–14,38–42`); agent+human is recorded as `cody`. This is
currently notification accounting, not an authorization mechanism. Reusing it for
security would promote untrusted content. The Captain likewise batches all pending
sources plus notices, picks a single trigger, and collects whole-turn runner picks
(`server/captains.ts:1014–1053`). Coordinator human turns also absorb notices and
hooks (`server/orchestrator.ts:733–759`), and scheduled turns absorb notices too
(`:663–680`). Presence of a human message does not approve accompanying task text.

PR #18's `humanHostPick` checks an authenticated whole-turn runner selection,
not a bound message/action/target (`server/mcp.ts:427–447`). `send_to_task` may
elevate the model-selected task using that pick (`:1559–1561`). Preconditions for
this additional path are enabled authentication, a genuine human local/SSH pick
in the same turn, worker content also in context, and model selection of a task
to elevate. The runner picker is genuine; the unapproved association to arbitrary
worker-requested work is the gap. Project-default host placement also satisfies
new-task runner checks without per-action human approval (`:444–448`).

Resuming a session carries prior worker text regardless of the next turn's source.
Task recap/harness handoff reduces history to `[role] content`, discarding source
metadata (`server/prompts.ts:368–396`; `server/tasks.ts:6091–6099,2011–2025`).
Captain session recovery converts agent role-`user` messages to `[user]` text
(`server/captains.ts:1278–1285`). Coordinator recovery does the same
(`server/orchestrator.ts:820–827`). Manager compaction writes a model-generated
summary then reintroduces it into later sessions (`server/orchestrator.ts:515–542,
797–808`; `server/captains.ts:1256–1264`). Summary format checks are not origin
checks (`server/compactions.ts:191–210`). Clearing a current-turn flag, changing
models, resetting sessions or compacting must not erase restrictions.

## Ancestry and runner switching

The new server-only runner ceiling correctly rejects an isolated task requesting
a local/SSH child or moving itself to those runners. It checks parent/project and
the physical placement; isolation narrows authority (`server/tasks.ts:1168–1220,
1240–1244,1265–1268,7895–7937`). Elevating a parent does not elevate existing
children (`:1195–1201`). These protections should remain.

The reverse direction is distinct: a local parent may deliberately create an
isolated child, whose own ceiling becomes isolated, and whose automatic report
still queues into the local parent. The parent can then run commands from that
context or create another local child. An already isolated task can also message
an unrelated existing host task directly. Later authenticated task elevation,
machine switching or harness handoff can retain a poisoned queue/history/summary.
Authority at creation, authority when content was produced, current physical
runner, and approved destination must therefore all be tracked separately.
Runner strings alone are inadequate: two SSH machines or two isolated workers
can have different credentials and accessible resources.

## Server-enforced design and exact choke points

1. **Introduce immutable content origins and separate action grants.** Store an
   envelope on inputs, messages, notices, artifacts/uploads, reports and derived
   summaries: origin IDs, channel, server-selected producing task/turn/assignment,
   project, parent/root, source trust domain and execution boundary at production,
   immediate sender, derived-from IDs, allowed audience/use, and grant references.
   Titles/body/source claims from the worker cannot set any of these. Keep event
   sender identity distinct from every untrusted field inside a server event.

2. **Validate and stamp every worker action at ingress.** Put schema/freshness and
   source stamping before `TaskManager.apply` dispatch (`server/tasks.ts:7177`).
   Use the polled task and current server assignment; never accept worker-claimed
   grants or origins. This fixes one common ingress but is insufficient without
   enforcement at destinations and manager tool calls.

3. **Use one policy service for all executable input delivery.** Invoke it from
   `send/enqueue` (`server/tasks.ts:1359,1476`), direct `deliverAgentMessage`
   (`:8064`), `reportToParent` (`:7955`), and initial task creation (`:1232`).
   Recheck at `claimInputs`/launch (`server/store.ts:2261`; `server/tasks.ts:6068`),
   `writeSteer` (`:1648`), Captain mid-turn handoff (`:8197`), subtask report files
   (`:8037`), and task placement/assignment. This covers pending work when a
   destination later moves to a stronger runner. Reporting to a parent is not
   implicit approval for that parent to exercise greater authority.

4. **Do not feed lower-trust free text to an unrestricted host executor.** Permit
   display-only reports to the human UI. Model-readable reports go to a session
   whose allowed actions are capped to the originating trust domain, or to a
   sandboxed analyst. Same-trust coordination may continue where the server has
   an explicit shared domain/capability policy; same project, same runner string,
   ancestry, model identity, or a claimed human approval is not sufficient.
   If a host model reads the raw report while keeping arbitrary shell authority,
   prompt labels cannot enforce this boundary.

5. **Bind privileged manager calls to server-owned execution context.** Existing
   `McpCaller` scope helpers (`server/mcp.ts:319–341`) should additionally resolve
   immutable invocation/session/turn context and grants in a central authorization
   wrapper. Apply it to dispatch, queue edits/steering/reopen/continue, task and
   schedule creation, runner/project/settings/machine changes and durable notes
   or hooks. `send_to_task` (`:1566`) and `reply_to_agent` (`:1682`) must carry the
   original roots, not only caller kind. A global default or host-authorized target
   does not authorize arbitrary content arriving from a weaker source.

6. **Human approval must name concrete work.** Persist authenticated approval of
   an operation, target task/project/machine, runner and relevant immutable payload
   or bounded capability, with expiry/replay rules. A host picker approves a
   destination for its own request; it must not grant unrelated batched messages
   ambient elevation. Worker questions, parent answers, model prose saying “Cody
   approved,” and output summaries cannot create grants. Use typed narrow broker
   operations for approved host automation instead of arbitrary forwarded shell
   instructions when practical.

7. **Propagate restrictions across history and derived content.** On receipt or
   reading untrusted content, conservatively persist the union of its origins and
   the intersection of permissible capabilities in the session. Include existing
   context, native reads, images, artifacts, tool results and notes, not only the
   current queue. Relays and summaries inherit restrictions. A human turn cannot
   clear them. A separate privileged session must receive only independently
   approved input or enforce exact grants; merely resetting and replaying a recap
   changes nothing. If native Read/WebFetch cannot be intercepted, restrict those
   tools in privileged sessions or conservatively classify their whole sessions.

8. **Preserve structured provenance through manager queues and UI.** Replace the
   string-only notice extraction with envelopes (`server/store.ts:2687` and
   `server/captains.ts:1035,1164`); batch artifacts by source IDs and preserve each
   origin. Keep FYI/display-only out of all recap and automatic model input paths.
   Preserve artifact origins when converting to uploads (`server/mcp.ts:397`).
   Queued edits must append editor/derived origins and recompute authorization,
   rather than inherit the original human source. Restart, compact, retry, archive,
   harness switch and runner/machine movement all retain these restrictions.

Suggested source types, orthogonal to chat roles and display labels:

| Type | Origin and propagation rule |
| --- | --- |
| `human_request` / `human_action_grant` | Authenticated human ingress; grants are structured server records. Attached/cited worker material keeps its separate origin. |
| `task_message` / `task_report` / `task_question` | Server-bound task/turn/domain plus untrusted payload. Reports and parent answers do not become human requests. |
| `task_output` / `repository_content` / `external_content` | Tools, files, artifacts, images, web/CLI output; retain producing identity and content lineage. |
| `manager_derived` | Captain/Coordinator prose, dispatch, answers or summaries; inherits all input origins/restrictions even if paraphrased. |
| `hook_derived` / `schedule_derived` | Config identity/version plus expanded-data origins and original authorization scope; automation does not bless substituted worker text. |
| `server_fact` | Independently computed structured fact; mark untrusted title/body/URL fields separately. No free-form field may create an action grant. |
| `legacy_unknown` | Missing/incomplete origin after upgrade; treat conservatively, never infer trusted authority from `user`, `cap_`, `chat_`, or old summaries. |

## Compatibility and verification

Preserve safe reports, logs, scoped replies, same-trust collaboration, parent waits,
quiet-run behavior, status-only confidentiality and existing owner-name rendering.
Content trust and status-only visibility are separate policies. Defaults, project
membership or local/SSH ceilings must not silently confer content authority.
Existing queues, snapshots, notes, summaries and resumed manager sessions need a
conservative migration; a deployment that only changes new messages leaves old
context paths open. One OS owner/shared team login can remain: the proposed checks
govern task-origin authority, not per-user accounts. Host runners remain explicitly
unsandboxed and cannot protect the host from their own intentionally hostile code.

The companion [offline fixture](message-provenance-offline.mjs) uses Node built-ins
to load the exact pinned public Git objects, strip TypeScript and invoke extracted
real routing methods against inert in-memory doubles. It launches no server,
worker, database, container or model and sends no traffic. Run from the repository:

```sh
node --disable-warning=ExperimentalWarning docs/security/message-provenance-offline.mjs
```

Five fixture groups passed: isolated→local/SSH delivery (including a stale turn),
normal peer FYI, alias FYI notice, isolated-child→host-parent report persistence,
and mixed-trigger/relay-label/recap behavior. These verify method routing and
formatting, not full integration or model compliance. Node v24.15.0 was available;
dependencies were absent, so no packages were installed and no application test
suite/build/typecheck was run. Only this report and fixture were added; production
code, host state and running workloads were not changed. No merge or PR was made.
