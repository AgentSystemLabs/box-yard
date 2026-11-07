# Untrusted task messages and manager authority

Review date: 2026-11-07. This is a source review and a policy decision record in
progress, not a claim about a deployed fix. Direct delivery was guarded in
`4c6c47a`, task-derived hooks and schedule carry-over in `cbc96ea`, and
queue/child-title delivery checks in `d17c73e`. The broader manager
restrictions are **proposed, not implemented**.
The remediation PR must remain open with `no-automerge` until security review.

## Answer to the threat model

Yes. A malicious task can send text to its own Captain. A Captain can relay it to
the Coordinator, and both can encounter task output through tools, summaries,
artifacts, hooks, history and later conversation turns. A hostile model can also
choose malicious tool calls without needing a separate prompt-injection payload.
The model's name does not change the required authorization boundary.

Manager harnesses omit direct shell/edit tools (`server/chatAgent.ts:21`,
`server/codex.ts:128`). That does not remove their MCP authority to instruct an
existing local/SSH task, create a host task through a host project default, or
change future control-plane behavior. This is a confused-deputy path to host
execution, with model compliance as a precondition. No live model or host exploit
was attempted.

Attribution, source labels, prompt instructions and compaction summaries cannot
establish a human's approval. A later human message also cannot cleanse previously
received hostile context. Authorization must still deny an unsafe action if a
manager deliberately selects it after reading any of those inputs.

## Verified paths and current disposition

| Risk | Source evidence and precondition | Current disposition |
| --- | --- | --- |
| **High: isolated worker messages an existing host task** | `TaskManager.deliverAgentMessage` resolves task IDs/titles and previously queued the worker's text or stored its FYI in the recipient's history. No runner change was necessary. | Branch fix compares server-owned execution ceilings before either write. Real event-dispatch tests cover local/SSH targets, nested children, FYIs and forged approval fields. Same-authority collaboration remains available. This does not filter arbitrary content a host agent independently chooses to read. |
| **High: isolated child reports wake a host parent** | `TaskManager.reportToParent` queues reports/questions and can wake a resting parent. `writeSubtasksFile` delivers reports mid-turn, including old saved reports. | Branch fix withholds report bodies/questions and child titles across different host authority. It rechecks saved reports and claimed worker inputs before launch/steer, including recovered steer claims; disallowed attachments are withheld. The child's page remains available for human review. Previously delivered context/history remains untrusted and is not erased. |
| **High: worker persuades a manager to instruct a host task** | `server/mcp.ts:1526` (`send_to_task`), `:1668` (`reply_to_agent`), queue editing/delivery and task continuation/retry paths can act on an already host-authorized task. Omitting `runs_on` preserves that authority. | **Open.** A helper to require an isolated task exists in the branch but is not yet connected to manager tool authorization. |
| **High: defaults or whole-turn selections authorize unrelated calls** | `requireNewRunner` permits matching host project defaults (`server/mcp.ts:439`). Server-trusted runner picks apply to model calls for an entire turn, which can contain mixed sources or old hostile context. | **Open.** An authenticated runner selection is insufficient as a reusable model capability. A privileged action needs a human action outside model dispatch or approval bound to the exact action and target. |
| **High: automation launders worker content into a new host task** | `HookEngine.fire` created a top-level task without source containment; rendered prompts may include worker summaries. `Scheduler.startRun` appended the previous task's title/summary before creating the next run. | **Partial fix.** `TaskManager.createTaskFromTask` pins task-derived hook creation to the source runner and saved ceiling, including recursive hooks. The scheduler pins its resolved target and withholds previous cross-authority titles/summaries. Real hook/manual/timed/catch-up tests cover changed defaults. Other automation actions, manager mutation and persistent state remain open. |
| **High: persistent state or connectors bypass a narrow dispatch fix** | Manager tools mutate settings, projects, notes, identities, machines, hooks and schedules. Claude manager sessions also load configured external MCP connectors (`server/captains.ts:696`, `server/orchestrator.ts:242`). | **Open.** Shared future prompts and arbitrary connector tools cannot inherit a broader privilege merely because the immediate caller is a manager. |

The direct-delivery comparison currently distinguishes isolated, local and SSH
authority classes. It does not establish isolation between different SSH machines,
projects sharing a worker, arbitrary files subsequently read by a host agent, or
privileged agents already holding hostile context. These checks consult current
server task authority; they are not immutable per-message provenance. Human
elevation of a source does not prove its older output safe. Global task directory
titles, stored history, notes and arbitrary repository reads remain indirect
inputs; hiding task IDs is not an authorization boundary.

## Concrete compatibility and action inventory

The minimum enforceable proposal is a permanent contained-only capability set for
Captains and the Coordinator, independent of message origin or the current turn.
Every callable tool needs an explicit classification; hiding tools in a prompt is
insufficient. Unknown/new tools must fail closed.

The following catalog partitions all **82** manager registrations at reviewed
commit `ed152eaf5271ba84782003afe753a94ea1f4e24c`. This is the proposed policy,
not a list of current server denials. Captain project scope and status-only
privacy checks remain mandatory in every group. Role/scope must come from the
authenticated server principal, never model arguments. Summary, compaction and
side-thread phases are observation-only for both manager harnesses; stale tokens
must not retain earlier privileges.

| Group | Tools | Proposed permission and exact compatibility impact |
| --- | --- | --- |
| Stored reads and fixed measurements (16) | `list_queued_messages`, `list_notes`, `list_note_suggestions`, `list_artifacts`, `read_artifact`, `list_schedules`, `list_schedule_runs`, `list_hooks`, `list_hook_runs`, `list_machines`, `box_history`, `turn_timings`, `get_settings`, `list_connectors`, `list_identities`, `machine_stats` | Allow scoped, bounded, redacted state/fixed measurements. No credential-reference resolution, arbitrary command, connector startup, grant or downstream dispatch. |
| History observations (5) | `compaction_history`, `list_compactions`, `read_compaction`, `find_compactions_by_task`, `search_history` | Allow bounded internal index hydration. These are not literally write-free: `server/compactionIndex.ts:76` discovers/hydrates cache rows. Replayed content grants no authority. |
| Observation facades needing changes (7) | `list_projects`, `list_tasks`, `get_task`, `list_inbox`, `pool_status`, `wait_for_tasks`, `wait_for_captain` | Allow only after making reads inert. Lose tool-triggered provider/PR refresh/reconciliation, notice consumption and lazy manager creation. Return cached state and bounded waits; separately authorized background maintenance may update state. |
| Contained task control (14) | `create_task`, `create_tasks`, `send_to_task`, `reply_to_agent`, `deliver_queued_now`, `cancel_queued_message`, `edit_queued_message`, `set_task_model`, `set_task_priority`, `set_task_stay_open`, `stop_task`, `reopen_task`, `continue_task`, `retry_task` | Optionally allow only verified isolated targets. Managers lose all control of existing local/SSH tasks, including state/queue/model edits and stop. New tasks cannot inherit a host default or silently fall back to it. |
| Restricted manager communication (2) | `send_to_captain`, `ask_captain` | Allow only when every recipient has the same permanent restrictions; relays cannot inherit or mint grants. |
| Privileged effects (38) | `create_project`, `update_project`, `delete_project`, `repo_clone`, `close_task`, `get_preview_url`, `save_note`, `add_note`, `update_note`, `delete_note`, `resolve_suggestion`, `create_artifact`, `create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule_now`, `add_machine`, `update_machine`, `test_machine`, `remove_machine`, `raise_cloud_limit`, `allow_more_boxes`, `update_settings`, `detect_identities`, `import_detected_identity`, `create_identity`, `update_identity`, `delete_identity`, `assign_identity`, `test_identity`, `create_hook`, `update_hook`, `delete_hook`, `clean_up_box`, `resize_box`, `snapshot_box`, `delete_box`, `delete_idle_boxes` | Deny to manager principals. The operator performs these through authenticated UI/API. A future bounded artifact writer/cached preview lookup could be reviewed separately; current mixed-effect handlers do not become safe from their names. |

Important apparent reads have real effects at this checkpoint: PR refresh in
`server/mcp.ts:1038`, `:1286`, `:1870` reaches `PrTracker.onChange`
(`server/prs.ts:475`) and `TaskManager.prChanged` (`server/tasks.ts:7376`),
including follow-up merge/automation paths. Pool reads reconcile/refresh providers
(`server/mcp.ts:2293`, `:2316`); waits consume notices (`:1772`) or may create
manager host directories (`server/captains.ts:663`). Denying only tools with
obviously mutating names is insufficient.

Central checks must protect enqueue, queue delivery, placement, launch/restore,
model changes, worker events, automation, callbacks and alternate REST routes.
Resolve actual machines, aliases/defaults, credentials and execution history;
an isolated runner label alone does not prove a safe mount/network/credential
boundary. The default `source="cody"` in a service method is not a human principal.

| Action family | Contained-only manager behavior | Human workflow that needs to remain available |
| --- | --- | --- |
| Create/batch tasks; send/reply/steer; queue edits; model/priority changes; retry/continue/reopen | Permit only verified isolated targets and placement; reject local/SSH defaults, existing host tasks, placement aliases and broad runner picks. Validate the complete batch before side effects. | Authenticated task creation, task messages and task options can select or control a host task directly. |
| Projects and global settings | Read scoped, redacted status. Deny model changes that can affect future host execution, credentials or trust. | The operator saves settings/project changes through authenticated UI/API. |
| Notes, accepted suggestions and other persistent prompt state | Do not let a manager write shared instructions that a later host task will consume. A narrower isolated-only note store would need separate enforcement. | The operator reviews and saves shared instructions. |
| Hooks and schedules | Deny unsafe automation creation/mutation/run-now. Independently enforce source containment in the eventual hook/scheduler dispatcher. | The operator configures automation; worker-derived content still cannot acquire host authority from a changed default. |
| Machines, identities, capacity and box lifecycle | Deny manager mutations and credential discovery/import/testing or host-affecting operations. Audit seemingly read-only helpers that spawn host commands. | The operator uses authenticated settings and explicit maintenance actions. |
| Arbitrary external MCP connectors | Exclude from privileged manager sessions unless a separate broker enforces a verified contained/read-only capability. Connector scope alone does not restrict what an external tool does. | The operator invokes privileged connectors directly or reviews an exact proposed action through an approval broker. |
| Files, artifacts, history and repository reads | Use scoped, bounded readers with validated paths; check built-in read/glob/search permissions and symlink behavior. Treat all returned content as untrusted. | Normal task status, conversation review and contained-task coordination remain available through verified tools. |
| Captain/Coordinator messages | Communication may remain, but every recipient must retain the same permanent restricted capabilities. Forwarding, FYIs and summaries cannot restore host authority. | The operator can review a request and take a separate authenticated action. |

Two implementation choices require the owner's workflow decision:

1. **Contained-only managers (recommended minimum):** apply the restrictions above.
   Host execution and privileged administration stay available directly to the
   authenticated operator. Managers can explain a proposed action, but cannot
   perform it or elevate themselves through chat.
2. **Contained-only managers plus exact-action approvals:** retain the same default
   restrictions, then add a human review path bound to the concrete operation,
   target and payload. The model cannot manufacture, broaden or reuse that approval.
   This adds approval UI/API work; a natural-language claim, generic permission
   flag or whole-turn runner pick is insufficient.

This decision changes normal manager administration and connector workflows. The
Captain requested that the owner choose between these options before that broader
change. Concrete direct-relay fixes and offline regression work are already
authorized; no live configuration change or merge is part of either proposal.

For the recommended minimum, external connectors must be absent from every
manager launch/resume/summary path. Claude currently allows entire configured
connector namespaces (`server/orchestrator.ts:898`, `server/captains.ts:1443`,
`server/connectors/sessions.ts:79` at the reviewed checkpoint), outside Box Yard
per-call authorization. A reduced stdio environment is not a process sandbox.
HTTP connectors carry their configured credential authority. Codex managers
currently receive only Box Yard MCP, not these external manager connectors.

Claude does not currently have blanket arbitrary `Read` permission. Its scoped
built-in file reads still need replacement with bounded server-mediated readers
for this minimum policy: reject links/special files and enforce project roots,
traversal and byte limits. Raw shared-upload directory access cannot enforce
attachment project scope. Codex managers already omit built-in file tools.
WebFetch is not an arbitrary POST facility, but readable private/loopback GET
endpoints and data-bearing URLs remain a network/exfiltration path; broker those
destinations or remove it. ToolSearch must expose only the restricted catalog.

If exact-action approvals are selected, store the immutable operation, target,
full instructions and relevant session/queue/config versions on the server. Bind
actual runner/machine, retained inputs/history, model, repository/workspace and
attachment digests, credential references and resource/automation bounds. Execute
that canonical payload with atomic single-use expiry and invalidation on changes.
No reusable approval token may be exposed to a model. A whole human turn,
runner selection, claimed human message or another manager's relay is not a grant.

## Limits that manager policy cannot repair

- A reachable open/unauthenticated control-plane API can create fresh host tasks
  independently of MCP policy. `Auth.isAuthed` accepts open mode when no password
  is configured (`server/auth.ts:95`); the API uses that middleware
  (`server/app.ts:987`). Browser Host/Origin checks do not authenticate a container.
  Sensitive alternate REST actions need configured operator authentication too:
  connector testing can start a configured native stdio command, for example
  (`server/app.ts:1219` → `server/connectors/probe.ts:54` at the checkpoint).
  Worker reachability plus open mode/operator credentials is the precondition;
  no live reachability or credential test was performed.
- A leaked shared team credential is powerful. This deployment has a shared login;
  this proposal does not add per-user isolation or revoke old worker credentials.
- An intentionally unsandboxed local/SSH task has arbitrary host command access
  and may independently read hostile repository content. Messaging restrictions
  alone cannot make such an agent safe.
- The vulnerable installed Docker Desktop, container-to-host networking, shared
  worker files/secrets and provider buffering risks remain documented in
  [the remediation assessment](runner-remediation.md).

## Verification

All four requested reviews have reported: message provenance, all 82 privileged
tool registrations, persistent/indirect injection, and offline regression seams.
Their results agree that a permanent server effect boundary is required. The
fourth review provided source-derived observations/test design, not executed
manager integration coverage: its workspace lacked dependencies.
No production changes, credential reads, hostile live requests or live model
prompt-injection trials were used.

The primary remediation workspace runs real event dispatch, parent-report,
HookEngine and Scheduler fixtures, plus steer/launch delivery checks. At
`d17c73e`, containment/hook/scheduler/subtask/steer coverage passed 65 tests in
five files, including queue/title fixtures. The final stable-HEAD gate is recorded
in PR #18.
Proposed manager policy is not tested behavior and must not be represented as a
deployed protection. A passing case is not an absolute escape guarantee.
