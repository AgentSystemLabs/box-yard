# Docker Desktop host upgrade assessment

Assessment date: 2026-11-07. **Read-only assessment; no upgrade or workload change
was performed.** Installation, downloads, restarts, configuration changes and task
interruption require a separate owner approval. Public evidence omits private
container names, IDs, paths, environment values and workload content.

## Decision required

Approve a maintenance window to move the inspected Apple Silicon host from
Docker Desktop **4.43.2 (199162)** to the official current **4.98.0** release
(2026-11-03), subject to a fresh release/compatibility check at execution time.
Docker's release page provides architecture-specific installers and checksums;
rollout availability may lag publication.
[Official release notes](https://docs.docker.com/desktop/release-notes/#4980).

This is a security priority: Docker's CVE-2025-9074 advisory states that a malicious
container can reach the Engine and start containers without a mounted Docker
socket, potentially reaching host files. Version 4.44.3 fixed that issue; ECI does
not mitigate it. The installed version predates the fix. No exploit was attempted.
Updating only the Box Yard image or npm dependencies cannot fix Desktop itself.
[Official security announcement](https://docs.docker.com/security/security-announcements/#docker-desktop-4443-security-update-cve-2025-9074).

## Inspected facts and limits

| Item | Read-only result | Limits |
| --- | --- | --- |
| OS / architecture | macOS 26.5, arm64 | No OS changes proposed. |
| Desktop app | 4.43.2, build 199162; conventional Applications app | App metadata read, no settings/logs/credentials read. |
| Engine client / server | 28.3.2 / 28.3.2 | Only the selected reachable context was inspected. |
| Runtime | containerd 1.7.27; runc 1.2.5; docker-init 0.19.0 | No runtime exploit or daemon configuration read. |
| VM | Kernel 6.10.14-linuxkit; aarch64; 4 CPUs; 6,213,808,128 bytes memory | Desktop VM resources, not the entire host capacity. |
| Live restore | `false` | Running workloads cannot be assumed to survive Engine restart. |
| Installation method | No Docker cask in filtered installed Homebrew inventory; no matching package receipt; app present | Consistent with app/manual/self-updater installation, but original provenance is **not proven**. Do not assume Homebrew manages it. |
| Staged updater | Known updater/cache locations and shallow installer-name checks did not show an update | **Unknown.** This limited check cannot prove that no staged update exists. Updater databases, preferences and private logs were not read. |
| Containers | Selected-context snapshot: 2 total, 1 running, 1 exited; both labelled `boxyard=1` | No unrelated container appeared in that snapshot. Other contexts, later workloads and non-Docker services are unverified. |
| Running workload | 20 published ports; volume mounts; restart policy `no`; no health check; no explicit stop timeout/signal | Names/IDs/paths omitted. Needs explicit lifecycle recovery, not assumed restart-policy recovery. |
| Shell routing | `DOCKER_HOST` and `DOCKER_CONTEXT` unset in the audit shell | The live server's environment was not read. |

Checks used app/OS version metadata, filtered package inventory, minimal Docker
version/info/inspect fields and limited updater file metadata. They did not print
container environments, inspect volumes, enumerate user documents, or read
credentials/chat data. The official upgrade-navigation URL returned an
`InternalError`/unavailable response; the official release notes and Mac install
page were available. No fallback installation or download was attempted.

Docker documents support for the current and two previous major macOS releases,
with at least 4 GB RAM. The inspected OS/architecture meet the published broad
requirements; this is not a complete compatibility or storage-space check.
[Mac installation requirements](https://docs.docker.com/desktop/setup/install/mac-install/#system-requirements).

## Expected disruption

Replacing/relaunching Desktop is a VM/Engine maintenance event. Every still-running
container in that Desktop VM may stop or lose connectivity, including unrelated
workloads added after this inventory. The inspected running container's 20 port
forwards/previews will be unavailable. Active commands, worker polling and Git
push/archive completion may be interrupted unless drained first. Downtime cannot
be predicted from these checks; disk migration, app startup and health recovery
were not rehearsed.

A paused container is not a durable scheduling barrier across a VM restart. With
live restore disabled and restart policy `no`, recovery must be explicitly
coordinated. Persistent volumes are expected to remain through an in-place app
upgrade, but data preservation still needs an approved backup/recovery plan.
No factory reset, volume pruning or uninstall is part of this proposal.

## Proposed execution sequence — approval required before step 1

1. **Approve the window and recovery plan.** Confirm target Desktop 4.98.0 (or a
   newly reviewed patched release), Apple Silicon architecture, available space,
   ownership of every affected workload, backup location and stop timeouts. Decide
   who can resume Box Yard if its server or this local audit session is stopped.
   Recheck the official release/security notes immediately before execution.
2. **Reinventory safely.** Run filtered `docker version`, `docker info` and
   `docker ps -a` for each owner-identified relevant context. Record IDs privately,
   labels, volume identity, health and restart policy. Ask owners about databases
   and unrelated services; the earlier snapshot is not an all-host inventory.
   Do not output environment/secret fields or copy credentials into a report.
3. **Freeze dispatch and drain.** Coordinator/operator prevents new Docker tasks,
   retries and scheduled work; save the prior enabled state of applicable
   schedules before disabling them. No global dispatch-pause API was found, so
   use an explicit operator barrier and stop the Box Yard service only after
   draining. Wait for current turns, end-of-turn pushes/archives and task
   `current_turn_id` to clear, and Captains to become idle. Do not substitute
   task Stop without separate owner approval. Preserve an application-consistent
   Box Yard database backup and owner-approved volume/database backups.
4. **Gracefully stop approved workloads.** Use each service's documented shutdown
   and the exact approved container IDs/timeouts. Verify the drained set is stopped
   and repeat the inventory. Do not use broad stop/remove/prune commands. Quit
   background tools that call Docker after their work is drained. Owner-controlled
   Box Yard shutdown must prevent automatic redispatch while Desktop is down.
5. **Perform the approved app update.** Quit Docker Desktop. Obtain the official
   Apple Silicon installer from the reviewed release page, check its published
   checksum and macOS signature/notarization, mount it and replace the existing
   Docker app using the official procedure. Keep the installer volume mounted
   until installation completes. Do not use `brew upgrade` unless Homebrew
   ownership is independently established. Do not reset Docker, uninstall with
   data removal, delete volumes or change daemon configuration.
   [Official Mac install/update instructions](https://docs.docker.com/desktop/setup/install/mac-install/).
6. **Verify before resuming.** Start Desktop; inspect Desktop/Engine/containerd/
   runc versions, selected context and minimal security/resource settings. Confirm
   the runtime is on the patched release, volumes and stopped-container inventory
   are preserved, and no unexpected services started. Restart workloads through
   their owning lifecycle manager in the agreed order. Check health and expected
   ports, including any unrelated services. A new harmless Box Yard fixture is
   optional only with owner authorization; do not run an escape probe.
7. **Resume scheduling deliberately.** Restore saved schedule states and release
   the new-work barrier after health checks. Confirm Box Yard worker readiness,
   normal task execution, push/archive completion and preview recovery. Record
   versions and any errors without private data. If recovery fails, keep dispatch
   blocked and consult the owner; do not automatically downgrade an upgraded data
   store or delete/recreate volumes.

## Unverified and unresolved

This work did not stage or install an update. Staging status, original install
provenance, whole-host workload inventory, backup readiness, exact downtime,
post-update behavior and rollback compatibility remain unverified. Network
reachability and a complete daemon hardening review were not tested. Upgrading
Desktop does not remediate application-level authorization, archive, credential
or shared-worker boundaries; see the [remediation report](runner-remediation.md).
