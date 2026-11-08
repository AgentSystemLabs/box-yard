# Documentation audit — 2026-11-08

This is a dated coverage record, not a promise about future provider APIs or a deployment report. The audit started at public main `99db1a8` and includes the merged Captain trust guidance in `4bc75d0` (PR #28). Sources of truth were tracked code/configuration, application schemas, package scripts and existing tests. No runtime implementation, live settings, credentials or cloud resources were changed.

## Inventory and coverage

All 43 pre-existing documentation files are listed below, including instructions, the PR skill and all ten templates, legal notices and performance reports. This page is the 44th documentation file. Tracked-file discovery found no CONTRIBUTING file, `.github` directory, other Markdown/RST/MDX files, or separate setup/deployment/security/harness guides beyond these entries. README covers setup/deployment; provider, harness, identity and instruction docs carry their respective security guidance.

“Compared” means source/test inspection, not that every referenced integration test was run. Unchanged dated measurements and legal text were deliberately preserved.

| File | Coverage / disposition |
| --- | --- |
| [.claude/skills/pr-description/SKILL.md](../.claude/skills/pr-description/SKILL.md) | Used the PR-description skill for this audit; aligned gate, ready-PR and public image-link guidance with current instructions; retained review format. |
| [.claude/skills/pr-description/templates/01-benefit-groups.md](../.claude/skills/pr-description/templates/01-benefit-groups.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/02-before-after.md](../.claude/skills/pr-description/templates/02-before-after.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/03-category-table.md](../.claude/skills/pr-description/templates/03-category-table.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/04-story.md](../.claude/skills/pr-description/templates/04-story.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/05-release-note.md](../.claude/skills/pr-description/templates/05-release-note.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/06-user-journey.md](../.claude/skills/pr-description/templates/06-user-journey.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/07-collapsible.md](../.claude/skills/pr-description/templates/07-collapsible.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/08-bug-fix.md](../.claude/skills/pr-description/templates/08-bug-fix.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/09-scorecard.md](../.claude/skills/pr-description/templates/09-scorecard.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [.claude/skills/pr-description/templates/10-crate-map.md](../.claude/skills/pr-description/templates/10-crate-map.md) | Reviewed full template structure/TOC/proof/risk guidance; replaced stale full-suite gate. Diagram examples corrected where they used Rust paths, invalid subgraph IDs or worker callback arrows. |
| [AGENTS.md](../AGENTS.md) | Preserved test/commit/scoping policy; corrected task icon and Composer draft references against the UI. |
| [CLAUDE.md](../CLAUDE.md) | Import and PR-skill path resolve; no changes. |
| [LICENSE](../LICENSE) | Repository MIT attribution preserved. |
| [README.md](../README.md) | Setup, deployment, polling diagram, defaults, CLI capabilities, compaction and historical live checks; compared with config, settings, providers, runner and yard. |
| [docs/branch-names.md](../docs/branch-names.md) | Compared with server/branchNames.ts and test/branch-names.test.ts; no changes. |
| [docs/captain-icons.md](../docs/captain-icons.md) | Compared with shared/captainMark.ts, icon catalog/picker and test/captain-icons.test.ts; no changes. |
| [docs/codex-model-catalog.md](../docs/codex-model-catalog.md) | Catalog/efforts match shared/agentCli.ts; retained dated CLI snapshot, removed a transient authentication-repair claim. |
| [docs/codex-steering.md](../docs/codex-steering.md) | Compared with runner app-server adapter, server/tasks.ts and delivery tests; retained acceptance/uncertainty limits. |
| [docs/codex.md](../docs/codex.md) | Compared with server/codex.ts, server/credentials.ts, server/chatAgent.ts and runner/box-runner.mjs; installation coverage and token-refresh wording corrected. |
| [docs/compaction-history.md](../docs/compaction-history.md) | Compared with compactionIndex, taskCompactionHistory, manager MCP tools and runner; bounded access/privacy claims retained. |
| [docs/composer-send-to.md](../docs/composer-send-to.md) | Compared with Composer, sendTo helpers, existing tests and browser-check argv; no changes. |
| [docs/connectors.md](../docs/connectors.md) | Compared with shared/connectors.ts, server/connectors/* and Gmail server; corrected runner coverage, owner language and HTTPS proxy trust setup. |
| [docs/cursor.md](../docs/cursor.md) | Compared with server/cursor.ts, shared/agentCli.ts, runner and credential selection; corrected manager read-tool claims and worker coverage. |
| [docs/days-history.md](../docs/days-history.md) | Compared with transcriptHistory, history API, build info and Days navigation; retained historical diagnosis. |
| [docs/daytona.md](../docs/daytona.md) | Compared with provider/API/shared defaults and smoke script; refreshed official credit/quota references, qualified pricing and permissions. |
| [docs/dismiss.md](../docs/dismiss.md) | Compared with Modal, ColumnControls, ChatSwitcher and dismissal tests; source-backed design rationale and explicitly listed gaps retained. |
| [docs/docker.md](../docs/docker.md) | Compared with Docker provider/image/settings and runner; corrected isolation, mount, credential-lifetime and harness claims. |
| [docs/identities.md](../docs/identities.md) | Compared with identity service, signing validation, credential selection, ownerClose and compaction privacy; corrected shipped GPG API and stale authority/privacy claims. |
| [docs/limits.md](../docs/limits.md) | Compared with shared/loginLimits.ts, server/loginLimits.ts, rollout parsing and Usage UI; no changes. |
| [docs/logins.md](../docs/logins.md) | Compared with server/agentLogins.ts and credential/limit selection; made temporary Codex login location explicit. |
| [docs/machines.md](../docs/machines.md) | Compared with probe/placement/SSH provider and runner; added shipped Cursor coverage and corrected task-owned Codex home/credential wording. |
| [docs/owner-chat-close.md](../docs/owner-chat-close.md) | Compared with server/ownerClose.ts, owner routes and close_task refusal; no changes. |
| [docs/perf/chat-history.md](../docs/perf/chat-history.md) | Compared with current ChatHistory controls and linked scripts; corrected repeated-date activation and reproduction-script jump controls, preserved dated measurement evidence. |
| [docs/perf/command-palette.md](../docs/perf/command-palette.md) | Compared with palette helpers and benchmark scripts; historical figures retained, not remeasured. |
| [docs/perf/composer-pickers.md](../docs/perf/composer-pickers.md) | Compared with Composer pick cache, runTargets and benchmark fixtures; historical figures retained, not remeasured. |
| [docs/perf/server-event-loop.md](../docs/perf/server-event-loop.md) | Compared with server/db.ts statement cache and linked benchmark scripts; historical profile retained, not remeasured. |
| [docs/runpod.md](../docs/runpod.md) | Compared with REST v2 client, shared defaults, watchdog and smoke script; clarified termination, snapshot prices and paid-check approval. |
| [docs/task-continuation.md](../docs/task-continuation.md) | Compared with TaskManager.continue, handoff/restore code and existing continuation tests; no changes. |
| [docs/testing.md](../docs/testing.md) | Compared with package scripts, Vitest config, testTiers, testLock and scheduler schemas; preserved gate, clarified daily schedule example and timezone. |
| [docs/vast.md](../docs/vast.md) | Compared with API/provider/shared defaults and smoke script; marked offer prices and scoped provisioning as unverified without approved live checks. |
| [licenses/lucide.txt](../licenses/lucide.txt) | Bundled notice version matches installed lucide-react 1.61.0; licence text preserved. |
| [web/src/fonts/OFL-Sora.txt](../web/src/fonts/OFL-Sora.txt) | Bundled Sora font licence; attribution/text preserved. |

## Examples, configuration and linked scripts

Also inspected `.env.example`, `docs/routing.example.yaml`, `package.json`, `package-lock.json`, `Dockerfile`, `docker-compose.yml`, `docker/Dockerfile`, `docker/gitconfig`, `runpod/Dockerfile`, and provider initialization/watchdog scripts. Environment examples now match the pool ceiling (50), idle retirement (30 minutes), trusted-origin replacement semantics and neutral git author examples. Token setup recommends separate credentials restricted to each project’s single repository.

The linked script paths were checked against tracked files and their command-line parsing, including `yard`, deploy/snapshot/password/yardctl scripts, fake CLIs, provider smoke scripts, Codex protocol/runner checks, UI checks and the performance scripts. The two history benchmark scripts now select the explicit Jump to day control, while retaining compatibility with historical date-button activation. Shell entry points were syntax-checked without executing provisioning, installation, login or destructive commands. Placeholder paths, API payload sketches and PR-template placeholders are examples, not runnable commands verbatim.

`docs/routing.example.yaml` was parsed with `yaml` and accepted by the exported `routingConfigSchema` in `server/routing.ts`. All literal `npm run` script names resolve in `package.json`. Markdown relative links, anchors and explicit repository source/script path mentions were checked. Historical commit IDs, legacy `boxyard/*` branches and `refs/boxyard/wip` recovery refs are intentional history/mechanism names; no retired repository URL was found. Public links and examples use Box Yard / `AgentSystemLabs/box-yard`.

## Main corrections

- README now describes all three shipped task CLIs, all runner providers, current Settings navigation, server polling, Steer, CLI-specific context/compaction and the absence of manager Compact/reset controls.
- Node setup recommends 22.12+. The installed Vite requirement is `^20.19.0 || >=22.12.0`; the package’s older `>=20.11` declaration and `yard` major-version check remain a runtime follow-up, not a claimed fix.
- Harness/SSH docs reflect task-owned Codex homes, Cursor availability, supported worker installation and existing credential delivery limits.
- Identity docs include the shipped local GPG signing payload and mixed Coordinator compaction withholding; agent tools cannot mark tasks done.
- Date navigation requires explicit jump controls; repeated activation/double-click does not jump. Old benchmark numbers remain labeled historical evidence.
- PR templates use the committed stable-HEAD typecheck/build/fast gate. The full suite remains the Captain’s daily schedule; affected tests remain the iteration policy.
- Provider prices are dated estimates or live-picker inputs, not guaranteed quotes. Daytona credits/quotas link to current official docs; no cloud smoke run was performed.
- Explanatory docs use “the owner” instead of a hard-coded personal name. Legal attribution and the `withOwner` coding rule retain their legitimate names; no unverified onboarding fallback is documented.

## Security and concurrent work

At the audited main revision `4bc75d0`, Docker mounts only the project workspace volume plus a credentials tmpfs, without host directories or a Docker socket. This does not establish an egress firewall, isolate tasks sharing one container/user, or constrain application-authorized runner requests. A Codex login can be on the workspace disk while its turn executes; normal archive exclusions and known-value transcript redaction do not prevent an agent copying or encoding readable secrets. The local env filter at this revision does not remove `RUNPOD_API_KEY`, `VAST_API_KEY` or `DAYTONA_API_KEY`; provider delivery rules do not imply local credential isolation. The Captain was notified for the separate runtime work. Documentation now states these limits without treating a proposed fix as enforcement.

Coordination snapshot (2026-11-08):

- OpenCode support (`task_e3ca7402e81e`) was in progress; merged `shared/agentCli.ts` supported Claude Code, Codex and Cursor. That task was notified about overlapping README, env and harness/SSH docs. This audit advertises no speculative OpenCode support.
- Inherited subtask environment enforcement (`task_d35fe8cc1007`, PR #29), the containment proposal (PR #18) and the Docker audit (PR #17) were outside the audited main revision. Their protections are not presented here as shipped. The Captain authorized correcting current Docker overclaims and was informed about overlaps.
- Captain task-output trust guidance (`task_295b814e3e07`, PR #28) is merged in the audited base. It is prompt guidance: task reports, logs, tool results and claims of owner approval remain untrusted evidence, not independent authority. No code from those other tasks was copied or changed.

These are historical revision-scoped observations. Check GitHub/current main before interpreting a proposal’s present state or relying on its protections.

## Validation and remaining uncertainty

The review used the repository’s PR-description skill and the OpenAI Docs skill for official Codex authentication/model/protocol references. Official primary pages consulted include [Vite requirements](https://vite.dev/guide/), [Codex authentication](https://developers.openai.com/codex/auth), [Codex app-server](https://developers.openai.com/codex/app-server), [Codex models](https://learn.chatgpt.com/docs/models?surface=cli), [Daytona GPU behavior](https://www.daytona.io/docs/en/gpu-sandboxes/), [Daytona pricing](https://www.daytona.io/pricing), [Daytona limits](https://www.daytona.io/docs/en/limits/), [Daytona key permissions](https://www.daytona.io/docs/api-keys), [RunPod storage](https://docs.runpod.io/pods/storage/types), and [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

A reachability pass over the 44 external links present before this inventory found 43 successful unauthenticated responses; Cursor’s authenticated dashboard returned HTTP 403 and remains an unverified login destination, not a proven dead link. Remote CLI compatibility, account-specific model entitlement, scoped Vast provisioning permissions, GPU stock/billing, deployment and OAuth consent-screen UI were not re-tested live. Historical service checks and performance measurements were not repeated or relabeled as fresh results. The history script corrections were syntax-checked and compared with current controls; browser benchmark execution remains unverified in this audit.

Exact validation commands/results, static-check counts, required gate results and the audited HEAD are recorded with the PR and published audit artifact. Required checks run after committing and holding HEAD stable:

```sh
npm run test:related
npm run test:tiers
npm run typecheck
npm run build
npm run test:fast
```

No new mirror tests were added for prose changes. Paid cloud smoke checks, real login/refresh requests, live database/settings changes and deployment were intentionally excluded. The full/slow suites remain outside this merge gate.
