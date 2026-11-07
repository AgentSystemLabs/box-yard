# Container runner isolation audit — 7 November 2026

**Verdict: do not treat the current Docker runner as a boundary for hostile tasks on a valuable host.** The ordinary container launch avoids host directory and socket mounts, but two critical findings defeat the intended protection: the inspected Docker Desktop version has a published daemon-access vulnerability, and the worker protocol permits a Docker task to request an unsandboxed local child. Updating Docker alone does not fix the application boundary. This assessment provides no guarantee against container escapes.

This is a review deliverable, not a remediation release. No production runner, daemon, container or security policy was changed. Critical/high findings were sent to the project's Captain during review.

## Scope and evidence

Source: public `AgentSystemLabs/box-yard`, main commit [`7a8eea9c4c4e766e3e1664bfea088ba2830c01e9`](https://github.com/AgentSystemLabs/box-yard/tree/7a8eea9c4c4e766e3e1664bfea088ba2830c01e9), which matched the remote main ref at audit start. References below name that source snapshot; this PR changes only documentation and an explicitly invoked offline fixture. Read the repository's `AGENTS.md`, `CLAUDE.md` and PR-description instructions; no CONTRIBUTING or `.github` guidance was present.

Threat actor: arbitrary malicious shell code, repository files, build tools, agent output and protocol events inside a task container. Agent CLI shell access is intentional. Assets: host files/processes/services/credentials, other tasks/projects, the Box Yard control plane and Docker daemon. The host OS user and Box Yard administrator are trusted; a target repository and its install scripts are not. Prompt instructions are not an access-control boundary.

Evidence classes:

- **Source:** launch/build/configuration, provider routing, worker and privileged MCP, API/browser authentication, credentials, event bus, transfer/archive/restore and cleanup code. All three supported task harnesses were traced: Claude, Codex and Cursor.
- **Runtime:** read-only Docker CLI version/info, enumeration of `boxyard=1` containers, and selected inspect fields. No `docker exec`, socket/TCP probes, network scans, image builds/pulls, container starts/stops or runtime mutations. Names, mount sources, IDs, labels and environment values were omitted. No private app database/configuration or credentials were read. The live server's code revision was not identified.
- **Offline fixtures:** actual application methods against inert stores/providers and disposable filesystem markers inside this checkout. No running app, daemon, agent, scheduler, credentials or remote services. These establish specific behavior; they do not demonstrate an actual host breakout.

## Findings, ordered by risk

### C1 — Critical: inspected Docker Desktop predates a known socketless daemon-access fix

**Observed runtime:** Docker Desktop **4.43.2 (199162)**, Engine **28.3.2**, containerd **1.7.27**, runc **1.2.5**, LinuxKit **6.10.14**, arm64 macOS host. Two Box Yard-labelled containers were inspected, one running and one stopped.

Docker's [CVE-2025-9074 advisory](https://docs.docker.com/security/security-announcements/#docker-desktop-4443-security-update-cve-2025-9074) describes malicious containers accessing Docker Engine and launching additional containers without a mounted Docker socket, potentially accessing host user files. The fix shipped in Desktop **4.44.3**; Docker explicitly says ECI does not mitigate this vulnerability. The inspected version precedes that fix. This is a version/advisory match, not exploitation or proof of a particular reachable endpoint.

**Precondition/impact:** malicious code in an affected Desktop container; possible daemon control and unauthorized host-file access, subject to platform file-sharing permissions. The absence of a socket mount is insufficient mitigation. Source [`server/docker/engine.ts:62`](../../server/docker/engine.ts#L62) checks availability and records Engine version but has no Desktop security-version gate.

**Priority 0:** have the host owner coordinate an upgrade to a currently supported, patched Docker Desktop and its bundled runtimes before further hostile workloads. 4.44.3 is the minimum fix for this one CVE, not a recommendation to install that old release today. Preserve unrelated workloads and coordinate any restart; this audit did neither. Verify versions and inspect settings again afterward. Other runtime CVEs were not exhaustively assessed.

### C2 — Critical: a Docker worker can select an unsandboxed local descendant

**Source chain:**

1. The worker writes its own events in [`runner/box-runner.mjs:129`](../../runner/box-runner.mjs#L129). File events are parsed without authentication in [`server/bus.ts:42`](../../server/bus.ts#L42); sequence numbers deduplicate, rather than authorize, events (`:141`). Arbitrary shell code can produce the same bytes without calling an MCP tool.
2. [`server/tasks.ts:7184`](../../server/tasks.ts#L7184) dispatches `spawn_subtasks`. [`server/subtasks.ts:38`](../../server/subtasks.ts#L38) accepts every Runner, including `local` and `ssh`.
3. [`server/tasks.ts:7833`](../../server/tasks.ts#L7833) checks availability, then `:7853` records the requested runner on the child. There is no containment ceiling inherited from a Docker parent. `requireRunner` (`:1125`) checks harness/runner availability; `createTasks` (`:1197`) checks the identity runner allowlist. [`server/identity/identities.ts:695`](../../server/identity/identities.ts#L695) permits every runner when that allowlist is null.
4. [`server/providers/local.ts:87`](../../server/providers/local.ts#L87) launches host `bash`; the local runner explicitly provides no sandbox (`:190`).

**Preconditions:** a running Docker parent, remaining subtask depth/count, identity permitting local execution, available host harness and scheduling capacity. A restricted identity excluding local blocks that particular request, but Docker placement itself does not. The same design can request SSH execution where permitted. Prompt text telling agents to seek approval does not constrain malicious repository code forging events.

**Impact:** an attacker can have a task started with a host-execution context, outside Docker isolation. The child prompt is attacker-controlled; an actual harmful command still requires the harness to act on it. This audit did not launch a child or ask a real harness to execute anything. The offline fixture follows the real event dispatch, spawn, availability, identity and task-creation methods and observes `runsOn: local` accepted while scheduling remains stubbed.

**Priority 0:** impose a server-owned runner policy inherited by all descendants. A contained task must never grant itself local/SSH execution or loosen its identity. Any authorized elevation must come through a separately authenticated human control-plane action. Check effective parent placement as well as explicit `runs_on`, including grandchildren and `same`; enforce restrictions at task creation and placement, not just in tool schemas. Existing restricted identities can reduce exposure while this is fixed, but are not a complete security assessment.

### H1 — High, conditional: shared Redis authority lets workers impersonate other tasks

[`server/tasks.ts:6567`](../../server/tasks.ts#L6567) sends the configured Redis URL/token to each worker alongside its event key. [`runner/box-runner.mjs:105`](../../runner/box-runner.mjs#L105) uses this bearer directly for REST commands. [`server/bus.ts:100`](../../server/bus.ts#L100) trusts events read from a task's stream; [`server/tasks.ts:7075`](../../server/tasks.ts#L7075) deduplicates and applies them. There is no per-task event MAC or Redis credential attenuation in this path. Most event handlers do not require a matching current turn; the compaction-history handler's explicit check at `:7159` is an exception.

**Preconditions:** Redis mode enabled and the configured token can write other tasks' keys (for example, an ordinary database-wide credential). Redis ACLs were **not** inspected; this finding is conditional, not a claim that the deployed installation uses Redis or a broad token. Knowing a key/turn/sequence is not equivalent to possessing secret authorization: identifiers may be discoverable and sequence numbers are predictable.

**Impact:** cross-project event forgery, task-state corruption and unauthorized subtask requests. A forged artifact event for an actively polled **local** task asks its provider to read the supplied path (`tasks.ts:7246`), and [`server/providers/local.ts:128`](../../server/providers/local.ts#L128) performs a host `readFileSync` without workspace confinement. Bytes can enter the hosted artifact store; retrieval or onward transfer still needs an available authorized path, such as an active local agent. This makes shared event-store authority materially more powerful than reporting progress.

**Priority 1:** remove the database-wide token from workers. Prefer server-side polling without worker Redis credentials, or credentials/relay authorization restricted to one task and event operation. Authenticate event identity and turn independently of the worker's body; do not put a shared signing key in worker-readable storage. Validate event schemas and task state before side effects, and confine artifact reads even for local tasks. Rotate exposed broad credentials only through an owner-approved remediation after scope is established.

### H2 — High: hostile archives and links cross the workspace/host restore boundary

[`server/tasks.ts:8380`](../../server/tasks.ts#L8380) stores worker-produced archive bytes. [`server/archive.ts:250`](../../server/archive.ts#L250) decodes framing; `archiveOutcome` (`:319`) checks compressed size and reported pipeline status, not tar entries, links, expanded size or provenance. A root-capable malicious worker can replace tools/output, so its tar command/excludes are not a validation boundary.

[`server/tasks.ts:6620`](../../server/tasks.ts#L6620) extracts directly into the destination tasks root with `tar xzf`, without a per-task member allowlist or a fresh validated staging directory. A valid archive can name a sibling task. Ordinary tar creation also preserves symlinks in metadata such as `turn.json`. Later server metadata writes (`tasks.ts:6065` and `:6067`) reach [`server/providers/local.ts:123`](../../server/providers/local.ts#L123), which follows symlinks. Git metadata and configuration restored before checkout are also executable trust when moved to an unsandboxed runner.

**Preconditions/impact:** restoration of worker-controlled archives, especially a Docker-to-local/SSH migration or reuse of a destination containing links. Within a container this can overwrite sibling tasks; restoration onto the host can write outside the intended task folder, and restoring hostile repositories/configuration also creates execution risk. Local migration is already an explicit trust elevation; archive safety is additionally needed to prevent collateral writes outside that workspace. This is **not** a claim that GNU/BSD tar blindly accepts every `../` or absolute member: archive members need no traversal to target a sibling, and links remain dangerous during later writes.

**Fixture evidence:** a tiny tar archive extracted a sibling marker and preserved `turn.json -> ../../outside-marker`; the real local metadata write replaced that scratch sentinel. All paths remained inside the fixture's disposable checkout directory. Linux GNU tar was not run; the installed macOS tar was used.

**Priority 1:** treat archive data as hostile. Enforce one expected task prefix, reject absolute/traversal paths and unsafe symlink/hardlink/device/FIFO entries, bound compressed and expanded bytes and entry count, extract into fresh staging, and promote only validated content. Protect subsequent metadata writes against symlinked components with directory-relative/no-follow operations and atomic regular-file replacement. Strip/recreate server-owned metadata and runner state; avoid executing restored Git hooks/helpers/config on the host. Do not migrate untrusted work to local/SSH without explicit authorization.

### H3 — High: host-side reads and persistence bypass container resource limits

[`server/tasks.ts:7248`](../../server/tasks.ts#L7248) checks the artifact's **claimed** size before reading its arbitrary path. [`server/providers/docker.ts:340`](../../server/providers/docker.ts#L340) runs `cat -- <path>` with a 120-second timeout. [`server/docker/cli.ts:45`](../../server/docker/cli.ts#L45) accumulates stdout without a byte cap and concatenates it at exit. [`server/artifacts.ts:56`](../../server/artifacts.ts#L56) enforces 25 MB only after the buffer reaches the host. Device/FIFO/very large file input or falsified size can consume host memory before that check. No such input was sent to a live provider; the fixture uses 32 synthetic bytes and a synthetic 16-byte downstream quota to establish the ordering.

Disk exposure also remains: workspace volumes and writable root layers have no application-enforced quota, no total archive/artifact budget, and no log rotation flag is supplied (`providers/docker.ts:199`). Inspected containers use `json-file` with no log options. Docker [documents the disk-exhaustion risk of unrotated json-file logs](https://docs.docker.com/engine/logging/configure/). Idle stop does not reclaim volumes. A compressed archive size cap does not bound expansion during restore.

**Preconditions/impact:** one active malicious worker can request excessive host buffering or fill daemon-backed storage; repeated events/files can amplify this. Host-side Node memory/disk consumption is outside that container's cgroup, potentially disrupting Box Yard and unrelated applications. The configured CPU/RAM/PID limits do help against direct in-container resource use; they do not close these paths.

**Priority 1:** stream provider reads with enforced byte limits and abort on limit, validate real regular-file type and size within a confined root, cap event/frame/line lengths and outstanding operations, and enforce per-task plus installation storage/retention budgets. Plan container log rotation and volume/storage quotas with the host owner. Check and surface failed resource updates: `providers/docker.ts:155` currently discards `docker update`'s exit status.

### M1 — Medium, high impact if a reachable service is weak: network isolation is absent

[`server/providers/docker.ts:199`](../../server/providers/docker.ts#L199) sets no dedicated network or egress policy. Inspected containers use the default `bridge`. Docker [documents unrestricted communication between containers on the same bridge](https://docs.docker.com/engine/network/drivers/bridge/) and [host service access via host.docker.internal on Desktop](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/general/#how-do-i-connect-from-a-container-to-a-service-on-the-host). A Linux bridge gateway can expose listening host services even when that Desktop name is absent; `host-gateway` is not a protection mechanism. No reachability probes or service authentication checks were performed.

**Impact/preconditions:** access to other projects' previews and any reachable databases, LAN services, metadata endpoints, daemon TCP endpoints or control-plane listeners. A network path alone does not defeat a sound authenticated service. Loopback-only published ports limit host ingress exposure, but do not isolate same-bridge peers or restrict outbound traffic.

Box Yard API authentication is a shared team login: [`server/auth.ts:95`](../../server/auth.ts#L95) allows requests when no password is configured. Default binding is loopback (`server/bind.ts:7`), and a non-loopback open deployment requires `ALLOW_OPEN` (`:24`). A reachable open/misconfigured deployment or stolen team login can create `runsOn: local` tasks (`server/app.ts:1365`) or switch a task (`:1384`). [`server/browserBoundary.ts:56`](../../server/browserBoundary.ts#L56) checks browser Host/Origin; an arbitrary process can choose those headers, so this is not worker authentication. Protected deployments still require valid authentication; no password bypass was demonstrated.

**Priority 1/2:** separate each project's network, deny task access to host/control-plane, other bridges, LAN/private/link-local ranges and daemon APIs at a boundary the task cannot reconfigure; explicitly allow needed internet endpoints or use a controlled proxy. Keep independent authentication on all exposed services and the API even on loopback. Changing a Docker network alone does not deny host or internet egress. User-owned firewall/daemon changes need coordinated review, not an automatic audit action.

### M2 — Medium: container root and mutable runtime state increase attack surface

[`docker/Dockerfile:28`](../../docker/Dockerfile#L28) gives `agent` passwordless sudo. UID 1000 is therefore not a durable least-privilege boundary. Custom images may start as root. [`server/providers/docker.ts:199`](../../server/providers/docker.ts#L199) does not set `cap-drop`, `no-new-privileges`, read-only root, user-namespace policy or a specific mandatory-access-control profile. It does not request privileged execution, added capabilities, host PID/IPC/network, devices or an unconfined seccomp profile either.

Runtime info reports builtin seccomp; inspect reports no explicit security options, capability drops or userns override, writable rootfs and an empty AppArmor profile. These fields do not prove actual process capability masks, seccomp filters, UID maps or ECI status; no in-container process inspection was performed. On Linux, daemon/kernel support controls whether Docker's [default seccomp](https://docs.docker.com/engine/security/seccomp/) and [AppArmor](https://docs.docker.com/engine/security/apparmor/) protections apply.

**Impact:** larger kernel/runtime attack surface and easy persistence in shared container state, not proof of a new kernel exploit. All tasks in one project share a container, UID/sudo, process namespace, workspace, mirrors, cache and credential tmpfs (`providers/docker.ts:63`, `:252`). One compromised task can tamper with peers and future turns and read their credentials. Modes 0700/0600 do not separate processes with the same UID/root. Containers and volumes persist across tasks/stops; a stopped old-image container is replaced on wake (`:143`), but a running container returns before image reconciliation (`:140`). Separate project volumes are positive, but default network and H1 remain cross-project paths.

**Priority 2:** for hostile tasks, remove sudo, enforce a non-root user, drop all capabilities with only justified additions, set `no-new-privileges`, and design writable tmpfs/workspace exceptions to a read-only root. This changes the current apt-install workflow and needs compatibility review. On native Linux evaluate [rootless Docker](https://docs.docker.com/engine/security/rootless/) or [userns remapping](https://docs.docker.com/engine/security/userns-remap/); on Desktop evaluate [ECI](https://docs.docker.com/desktop/enterprise/hardened-desktop/enhanced-container-isolation/) where available. Neither substitutes for patching C1 or fixing application authority. Use one disposable container/credential boundary per untrusted task when same-project isolation is required.

### M3 — Medium: credential exposure and image provenance are broader than the isolation claims

Good controls: credentials enter through stdin and a tmpfs (`providers/docker.ts:205`, `:324`), not run arguments or the built-in image. Signing/Codex auth files are held there too; archives exclude known credential filenames (`tasks.ts:8389`). Git credential helpers reset the helper list rather than write a credential store (`docker/gitconfig`, `server/tasks.ts:6805`). Dockerfiles are scanned for recognizable or known secrets and build logs redacted (`server/docker/images.ts:168`).

Limits: task code intentionally receives its GitHub/LLM/signing/connector credentials (`tasks.ts:6042`, `:6050`, `:6567`). tmpfs cannot hide them from that task, same-UID peers, root or a malicious image. A broad fallback GitHub login may authorize other repositories (`server/turnCredentials.ts:66`); publishing/pushing inside that grant is intentional authority, not by itself a host escape. Prefer short-lived repo-scoped credentials. tmpfs can [be persisted through swap](https://docs.docker.com/engine/storage/tmpfs/); the source explicitly permits swap (`providers/docker.ts:176`), so “in memory only, never disk” is too strong. Agents may also copy or encode secrets into logs or arbitrary files; filename excludes/redaction are not data-loss prevention. Codex additionally returns refreshed auth to the control plane (`server/tasks.ts:6383`); adoption checks login shape, account continuity and freshness (`server/credentials.ts:157`, `server/agentLogins.ts:374`). This intentional shared-login handback needs bounded input and does not create a per-task credential boundary. No real credential, log contents, signing key or connector config was read.

[`docker/Dockerfile:6`](../../docker/Dockerfile#L6) uses a mutable base tag and `:24` installs unpinned agent CLIs. [`server/docker/images.ts:33`](../../server/docker/images.ts#L33) hashes local source, not resolved dependencies; `:127` reuses present images, with no forced freshness/provenance gate. Cursor is installed on demand with an unpinned HTTPS installer (`server/tasks.ts:6366`). Custom images and Dockerfiles are administrator-controlled executable supply-chain inputs; project Captains can update project Docker settings (`server/mcp.ts:880`) within their existing privileged authority. Custom Dockerfile builds use a fresh directory containing only that Dockerfile (`images.ts:174`), avoiding the target repo/host home as context. The built-in build sends `docker/` as context (`:143`); its hash/secret scanner lists two files, which is not itself a context allowlist. Key scans cannot establish image safety or catch encoded/unknown secrets. Overriding entrypoint to sleep does not sanitize malicious binaries or image configuration.

**Priority 2:** pin reviewed image digests and CLI versions, track resolved provenance and rebuild on a security-update schedule; Docker's [build recommendations](https://docs.docker.com/build/building/best-practices/) cover digest pinning and fresh rebuilds. Keep build contexts explicitly minimal, image/Dockerfile changes privileged, and builder network/resource access constrained. Document intentional credential grants and use per-task credentials rather than relying on tmpfs to limit authority. Ensure secrets are removed on all turn-end/crash paths, considering background processes and swap policy.

## Boundaries that held in the reviewed launch path

| Boundary | Source evidence and practical limit |
| --- | --- |
| Host filesystem/socket mounts | `providers/docker.ts:203–205` requests one project named volume plus the credential tmpfs; no host bind or docker.sock. Both inspected containers matched. This blocks ordinary direct filesystem access, subject to C1 and other boundary crossings. |
| Host processes/devices/namespaces | Launch requests no privileged mode, devices, host PID/IPC/network or extra capabilities. Inspect showed `Privileged=false`, no devices/DeviceRequests, empty PidMode, private IPC and bridge network. Default container devices still exist. |
| Host shell argument handling | Docker CLI uses `spawn(bin, args)` (`server/docker/cli.ts:40`); commands travel on stdin (`providers/docker.ts:271`). POSIX `q()` escapes apostrophes (`providers/types.ts`); image references have a restricted validator (`server/docker/settings.ts:7`). No direct host-shell injection was established for task/project refs, env values, repository paths or metadata in this path. Root-controlled worker output and restored Git config are still untrusted execution boundaries. |
| Privileged HTTP MCP | Worker tools use local stdio/events. The separate `/mcp` requires a Coordinator/Captain/thread bearer (`server/mcp.ts:3546`); Captain tools use project scopes (`:298`). These powerful tokens are not included in normal Docker task JSON. A scoped Captain remains privileged to manage its own project and runners; possession is not merely a worker callback grant. No worker HTTP readiness/upload bearer is needed: server writes files and polls events. |
| Browser artifacts/uploads | API routes have shared auth (`server/app.ts:987`). Artifact save sanitizes the filename and chooses a random destination (`server/artifacts.ts:56`); uploads use generated folders and bounded bytes (`server/uploads.ts:28`). Hosted bytes get `nosniff` and CSP sandbox with no `allow-same-origin` (`server/thumbs.ts:123`); HTML previews add iframe sandbox (`web/src/components/FilePreview.tsx:259`). No same-origin artifact script takeover was established. The upstream arbitrary read/size issue H3 remains. |
| Cleanup ownership | Stop/destroy/volume removal check install labels (`providers/docker.ts:372`, `:384`, `:472`); unrelated resources are not globally pruned. Existing-container command paths trust the server's naming/routing and daemon integrity. Stopping keeps volumes; deleting removes the labelled container/volume, not remote credentials or exported copies. |
| Harness permissions | Claude bypasses CLI permission prompts (`runner/box-runner.mjs:674`), Codex uses `danger-full-access`/`never` (`:1025`), Cursor disables sandboxing (`:1356`). Isolation must therefore come from the runtime and server authorization for **all three**; harness prompts are not extra containment. Mock Docker is explicitly local folders with no isolation (`server/providers/dockerFolders.ts:9`), and cannot prove real Docker security. |

## Actual runtime snapshot and unverified deployment facts

Both inspected containers had: user `agent`, no added/dropped capabilities, no explicit security options, writable root, no userns override, no device requests, `PidsLimit=4096`, CPU quota **2**, memory **4 GiB**, memory+swap **8 GiB**, `/run/boxyard` tmpfs `rw,nosuid,nodev,noexec,size=16m,mode=0700`, and host-published ports bound only to `127.0.0.1`. Named volume destination was `/workspace`; no bind/socket mount appeared. No expected credential keys appeared among the inspected image environment key names; environment values were never displayed. This does not inventory runtime process env, task files or image history.

Daemon info: Docker Desktop/Linux arm64, cgroup v2, overlay2, builtin seccomp and cgroup namespaces, four CPUs and about **5.8 GiB** memory for the shared VM. Per-container 4 GiB limits are not an aggregate host budget. Empty `AppArmorProfile` and absence of rootless/userns in reported security options are observations, not a complete UID-map/LSM audit. `DOCKER_HOST` and `DOCKER_CONTEXT` were unset in the **audit process**; [`server/docker/cli.ts:15`](../../server/docker/cli.ts#L15) inherits the server environment, so a deployment can select a remote daemon/context. The running server's environment/context was not inspected.

**Not verified:** daemon TCP listeners or API reachability, host/LAN/private-service reachability, host firewall/proxy policies, Desktop file-sharing scope/ECI settings, process capabilities/UID mappings/seccomp enforcement, live app bind/password/trusted origins, active identity runner restrictions/subtask settings, Redis mode/ACL, live callbacks, credential scopes, image digests/SBOM/signatures/vulnerabilities, expanded storage budgets, background processes or exact source/runtime revision parity. No Linux Engine, Windows/WSL, remote daemon, alternative custom image or real Claude/Codex/Cursor container turn was exercised.

Platform interpretation: native Linux Engine containers share the host kernel; Docker Desktop puts Linux containers in a VM, which adds a boundary before macOS but still exposes host networking/file-sharing integration. Container root is not automatically macOS root; Docker [documents this distinction](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/). Neither platform distinction prevents the server deliberately launching a local child. Keep daemon API access restricted to a protected Unix socket or authenticated SSH/TLS as [Docker recommends](https://docs.docker.com/engine/security/protect-access/); an unmounted socket does not establish absence of a vulnerable or TCP API path.

## Safe reproduction and verification

Run `npx tsx scripts/audit-container-fixtures.ts` from this checkout. It uses inert persistence/scheduling/provider seams, real dispatch/runner-policy methods and tiny tar/filesystem markers. It creates and removes only its own `.container-audit-*` directory in the current checkout. It never launches a child agent, reads real credentials or invokes Docker. True flags characterize exposures; they are **not** security regression passes and should change after fixes.

Observed output:

```json
{
  "characterization_only": true,
  "docker_parent_local_child_accepted": true,
  "children_launched": 0,
  "artifact_unconfined_path_requested": true,
  "artifact_quota_checked_after_read": true,
  "synthetic_bytes_read": 32,
  "archive_sibling_entry_extracted": true,
  "restored_metadata_symlink_followed": true
}
```

Focused existing coverage: Docker provider/fake CLI, subtask parser, event bus, archive stream, browser boundary, hosted-file CSP and credential selection. Test results and the stable committed HEAD typecheck/build/fast gate are recorded in the PR description. `test:docker` and other real-container tests were deliberately not run because they build/create/start/remove runtime resources. No full/slow suite or live attack was run. Green tests describe compatibility; they do not invalidate these findings.

## Remediation acceptance criteria

1. **Before hostile use:** owner-coordinated runtime update and fresh sanitized inspection; block Docker-to-local/SSH descendant escalation on the server, including forged events, effective project defaults and grandchildren. Review the identity runner allowlist as an interim constraint.
2. **Close host data paths:** per-task event authority, bounded/constrained reads, archive member/link validation and safe metadata writes. Negative regression tests must prove rejection before scheduling, host reads, extraction side effects or large allocations.
3. **Reduce blast radius:** isolate task networks and same-project tasks where needed; remove routine container root/sudo, enforce compatible hardening and storage/aggregate resource budgets. Include crash/background-process and cross-project reuse tests.
4. **Reassess on Linux and Desktop:** inspect actual enforcement and service reachability in an owner-approved disposable deployment. Test all three harnesses and runner switches. Keep source findings separate from deployment controls and retest remediations before changing the verdict.

No auto-merge is authorized for this audit. The report/fixtures are ready for review; the critical/high remediation work and host upgrade remain outstanding.
