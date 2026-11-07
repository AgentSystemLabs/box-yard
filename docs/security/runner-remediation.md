# Runner isolation remediation and remaining risk

Review date: 2026-11-07. This follow-up implements fixes separately from the
[audit-only PR #17](https://github.com/AgentSystemLabs/box-yard/pull/17).
It does **not** establish that arbitrary hostile code is safe on the current host.
The security PR requires review and must not auto-merge. No live workload, daemon,
credential, or host configuration was changed during verification.

## Threat model and authority

A task can execute arbitrary commands, modify its repository and worker files, and
forge worker output/events. Claude, Codex, and Cursor shell access is intentional.
The protected boundary is the host, its services and credentials, other projects,
the Docker daemon, and the control plane. A repository-scoped Git push credential
is an intentional capability; permission to dispatch an unsandboxed host command
is a different authority.

The deployment still has one OS owner and a shared team login. This work adds
task containment, not per-user isolation. Local and SSH runners are intentionally
unsandboxed. Captains and the Coordinator retain their privileged host CLIs; a
malicious repository influencing those agents remains a separate trust boundary.

## Findings addressed

Source references below refer to this remediation branch. Use the named functions
if subsequent changes move line numbers.

| Original risk | Preconditions and impact | Change and evidence |
| --- | --- | --- |
| **Critical: worker delegation could select an unsandboxed runner** | An isolated task emits a local/SSH child request, changes the effective default, or reuses placement/retry paths. Host execution bypasses the container without a kernel escape. | `server/tasks.ts:1169` stores a server-only ceiling, validates child ancestry/project, and checks the actual provider at assignment and launch (`:5830`, `:6029`). `place` checks requested and inherited placement (`:3871`). Choosing isolation narrows authority; switching a project default cannot widen existing tasks. |
| **High: privileged tool delegation could broaden runner trust** | Worker/repository content persuades a privileged control-plane agent to create local tasks or schedules in an isolated project. | `server/mcp.ts:439` requires a server-trusted authenticated human runner pick for a one-off host override. Create/batch validate before any write; schedules require an already human-selected matching host project default. Model tool arguments cannot supply this approval. Existing task changes still pass the task ceiling. |
| **Critical: hostile workspace archives could write or execute outside their intended state** | A task-controlled TAR is restored, potentially on a later local runner. Sibling members, links, server config and Git hooks/config turn restoration into host writes or execution. | `server/safeArchive.ts:49` parses into fresh private staging before any provider upload. `server/tasks.ts:6671` uploads only canonical output, rejects an existing destination, extracts into a new staging directory, and restores a server-selected Git origin before reconstruction. |
| **High: worker output/file reads could exhaust host memory** | A hostile process emits excessive output or advertises a small artifact while returning large content. | `server/workerFiles.ts:35` caps incoming bytes independently of worker stat or event size. Artifact dispatch (`server/tasks.ts:7325`) enforces 25 MiB and a task-workspace root. Local, Docker CLI and SSH collectors bound output before retaining it; Daytona bounds HTTP bodies before JSON decoding. Upstash limitations remain below. |
| **High: shared worker Redis authority** | A worker holds shared Redis credentials and can read project information or forge another task's control events. | New worker configuration has `redis: null` (`server/tasks.ts:6630`), and server event reading uses worker files, not Redis (`:810`). New workers receive no Redis bus credentials from this path. This removes that authority rather than trying to enforce a task prefix with an unrestricted Redis token. **Existing credentials and workers are not revoked by this code.** |

## Containment behavior

- A server KV record carries `isolated`, `local`, or `ssh` authority. Worker
  configuration, archives, events and MCP schemas cannot set it. Legacy rows are
  initialized when the manager starts; conflicting parent ancestry fails closed.
- Children inherit the parent's ceiling. `same` and default delegation resolve
  from the actual parent runner. Direct child creation, recursive delegation,
  stored placement, default changes and launch/retry all enforce the boundary.
  A folder-backed local provider cannot masquerade as an isolated provider.
- A task moved into isolation loses its prior host authority. A later host move
  needs fresh human elevation. Elevating a parent does not elevate existing
  descendants. Active turns cannot have their ceiling widened.
- The explicit elevation API requires enabled authentication, an authenticated
  session and confirmation. Authenticated browser runner selections and trusted
  server-side whole-message runner picks preserve normal human workflows.
  Open-access mode cannot call the elevation API.
- A team credential is still a powerful control-plane credential, not a
  task-scoped token. Other trusted REST task/project/settings routes remain
  available to an authenticated operator. An exposed open-access server can also
  create new top-level host tasks: the ceiling does not make that deployment safe.

## Archive acceptance and compatibility

Compressed input is a regular file up to 512 MiB. Expanded TAR data is limited to
512 MiB, each file to 128 MiB, members to 50,000, and extension metadata to 64 KiB.
Validation and canonical repacking each have a 60-second deadline. Parsing is
incremental, checks TAR checksums and complete end markers, and never gives
untrusted headers to the system extractor.

Every member belongs to the server-selected task root. Absolute paths, traversal,
backslashes, control characters, duplicate/case/Unicode-normalized aliases, links,
devices, FIFOs and unsupported metadata are rejected. PAX paths and GNU long names
are supported; ownership, ACLs, xattrs and special mode bits are not restored.
Files are created exclusively in a fresh private directory with owner-only modes.

Server-owned task/run/auth/signing/control files are discarded. Git config, hooks,
worktree/submodule indirections and object alternates are discarded before Git
runs. Minimal trusted Git config is written; an empty alternates marker allows
the existing server-controlled mirror relink. The canonical archive contains only
the validated tree. Archive creation disables macOS AppleDouble metadata.

Normal whole, partial, thin and Git-first reconstruction remains covered by the
existing integration tests, including sequence preservation. Archives containing
links, unsupported Git layouts/platform metadata or oversized content now fail
closed and remain retained for recovery. Custom Git config and hooks do not
survive restore. Worktrees/submodules may require a fresh checkout. The existing
recap/fresh-checkout recovery path may run after refusal; it is not proof that
every archived unpushed file was recovered. No automatic archive deletion was
added.

## Resource bounds and their limits

Worker file reads default to 32 MiB and cannot request more. The worker opens a
regular nonblocking file, checks its resolved workspace boundary and actual size,
and reads at most the limit plus one; the server separately caps encoded bytes
and validates decoded length. Artifact reads use 25 MiB even when the event lies
about size. Files outside `work/`, including worker control files, are refused.
Repositories sharing a worker remain mutually untrusted within that same worker;
this root check is not a sandbox against a concurrent root process there.

Buffered command output is capped at 8 MiB, with a bounded stderr tail (64 KiB or
64,000 bytes depending on transport). Overflow fails with exit 153 or a bounded
transport error. Docker/SSH/local stream callback failures terminate the collector;
Daytona response iteration stops before an oversized body is JSON-decoded.
The Upstash exec wrapper uses a temporary worker-side stderr file and a random
delimiter; this is output framing, not a cryptographic trust mechanism. These
bounds do not promise a fixed process RSS or limit total retained data over time.

## Remaining risks, sorted by urgency

1. **Critical — installed Docker Desktop is vulnerable.** Read-only inspection
   found Desktop 4.43.2. Docker's advisory says CVE-2025-9074 allows a malicious
   container to reach the Engine and create containers without a mounted socket;
   the fix is 4.44.3 and ECI does not mitigate it. The source fixes cannot repair
   that runtime. This is a version/advisory finding, not an executed exploit.
   See the [host assessment and proposed upgrade](docker-desktop-upgrade-assessment.md)
   and [Docker's announcement](https://docs.docker.com/security/security-announcements/#docker-desktop-4443-security-update-cve-2025-9074).
2. **High — reachable control-plane or daemon services remain decisive.**
   Container-to-host/LAN networking is not denied by this PR. A reachable
   unauthenticated/open Box Yard API, leaked shared team credential, unauthenticated
   daemon TCP endpoint, or other vulnerable host service can defeat isolation.
   No live endpoint probing or credential tests were authorized/performed.
   Operators must restrict ingress/egress and require authentication; do not
   forward team API tokens into worker environments. Desktop has its own VM and
   networking backend, so Linux bridge/firewall assumptions are insufficient.
   [Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)
3. **High — old shared Redis credentials require rollout action.** Old workers
   can keep the old unrestricted authority until retired and credentials rotated.
   Existing Redis directory/notes data and server-side publishing/cleanup are not
   erased by this PR. New file-based events are still forgeable within a shared
   worker filesystem; this change does not isolate tasks from root in their own
   shared container.
4. **High — Upstash SDK framing can buffer before application limits.** The
   installed `@upstash/box` 0.7.x SDK's `_parseExecStream` can retain an unterminated
   exit-event payload before yielding any callback. Its `_execStream` also retains
   yielded output. Callback byte caps reduce ordinary output accumulation but
   cannot bound this pre-parser path. A hostile Upstash worker with output access
   can still cause server memory pressure. A separately reviewed bounded raw
   transport or a provider-fixed parser is required; no private SDK method override
   or unverified provider protocol replacement is included here.
5. **High — shared worker and credential scope remain broad.** Root-capable tasks
   on one project's shared container can read or modify other tasks, mirrors,
   identity state and task-scoped secrets accessible there. Credentials intentionally
   supplied to a repo can be used by arbitrary repo code. Use narrowly scoped Git
   and model credentials and avoid mixing hostile trust domains on one worker.
   The Docker image's non-root account has passwordless sudo; `USER` alone is not
   a non-root security boundary (`docker/Dockerfile:35`). No per-task OS boundary
   or credential broker is added.
6. **Medium/High — aggregate denial of service and runtime hardening remain.**
   Per-file caps do not impose lifetime artifact/log/event quotas, disk quotas,
   concurrent restore limits, network rate limits, or Git-pack CPU/memory limits.
   Malformed Git data still reaches Git during reconstruction. Docker run arguments
   set CPU/memory and PID limits, but this PR does not add a capability drop,
   `no-new-privileges`, read-only root filesystem, user namespaces, network policy
   or stronger image provenance (`server/providers/docker.ts:200`). Default
   seccomp is useful and should not be disabled; it is not an escape guarantee.
   [Docker Engine security](https://docs.docker.com/engine/security/),
   [Docker seccomp](https://docs.docker.com/engine/security/seccomp/).

## Verification actually performed

Static review covered the changed dispatch, MCP/API, provider, restore and artifact
paths, plus the installed SDK parser. Offline fixtures exercised the real relevant
dispatch/restore/read code. No container escape, hostile live request, credential
read, network enumeration, daemon reconfiguration or production data deletion ran.

- `test/task-containment.test.ts`: real task dispatch for all three harnesses;
  recursive/same/default children; forged placement and folder-local fallback;
  persistence after restart and project-default change; authenticated elevation
  API and composer; trusted versus model-supplied MCP runner picks; Redis omitted.
- `test/safe-archive.test.ts`: sibling/traversal/link/special/alias/truncation/bounds
  fixtures, PAX long paths, actual restore rejection before upload, malicious Git
  hook/config removal, and a pre-existing destination symlink with an untouched
  fixture sentinel. Only temporary fixtures were used.
- `test/worker-files.test.ts`: real file/output collectors, dishonest size,
  overflow cancellation, regular-file/workspace checks and real artifact dispatch.
  The Docker CLI collector test uses a Node subprocess, not a live daemon.
- `test/daytona.test.ts`: synthetic streamed HTTP response cancelled at its byte
  bound before full JSON retention.
- Existing archive integration coverage: seven files, 58 passing tests (whole/
  partial/thin/Git-first, streaming/shutdown); focused provider coverage: five
  files, 94 passing tests. No provider purchase/live smoke test was performed.

The final stable-HEAD gate and its exact results belong in the remediation PR.
Passing tests demonstrate these cases, not the absence of escapes. The read-only
host inventory is explicitly separate in the upgrade assessment. No post-upgrade
or Linux-host runtime validation has occurred.

## Review and rollout

1. Review the security PR at high risk; preserve `no-automerge`. Audit PR #17 is
   evidence only and remains a separate review decision.
2. Obtain owner approval for the Desktop maintenance window/runbook before any
   host change. Until then, the runtime finding remains unresolved.
3. Deploy the reviewed code with new worker configuration; retire legacy workers
   and rotate shared Redis authority in an approved window. Do not assume a code
   deployment revokes old credentials.
4. Confirm authenticated control-plane access, absence of team tokens in worker
   environments, daemon access restrictions and the intended host/LAN network
   boundary without exploiting them.
5. Review the remaining provider buffering, aggregate quotas, shared-project trust,
   image pinning and container hardening as follow-up work. A revert restores the
   previous weaker behavior; it does not reset saved ceilings, rotate credentials,
   undo human elevations or roll back runtime upgrades.
