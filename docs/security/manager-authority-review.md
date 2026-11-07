# Untrusted task messages and manager authority

Review date: 2026-11-07. This is a source review and a policy decision record in
progress, not a claim about a deployed fix. The direct-delivery changes below are
at commit `4c6c47a`; the broader manager restrictions are **proposed, not implemented**.
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
| **High: isolated child reports wake a host parent** | `TaskManager.reportToParent` queues reports/questions and can wake a resting parent. `writeSubtasksFile` delivers reports mid-turn, including old saved reports. | Branch fix withholds report bodies/questions across different host authority and rechecks saved reports when producing the wait file. The child's page remains available for human review. Existing recipient context and previously queued reports still require rollout consideration. |
| **High: worker persuades a manager to instruct a host task** | `server/mcp.ts:1526` (`send_to_task`), `:1668` (`reply_to_agent`), queue editing/delivery and task continuation/retry paths can act on an already host-authorized task. Omitting `runs_on` preserves that authority. | **Open.** A helper to require an isolated task exists in the branch but is not yet connected to manager tool authorization. |
| **High: defaults or whole-turn selections authorize unrelated calls** | `requireNewRunner` permits matching host project defaults (`server/mcp.ts:439`). Server-trusted runner picks apply to model calls for an entire turn, which can contain mixed sources or old hostile context. | **Open.** An authenticated runner selection is insufficient as a reusable model capability. A privileged action needs a human action outside model dispatch or approval bound to the exact action and target. |
| **High: automation launders worker content into a new host task** | `HookEngine.fire` creates a top-level task without source containment (`server/hooks.ts:383`); rendered prompts may include worker summaries. `Scheduler.startRun` appends the previous task's title/summary before creating the next run (`server/scheduler.ts:299`). | **Open.** Check containment at automation dispatch and content delivery, including changed project defaults and manual/catch-up runs. |
| **High: persistent state or connectors bypass a narrow dispatch fix** | Manager tools mutate settings, projects, notes, identities, machines, hooks and schedules. Claude manager sessions also load configured external MCP connectors (`server/captains.ts:696`, `server/orchestrator.ts:242`). | **Open.** Shared future prompts and arbitrary connector tools cannot inherit a broader privilege merely because the immediate caller is a manager. |

The direct-delivery comparison currently distinguishes isolated, local and SSH
authority classes. It does not establish isolation between different SSH machines,
projects sharing a worker, arbitrary files subsequently read by a host agent, or
privileged agents already holding hostile context.

## Concrete compatibility and action inventory

The minimum enforceable proposal is a permanent contained-only capability set for
Captains and the Coordinator, independent of message origin or the current turn.
Every callable tool needs an explicit classification; hiding tools in a prompt is
insufficient. Unknown/new tools must fail closed.

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

## Limits that manager policy cannot repair

- A reachable open/unauthenticated control-plane API can create fresh host tasks
  independently of MCP policy. `Auth.isAuthed` accepts open mode when no password
  is configured (`server/auth.ts:95`); the API uses that middleware
  (`server/app.ts:987`). Browser Host/Origin checks do not authenticate a container.
- A leaked shared team credential is powerful. This deployment has a shared login;
  this proposal does not add per-user isolation or revoke old worker credentials.
- An intentionally unsandboxed local/SSH task has arbitrary host command access
  and may independently read hostile repository content. Messaging restrictions
  alone cannot make such an agent safe.
- The vulnerable installed Docker Desktop, container-to-host networking, shared
  worker files/secrets and provider buffering risks remain documented in
  [the remediation assessment](runner-remediation.md).

## Verification

The four requested independent reviews cover message provenance, privileged tool
authorization, persistent/indirect injection, and adversarial offline regression
coverage. Their results must be reconciled before calling the review complete.
No production changes, credential reads, hostile live requests or live model
prompt-injection trials were used.

At `4c6c47a`, `npx vitest run test/task-containment.test.ts` passed all 11 tests,
including the new real dispatch and parent-report cases. The final stable-HEAD
typecheck/build/fast-test gate has not yet run for these additions. Proposed policy
is not tested behavior and must not be represented as a deployed protection.
