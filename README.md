> [!WARNING]
> **Work in progress.** Box Yard is built for one person's workflow — mine — and it changes fast as I iterate on it.
> Expect breaking changes between releases: settings that move, screens that get redrawn, features that come and go
> without notice. If it's close to what you want, fork or clone it and bend it into what you need it to be.

<div align="center">

*"Whatever you do, work heartily, as for the Lord and not for men."* — Colossians 3:23 (ESV)

<img src="web/public/icons/box-yard-icon.svg" alt="Box Yard logo" width="96">

# Box Yard

**One chat that runs a yard of Claude Code agents.**

Each agent works in its own folder on this computer by default — or inside its own
[Upstash Box](https://upstash.com/docs/box), which keeps working when you close your laptop.

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-339933?style=flat-square)](#quick-start)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6?style=flat-square)](https://www.typescriptlang.org)
[![Runs on Upstash Box](https://img.shields.io/badge/runs%20on-Upstash%20Box-00e9a3?style=flat-square)](https://upstash.com/docs/box)

[**Quick start**](#quick-start) · [**Deploy**](#deploy) · [**How it works**](#how-it-works) · [**Development**](#development) · [**License**](#license)

```sh
git clone https://github.com/AgentSystemLabs/box-yard && cd box-yard && ./yard demo
```

</div>

---

You tell the **Coordinator** what you want. It sets up **projects** (with or without a GitHub repo) and routes project work to each project's **Captain**. Captains start and follow up on **tasks**. Each task is a headless Claude Code agent with its own folder, on this computer by default or in a worker box. Agents ask you questions, message each other, open pull requests, share preview URLs and publish files. All of it shows up live in the web app. Box Yard itself can run in a box too, so you can close your laptop and the yard keeps working.

**Spoken replies.** Settings › Voice › Read Captain replies aloud is on by default. A Captain reads a short summary of its final reply when you type or dictate to it in its chat. Coordinator requests and automatic work stay silent at the Captain; the Coordinator reads what it relays. The toggle is saved per browser when you press Save, and follows the same mute, quiet hours and background-only settings as other voice announcements.

```
 ┌──────────── web app (React + TanStack Query, live over SSE) ───────────┐
 │  projects sidebar · task panels · Coordinator and Captain chats        │
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ REST + SSE
 ┌───────────────────────────────▼────────────────────────────────────────┐
 │ Box Yard server (Node + SQLite)                                        │
 │  Coordinator + per-project Captains = `claude -p --resume` + MCP tools │
 │  task manager = box pool, queue, turns, archives, agent messaging      │
 └──────┬──────────────────────────────────────────────▲──────────────────┘
        │ Box API: create box, write files, start turn │ events (Redis stream,
        ▼                                              │  or the box's event log)
 ┌─────────────── worker box (up to BOX_POOL_MAX) ─────┴──────────────────┐
 │ tasks/<id>/work     repo clone or scratch folder                       │
 │ tasks/<id>/claude   that agent's Claude session (moves with the task)  │
 │ box-runner.mjs      runs `claude -p --resume <session>` per message,   │
 │                     plus an MCP server: ask_user, message_agent,       │
 │                     create_pull_request, report_preview, ...           │
 └────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
git clone https://github.com/AgentSystemLabs/box-yard && cd box-yard

./yard demo     # no keys needed: a fake Claude drives everything, agents run in local folders
./yard local    # the real thing on http://localhost:3000 (fill in .env first)
```

`./yard local` creates `.env` from `.env.example` the first time. The keys:

| Variable | What it's for |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code login for the Coordinator, Captains and every agent. Run `claude setup-token` to get one. `ANTHROPIC_API_KEY` works too. Optional while agents run on this computer (the default) and its own `claude` is logged in. Settings › Credentials › More Claude logins adds more subscriptions, taken round robin: see [docs/logins.md](docs/logins.md). |
| `CODEX_AUTH_JSON` / `CODEX_API_KEY` | Optional. A Codex login, for whatever you set to run on Codex instead of Claude Code: your `~/.codex/auth.json` (ChatGPT plan) or an OpenAI API key. Settings › Credentials takes them too. See [docs/codex.md](docs/codex.md). |
| `OPENCODE_AUTH_CONTENT` | Optional. API-only OpenCode provider login JSON for task agents. Settings › Credentials accepts it too; OAuth is not supported. See [docs/opencode.md](docs/opencode.md). |
| `CURSOR_API_KEY` | Optional. A Cursor API key, for task agents set to run on Cursor's CLI. Agents on this computer can use its own `cursor-agent login` instead. Settings › Credentials takes it too. See [docs/cursor.md](docs/cursor.md). |
| `UPSTASH_BOX_API_KEY` | Optional. Upstash worker boxes, for projects set to run on them. Agents run on this computer by default, so a fresh install needs none. |
| `GITHUB_TOKEN` | Clone private repos, push branches, open PRs. A fine-grained token with Contents and Pull requests (read/write) is enough. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Optional. A faster event bus between boxes and Box Yard. |
| `BOXYARD_PASSWORD` | Web UI password. Leave it empty to keep Box Yard on this computer; set it to open it to your phone, LAN or Tailscale (see below). `./yard password` makes a strong one. |

**Who can reach it.** With no `BOXYARD_PASSWORD` there's no login, so Box Yard listens on `127.0.0.1` and only this computer can open it. Set a password and it listens on `0.0.0.0`, and the startup log lists every URL it answers on, LAN and Tailscale (`100.64.0.0/10`) included:

```
  Box Yard is running on:
    Local:      http://localhost:3000
    LAN:        http://192.168.1.20:3000
    Tailscale:  http://100.101.102.103:3000
```

`HOST` picks the address yourself (e.g. `HOST=100.101.102.103` for Tailscale only). A `HOST` other devices can reach with no password refuses to start, unless you set `BOXYARD_ALLOW_OPEN=1` (only behind your own auth, since anyone who reaches it can drive your agents). The dev server (`./yard dev`, port 5173) stays on localhost either way. Changes to these take a restart.

**Browser request trust.** The server checks `Host` before parsing request bodies, including when no password is set. It accepts loopback addresses on its listening port, the configured bind address, and this machine's LAN/Tailscale IPs on an intentional network bind. `BOXYARD_PUBLIC_URL` trusts its exact public origin; the existing Caddy setting `BOXYARD_DOMAIN` trusts `https://<domain>`. Add other DNS names, proxy origins or externally mapped ports to `BOXYARD_TRUSTED_ORIGINS` (comma-separated HTTP(S) origins, e.g. `https://yard.tailnet.example,http://192.168.1.20:8080`). These entries grant browser access to owner APIs, so list only origins you control and trust. Reverse proxies may preserve or rewrite `Host`; spoofed `Forwarded`/`X-Forwarded-*` headers do not grant trust.

Mutations require a matching local origin or an explicitly trusted origin, including its scheme and port. Foreign, opaque (`null`) and same-site different-port origins are refused; `BOXYARD_ALLOW_OPEN=1` keeps these checks. Origin-less scripts and MCP retain their existing authentication, OAuth navigations retain their state checks, and QStash deliveries retain signature verification. `npm run dev` trusts the default local Vite origins on port 5173 only in its API process; if you change Vite's port or set `BOXYARD_TRUSTED_ORIGINS`, include your actual development origin explicitly. HTTPS proxy cookies use the configured HTTPS origin, rather than a client's forwarded protocol header.

**The password rule.** Box Yard won't start with a weak `BOXYARD_PASSWORD`, and the error says which rule it broke. Following NIST SP 800-63B rev 4, a password needs at least 15 characters (counted as Unicode characters), any characters and any length are fine, and there are no "one digit, one symbol" rules. It's refused when it's on the bundled list of common and leaked passwords (also with a few characters added or swapped, like `!!football2024!!`), one character or a short pattern repeated, a simple sequence (`abcdef…`, `987654…`, a keyboard row), or when it contains `password`, `boxyard` or the username Box Yard runs as. There's no override; `BOXYARD_ALLOW_OPEN` is only for running with no password at all.

```bash
./yard password         # write a random 24-character password into .env and print it once (asks before replacing one)
./yard password check   # does the one in .env pass? (never prints it)
```

Or pick a passphrase of four or more random words. Restart Box Yard after changing it; every device logs in again.

**Logging in.** Only wrong passwords count against you. After 3 wrong tries from one device, each next try waits a little longer (1 s, 2 s, 4 s … 30 s), and 10 wrong tries in 15 minutes lock that device out for 15 minutes ("Too many attempts, try again in N minutes"); other devices keep working. Failed logins are logged with their address. A login keeps you signed in for 90 days with a random, httpOnly session cookie (Secure over https).

Requirements are Node 20+ and git. `./yard local` installs the Claude Code CLI if it's missing. If `claude` is missing or signed out anyway, Box Yard still starts: the startup log and the setup card say what to install or run (`claude`, then log in), and tasks on this computer wait for it instead of failing halfway.

**Where agents run.** A fresh install runs agents on this computer: the first-run setup card (and Settings › Credentials) shows **This computer** already picked, so there's no Upstash key to set up. Projects run on the local runner (below), with this computer's own `claude` login (or a token) and its `gh auth` login standing in for `GITHUB_TOKEN` (a token saved or in the env wins). The card lists what local agents use and whether it's there: Node, `claude` and its login, `gh` and its login, and Chrome (optional, for browser checks). New projects follow the choice. Pick **Upstash boxes** or **Docker containers** there instead any time (projects that exist stay where they run), add an Upstash key in Settings › Credentials to make **Upstash box** available per project, and a project's own Settings › Runs on picks boxes, Docker, a GPU pod or SSH machines for it alone. `BOXYARD_DEFAULT_RUNNER` (`local`, `box` or `docker`) changes what a fresh install starts with; the Docker image (`deploy-vps`) and `deploy-box` set `box`, since "this computer" is the server there. Installs from before this default keep what they had: with an Upstash key, boxes; without one, the setup card asks.

## Deploy

```bash
./yard deploy-box              # run Box Yard inside its own Upstash Box (keep-alive)
./yard deploy-vps root@1.2.3.4 # run it on your server with Docker (HTTPS if BOXYARD_DOMAIN is set)
```

**`deploy-box`** creates or updates a box named `box-yard-orchestrator`, uploads the app, installs Claude Code, builds, and prints a public URL and password. Run it again to ship changes. Your data and password are kept. `npm run deploy:box -- --logs` tails the server log, and `-- --restart` restarts the server without redeploying.

- On a paid Upstash plan the box is keep-alive. On the free plan keep-alive isn't allowed, so it falls back to a normal box: while agents are running or queued, the server holds its own box awake, and when the yard is idle it lets go. Opening the URL wakes a paused box, and the init command restarts the server, which picks running agents back up.
- Talk to a deployed yard from the terminal with `YARD_URL=<url> YARD_PASSWORD=<password> npx tsx scripts/yardctl.ts say "..."` (also `status`, `wait`, `task <id>`, `chat`).

**`deploy-vps`** copies the app and `.env` over SSH, installs Docker if needed, and runs `docker compose up -d --build`. Data lives in the `box-yard-data` volume. It needs a `BOXYARD_PASSWORD` in `.env` that passes the rule (it runs `./yard password check` first): the container listens on `0.0.0.0` (the image sets `HOST=0.0.0.0`), so without a password it won't start (or set `BOXYARD_ALLOW_OPEN=1`). `deploy-box` always sets a password that passes: yours from `.env` (it stops if that one is too weak), the last deploy's, or a generated 24-character one. A box from an older deploy whose 12-character password no longer passes gets a new one, printed at the end.

## How it works

**Coordinator.** Each top-level chat message runs `claude -p` with `--resume <session>`, so the conversation keeps its context across messages and restarts. The Coordinator gets Box Yard's MCP tools at `/mcp`. It handles cross-project requests and routes project-scoped work to Captains with `send_to_captain`, `ask_captain` and `wait_for_captain`.

**Captains.** Each project has one Captain: its own persistent Claude session, project notes, task history and compaction history. Captains are created lazily on first use and have no running process while idle. A Captain owns `create_task`, `send_to_task`, `wait_for_tasks`, model/effort routing and project-local follow-up for its project. Task events wake that project's Captain first; the Captain decides whether to report a concise update back to the Coordinator.

**A Captain reads its project's code itself.** For a code question it calls `repo_clone`, then answers with Read, Grep and Glob from its read-only clone of the repo in `<data-dir>/captains/<project>/repo`, with no task to wait for a slot. The clone is made on first use, as a partial clone (`--filter=blob:none`) of the base branch alone, with the project's GitHub token through Box Yard's credential helper (never in the URL). Each later use fetches and resets it to `origin/<base>` at most once a minute; when a fetch fails, the Captain answers from the last copy and says how old it is. A Captain has no tool that edits, writes or runs anything (`--tools`), and deny rules refuse edits in the clone, so work that needs a build, running code or a change is still a task. Disk cleanup removes a clone unused for 14 days (an hour when this computer is low on disk), and deleting the project removes it. Codex Captains have no file tools, so they don't get one.

**Routing.** For each request the Coordinator and Captains decide where the work goes:

| Request | What happens |
| --- | --- |
| Follow-up on work an agent did ("close those issues", "fix that PR") | The Coordinator routes to the project's Captain, which uses `send_to_task` on that agent. Its Claude session resumes with full context, restored from the archive if it was parked. |
| Follow-up while that agent is mid-turn | Same call. The message is queued and goes out as soon as the turn ends, in the same session. |
| New, independent work in a known project | The Captain uses `create_task`: a fresh session on the project's box. `related_tasks` passes along earlier outcomes. |
| Many independent pieces at once (a plan, one task per page or issue) | The Captain uses `create_tasks`: up to 100 tasks in one call, with the brief they share written once in `common_prompt`. Every item is checked first; if any is bad, none is created and the error lists each problem by item number. |
| A repo with no project yet | The Coordinator uses `create_project`, then routes the work to the new Captain. One project per repo. |
| Several repos or independent pieces | The Coordinator fans out to multiple Captains; each Captain starts one or more tasks in its project. |

`list_tasks` takes a `query`, so even a fresh Captain session finds the agent that did related work. For quick work the Captain calls `wait_for_tasks` and answers in the same reply. For long work it ends its turn. When an agent finishes, fails, asks something or opens a PR, the project's Captain wakes up, checks whether a project-local next step is needed, and reports a concise result upward when Cody or the Coordinator should hear it.

A Captain's reply shows on the Coordinator chat as soon as its turn's result is in. It wakes the Coordinator for a turn of its own only when there's something to act on. A reply the Captain marks FYI (a hidden `<!-- boxyard-coordinator: fyi -->` line: a status or an answer for Cody) doesn't wake it, and goes to the Coordinator with its next turn's updates instead. These replies always wake it:

- a question, a decision for Cody or a failure in the text, even when marked FYI;
- a failed Captain turn;
- one reply in a fan-out (the Coordinator asked several Captains in one turn);
- a reply to `send_to_captain` with `act_on_reply: true`, or to an `ask_captain` that ran out of time.

When unsure, it wakes (`server/captainWake.ts`).

**Model/effort routing.** Box agent model and effort can be routed per task without adding UI controls. Put YAML in `<data-dir>/routing.yaml` (or `routing.yml`), or paste the same YAML into Settings → Box agents → Routing YAML. See [`docs/routing.example.yaml`](docs/routing.example.yaml) for a starter config with `fallback`, optional `defaults`, per-project defaults and semantic rules. The Coordinator and Captains read the merged rules in their system prompt and pass `model`, `effort`, `routing_rule` and `routing_reason` to `create_task` or `send_to_task` only when a `rules` entry matches or you ask for a specific model. A task shows its own route as a small read-only label, and Box Yard records the model/effort/rule of every turn in `task_turns` so cost tracking can attribute usage later.

Box Yard resolves each turn's model and effort when the turn starts (model and effort separately, first match wins), so a change to Settings or the YAML reaches existing tasks from their next turn:

1. The task's own choice: `model`/`effort` passed to `create_task`, `send_to_task` or `set_task_model`. Only these are stored on the task.
2. The routing YAML's `projects` entry for the task's project (by id, name or repo).
3. Settings → Box agents → Model and Effort, when saved there or set by `WORKER_MODEL`. Effort "Let the Coordinator decide" sets none.
4. The routing YAML's `defaults`, then its `fallback`.
5. The built-in default: `claude-opus-5-5` at `high`.

A task is not stuck on its first route. `send_to_task` accepts a new model and effort for the next turn, so a Haiku/low task can resume the same Claude session with Sonnet or Opus. `set_task_model` changes the next-turn route without sending a message. `create_task`, `create_tasks` and `send_to_task` also take `priority` (`"high"` or `"normal"`, the default), and `set_task_priority` changes it on an existing task: whenever a slot frees up (Tasks running at once on this computer, a box, a GPU pod or a Docker container), queued high-priority tasks go before normal ones, first in, first out within each. It never stops a running agent, and a high task its own project's limits hold back doesn't block the tasks behind it. The orchestrator prompt tells it to escalate failed or looping tasks when the routing rules call for it.

**Tasks and turns.** A task's agent runs one headless turn per incoming message (`claude -p --session-id` the first time, then `--resume`). Messages that arrive while it's busy wait in a queue and go out together in the next turn. The same goes for the Coordinator and the Captains. In every chat, a message sent mid-turn shows at once at the bottom, under the live turn, labelled "Queued". When the turn that reads it starts, it moves to that point, so it sits right after the reply it was typed over and right before the reply that answers it. It stays there after a reload (`meta.queuedAt` keeps when it was sent). Until a turn takes it, its Cancel takes it back: the text and files go back in the message box to fix and send again, and Undo queues it again. While a turn runs, Stop in the message box (before Send) ends it, in a task's chat, the Coordinator's and a Captain's. The session is kept, the chat shows a quiet "Stopped by …" line rather than an error, the next turn is told it was stopped, and messages queued meanwhile still go out. Each task's Claude config lives in its own folder (`CLAUDE_CONFIG_DIR`), so the session moves with the task.

**Statuses.** A task is in one of these states:

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for a box slot. |
| `starting` | Its box is being prepared. |
| `working` | A turn is running. |
| `needs_input` | The agent asked you something. It shows in the sidebar's Waiting on you. |
| `waiting` | The agent is waiting on a reply from another agent. |
| `idle` | The last turn ended and nothing is pending: the agent's work rests here, ready for your review. |
| `pr_ready` | The agent opened a pull request. |
| `done` | You marked it done (Mark done in the task's header, the ✓ on its sidebar row, or an [explicit owner chat request](docs/owner-chat-close.md)), or its PR merged with Done when its PR merges on. Agents never mark a task done autonomously. |
| `failed` | Something broke. Retry with a click. |

**Box pool.** Box Yard runs a pool of worker boxes. `WORKER_SIZE` chooses the Upstash size for newly created boxes (`small`, `medium`, or `large`). `BOX_POOL_MAX` (default 5) caps how many boxes exist, and `BOX_SLOTS` sets how many tasks run at once in one box (Settings › Tasks running at once per box; each task runs its own Claude Code agent). When you have not overridden it, slots default by size: small 1, medium 2, large 4 (and task folders kept per box: small 3, medium 8, large 18). **Upgrading:** before size-based defaults every box ran 2 tasks at once and kept 12 folders, so an install on the default `small` size now has less per-box capacity. Settings › Box providers › Upstash boxes shows the effective values per size; set `BOX_SLOTS`/`BOX_MAX_RESIDENT` or pick a larger size to restore the old capacity. `BOX_MAX_AGENTS` (Settings › Max tasks running at once) optionally caps tasks running at once across all boxes. When many tasks wait for a box, Box Yard creates the boxes they need in parallel, up to `BOX_CREATE_CONCURRENCY` at once (default 10), and never more than the queue needs. A failed create backs off for a couple of seconds, doubling with each failure in a row, and a rate limit also lowers how many run at once until boxes come up again. These are defaults: edit them live in Settings. Lowering a limit never stops running work; it just holds back new work until usage drops. Placement keeps a project together:

1. A task goes to a box that already hosts its project (each box keeps a bare mirror of the project's repo, so later clones come from local disk).
2. Otherwise an empty box.
3. Otherwise, while the pool has room, a new box is made for that project and reserved for it.
4. Once the pool is full, projects share boxes, picking the least loaded one.

A project whose box has all its slots busy gets a second box while there's room. Tasks stay on the box they started on. If that box is busy and the task's archive is current, the task can move to a free box.

**Local runner.** Projects run their agents on the computer running Box Yard by default (project Settings › Runs on › This computer, following Settings › Credentials › Where agents run). It suits work a box can't do, such as a real GPU, a local browser, or long benchmarks; pick Upstash box, Docker container, GPU or SSH machine per project for isolation or for work that should outlive a closed laptop.
- **No sandbox.** Tasks on this computer run unsandboxed, as the user running Box Yard, with that user's files, network, logged-in `claude` and `gh`, and keychain. The setting and every local task's details (ⓘ) say so.
- **Where they run.** Each task works in `~/boxyard-workspaces/<task_id>` (`BOXYARD_LOCAL_DIR` moves it; a leading `~` is the home folder). Keep it out of Box Yard's checkout and any other folder with a `CLAUDE.md`: Claude Code reads every `CLAUDE.md` above the folder it runs in, so Box Yard's own agent rules would reach every local agent. A turn is Box Yard's runner in a process group of its own, detached from the server, so it keeps running through a server restart or upgrade (see below).
- **Limits.** `BOXYARD_LOCAL_AGENTS` (Settings › Boxes & limits › Tasks running at once on this computer, default 2) caps how many tasks run at once here. They have their own queue and never take a box slot or count toward `BOX_MAX_AGENTS`.
- **Previews.** Previews are on `http://localhost:<port>`.
- **Sleep.** While a turn runs, `caffeinate` keeps a Mac out of idle sleep (and out of system sleep on AC power), but a closed lid still sleeps. A turn that sleep cut off carries on once the Mac wakes instead of failing.
- **Archives and folders.** Local tasks keep no archives: the push at turn end covers them. Their folders stay on this computer, cleaned by Settings › Boxes & limits › This computer and SSH machines (the box settings don't apply here):
  - *Free a finished task's build output* (`BOXYARD_LOCAL_BUILD_CLEANUP`, default on): once a task is done and everything in its folder is pushed, its git-ignored dependency and build output (`node_modules`, `dist`, `build`, `.next`, caches) goes within a couple of minutes. A task that isn't done keeps it (only low-disk cleanup frees it). Scratch and captures (`tmp`, `shots`, `perf`, reports) stay.
  - *Task folders kept* (`BOXYARD_LOCAL_FOLDERS_KEPT`, default 10, 0 = no limit): past it, the oldest done tasks' folders are archived and removed; they come back on their next message. A task that isn't done keeps its folder.
  - *Low-disk cleanup* (`BOXYARD_LOCAL_DISK_MIN_FREE_GB`, default 30, 0 = off): below that much free disk, build output (an idle task's too) and then the oldest done tasks' folders go until there's room again.
  - None of them touches a running, queued or starting task, one waiting for an answer, a folder a process still uses (its cwd, an open file or an argument is inside it: a dev server left up after the turn, an editor, a shell; read from `/proc` on Linux, `lsof` on macOS), or a folder with anything uncommitted, stashed or unpushed. Whatever goes is written to the task's own log. The same settings apply to each SSH machine.
- **Switching back.** Switching a project between boxes and this computer moves each task at its next turn, but only when its work is safe (pushed and archived first). Otherwise the task stays where it is and its log says why.
- **Claude login.** Without a token in Settings › Credentials, local agents use the computer's own `claude` login. `CLAUDE_BIN` picks the binary. When setup chose This computer, that login also counts as the Claude sign-in setup asks for, and `gh auth token` stands in for a missing GitHub token (read on the server, never sent to the browser).

**SSH machines.** Old laptops, a GPU tower or a Mac mini of yours can run agents too: Box Yard SSHes in and runs a task there the way it does on a box (clone with the project's token, Claude Code headless with the same MCP bridge, archive, push, PR). Add them in Settings › Machines (or ask the Coordinator: `add_machine`), with free-form labels such as `laptops` or `gpu`. A project on Runs on › SSH machine, or a task with `runs_on: "label:gpu"`, gets a free machine with that label; tasks wait while they're all busy. "Run it locally" stays this computer unless you point it at a label (Settings › Machines › When you say "locally"). Keys are named, never copied (`file:~/.ssh/<key>` or the SSH agent), and each turn's GitHub token and Claude key go over SSH's stdin and are removed when the turn ends. Agents there aren't sandboxed. See [docs/machines.md](docs/machines.md) for the old-laptop setup guide.

**Branch names.** New task branches follow each repository's documented and observed naming convention, including type prefixes, ticket numbers, separators and casing. With no clear pattern they use a descriptive slug, adding a short suffix only for collisions. Existing branches and recovery refs keep their names. See [docs/branch-names.md](docs/branch-names.md).

**Nothing gets lost.**
- Every transcript line, question, PR, preview, note and artifact is stored in SQLite.
- After every turn of a repo project, Box Yard pushes the task's branch (fast-forward only, never forced) and its uncommitted work, untracked files that aren't ignored included, to a hidden ref on origin, `refs/boxyard/wip/<task>`. It never commits in the task's repo or touches its index or HEAD. The archive then holds only what git can't carry: the Claude session, the event log, runner state and git-ignored files, so a box can be deleted at any time without losing code. Restore clones the branch, then puts the uncommitted work back, staged and unstaged as they were. The hidden ref is deleted once nothing is uncommitted, when the task closes and when it's deleted. `BOXYARD_GIT_PUSH_AT_TURN_END` (default on; also in Settings › Boxes & limits, and per project) turns it off. Without write access to the repo, the push is skipped quietly and the task's details say why.
- Without that push (it's off or failed, or the project has no repo), the whole task folder (repo, Claude session, event log) is archived to the server's disk. The archive streams off the box over the exec connection (tar → base64 → the server), so it needs no free space on the box: a box whose work disk is full can still be archived, resized, cleared or deleted. A folder over `BOXYARD_ARCHIVE_MAX_MB` (default 60, compressed) keeps only the Claude session, the event log and git history, with uncommitted work saved as a commit on `refs/boxyard/wip`. That snapshot is built in `/tmp` or on the work disk (separate disks on Upstash), whichever has more room, and never written into the repo. If even that is over the cap (a heavy history, e.g. a clone from before tasks shared the box mirror), the archive leaves out the history GitHub already has: it keeps HEAD, the branches, a `git bundle` of only the commits not on GitHub (per the box mirror's and the clone's remote-tracking refs), the uncommitted work (staged and unstaged) and the Claude session. Restore clones from the box mirror or GitHub and puts the rest back; if a commit can't be found, the restore fails with a message instead of losing it. Resize, Delete box and Clear box don't archive a done task whose PR is merged and that holds nothing unpushed: GitHub has it, so it resumes from a recap.
- Archives leave regenerable output out by name (`node_modules`, `dist`, `build`, `.cache`, `.next`, test reports like `playwright-report` and `test-results`, tool caches); tracked files in those folders are checked out again on restore. A git-first archive also leaves out the ignored scratch folders `tmp`, `.tmp`, `shots`, `perf` and `traces` (perf and test captures).
- Restores never send one file over the box's upload limit (Upstash Box: 100 MB per file): a bigger archive or attachment goes up in parts of at most 90 MB and is joined on the box, so `BOXYARD_ARCHIVE_MAX_MB` can be raised past it. A restore that fails is tried once more (not when the box refused the upload for its size). After that the task restarts from a recap on a fresh checkout of its branch, with the uncommitted work its last turn pushed put back, instead of failing every start. The archive that didn't restore is kept on the server as `archives/<task>.unrestored.tgz` (pruned like an orphan after `BOXYARD_ARCHIVE_RETENTION_DAYS`), and the Captain gets a notice.
- Once a done task has rested for `BOXYARD_BUILD_CLEANUP_IDLE_MINUTES` (default 15, 0 = off; also in Settings › Boxes & limits), Box Yard removes its git-ignored build output: `node_modules`, `.next`, `dist`, `.cache`, `tmp`, perf and test captures. Only folders git ignores and doesn't track go, so uncommitted work is never touched. A task that isn't done keeps its build output until the box runs low on disk. No cleanup touches a folder a process still uses (a dev server left up after the turn, a shell). What it frees shows up in the box's cleanup report and in the task's log, and the task's next prompt says what went, so the agent reinstalls before it runs anything. After `BOXYARD_WORKSPACE_RETENTION_DAYS` idle days (default 7), the whole task folder is parked off the box and restored from the archive on the next message.
- **Dependency cache** (Settings › Boxes & limits, off by default; a project can override it): each box keeps installed `node_modules` per `package-lock.json` (plus Node ABI, platform and libc) in `/workspace/home/.boxyard/deps/`, beside the task folders. A task with that lockfile and no `node_modules` gets it hard-linked in before its turn (under a second instead of an `npm ci`), and a tree that matches its lockfile is saved after the turn. Shared files are read-only, so writing into one fails instead of changing every task's copy. Hard links only: /tmp is another filesystem on Upstash boxes, and reflinks count fully against the disk quota. The cache stays under its size (least recently used lockfiles no task links go first), and low-disk cleanup removes entries no task links. Trees with nested `node_modules` (npm workspaces with conflicts) or native addons built for another Node aren't cached.
- `BOX_MAX_RESIDENT` (Settings › Task folders kept per box) limits how many task folders one box keeps before parking old archived ones. When you have not overridden it, the default follows the worker size: small 3, medium 8, large 18.
- `BOXYARD_ARCHIVE_RETENTION_DAYS` (default 7) prunes orphan archives and archives for long-done tasks. It never prunes the archive of a task with an open or unmerged PR, or of a task touched in the last `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS` (default 30). A done task whose archive was pruned can still take a follow-up: it starts a new Claude session from a recap (summary, branch, PR, recent messages) on a fresh checkout of its branch, or the base branch if the branch is gone. `BOX_IDLE_DELETE_MINUTES` can retire idle boxes once every resident workspace has a fresh archive.
- Each box keeps one bare mirror per repo under `.boxyard/repos`. Task checkouts borrow its git objects (`git clone --reference`, no `--dissociate`), so a task folder holds its working tree, its index and only the objects it made or fetched itself. Each task still has its own branch, config and GitHub remote. By default mirrors are partial clones (`--filter=blob:none`): old versions of files are fetched from GitHub when `git log -p`, blame or a checkout needs them. Turn that off in Settings (`BOXYARD_GIT_PARTIAL_CLONE=0`) or per project for repos whose agents dig through history a lot.
  - A mirror never prunes objects while a task folder borrows from it, and it's never removed while one does. Routine upkeep gives mirrors a light `git gc --auto` every few hours.
  - Archives stay restorable anywhere: they carry the task's own objects plus a small pack of borrowed objects GitHub no longer reaches (after a force-push or a deleted branch). A restore re-creates the box's mirror and points the clone at it.
  - Mirrors with no resident task, no project owner and no task folder borrowing from them are pruned during maintenance.
- Before a new workspace lands on a box, Box Yard checks its free disk with `df`. It needs the larger of `BOXYARD_DISK_MIN_FREE_MB` (default 1024) and `BOXYARD_DISK_CLONE_FACTOR` (default 2) × the repo's last clone size. A box short on room is skipped: the task goes to another box with room, or to a new box if the pool allows. Meanwhile the low box is cleaned up in the background. A task waits only when nothing else can take it, and then it shows "Waiting for disk cleanup on <box>" instead of failing. Cleanup first removes stale temp folders: Box Yard's archive stages and test leftovers that nothing touched in 30 minutes, in `/tmp` and `.boxyard/tmp`. Then it runs in safe steps and stops once there is room: partial clones and failed setups, npm/pip/tmp caches, git-ignored `node_modules`/build output of resting tasks, `git gc` of shared mirrors, then parking archived done workspaces. When the work disk is nearly full (under 100 MB free), two steps go first: Claude's session temp files (shell snapshots, debug logs, file-history; never transcripts) and leftover restore files, then done workspaces whose PR is merged and that hold nothing unpushed (clean `git status`, no stash, no commit missing from a remote). Those go without an archive because GitHub has everything; each removal is logged and the task resumes from a recap. Cleanup never touches uncommitted work. If a setup still runs out of space (ENOSPC, "No space left on device", git's "Out of diskspace" or "write error"), Box Yard cleans that box up and retries once, on another box if one has room. Only then does the task fail, with a message saying so. A toast says what each cleanup freed. Ask the Coordinator for free/total disk per box (`pool_status`) or to clean one up now (`clean_up_box`). When the root disk (`/tmp` and home) is a separate one, it's watched too; while it's low (under 512 MB or a tenth free), stale temp folders and caches are swept from it every 10 minutes.
- If a resize fails, the box it made for the move is deleted (and the resize report says so). If the provider won't delete it yet, it stays as "Deleting" and Box Yard retries. Boxes at the provider that Box Yard has no record of are swept every hour.
- **Auto-sizing** (Settings › Size and resize boxes automatically, on by default): on Upstash boxes the box probe measures each turn's memory in use (without page cache), CPU cores and work disk while only its project's turns run there, and keeps 14 days of it. From 3 measured runs, a project's new boxes (and the smallest box its tasks run on) are the smallest size with RAM for 1.25 × the peak, bigger when its work disk wouldn't fit or when its runs' median minute kept 90% of their cores busy (bigger boxes cost more per core-hour, so a busy minute alone doesn't count), held to Settings › Max size it may choose. Until then Settings › Worker size applies, and a project's own Box size overrides it. A turn that fails while its box's cgroup kills a process for memory (or whose agent dies by SIGKILL, exit 137) carries on once on a box one size up, and the Captain gets a notice; a second one fails as usual. Project › Settings › Boxes says what it picked ("Auto: medium (peak 5.1 GB over 12 runs)").
- If a box disappears, its tasks are restored from their archives onto another box. A turn that dies mid-run is retried with a "you were interrupted, check where things stand" message, up to two times.
- If a Claude session can't be found, the agent starts a fresh one with a recap of the conversation.
- **Restarts and upgrades.** Stopping or upgrading Box Yard (Ctrl-C, `./yard local` again) doesn't stop task turns: each one runs detached from the server, in its box or on this computer, and writes its events to `events.jsonl` in the task folder. Its `run.json` names its process by pid, the machine's boot and the process's start time, so a pid another process took later (after a reboot) is never mistaken for it or stopped. On startup Box Yard checks every running turn:
  - Still running: picked back up where it left off ("Box Yard restarted and picked this turn back up"). Stop, Steer and queued messages work as before.
  - Finished while the server was down: what it wrote is read and the turn ends as usual.
  - Gone (it died, or this computer or its box restarted): its last output is read, and it's retried in the same Claude session with a "you were interrupted" message.
  - Coordinator and Captain turns are the exception: they run inside the server, so one in progress during a restart is lost. Their sessions carry on with the next message.
- **One server per data folder.** `<BOXYARD_DATA_DIR>/server.lock` keeps a second Box Yard off the same database: it waits 10 s for the first one to stop (a restart), then refuses to start and says which one has it. A lock left by a server that's gone is taken over.

**Agents talk to each other.** Agents can call `list_agents` and `message_agent` (optionally waiting for a reply), `suggest_note` and `read_notes` for project notes, and `ask_user` to ask you. Mid-turn, `message_captain` sends their project's Captain a scope question, a conflict or an out-of-brief bug without ending the turn, optionally waiting up to 60 s for the answer; the Captain replies with `reply_to_agent` or `send_to_task`. Both tools accept `fyi: true` for informational notes: these stay visible in the recipient's log or Captain view without queuing or starting a turn. Requests for a reply override FYI. Your own messages and messages from the Coordinator or a Captain always follow their usual delivery path. Messages go through Box Yard, because boxes can't reach each other directly. Agent-to-agent and agent-to-Captain messages are rate limited to stop loops.
- **Quiet agent wakes.** A turn that only other agents' messages started (no message from you, a Captain, the Coordinator, a hook or a schedule in it) is an agent wake. If it ends resting with no real change (no new or pushed PR, no merge, no failure, no question), its "done" / "finished its turn" update goes to the project's Captain (without waking it) and the task's transcript, not to the Coordinator chat or a toast, and `task.finished` hooks skip it unless they include agent wakes. A turn with mixed messages counts as its highest sender's (you > Coordinator > Captain > hook > schedule > Box Yard > agent), so an agent's message plus yours is your turn and notifies as usual. Each turn's trigger is recorded on `task_turns.trigger`.
- **Live PR state on resume.** When a task with a PR resumes for any reason, the turn's prompt ends with a "Pull request status" line: open, draft, merged (when and by whom) or closed, plus the head commit. Box Yard asks GitHub as the turn starts (a state checked in the last 30 s, or a merged one, is used as is), waits at most 4 s, and otherwise says it's the last known state and asks the agent to check `gh pr view`. Agents are told never to claim a PR's status without it, and to base new work on the base branch once their PR is merged.

**Project notes.** Each project keeps a small, curated set of lasting rules that every agent starts with: box gotchas, your decisions and preferences, and facts that aren't in the code. Agents can't write notes. They suggest one with `suggest_note` and say why. When a task's PR merges, or its agent finishes without an open one, the project's Captain gets a notes retro with the task's suggestions and resolves every one itself: it accepts a suggestion, merges it into a note, or rejects it, with a one-line reason. Nothing waits for you. Ask the Captain or the Coordinator to show the notes and recent suggestions, or to add, edit or delete a note by hand (`list_notes`, `list_note_suggestions`, `add_note`, `update_note`, `delete_note`). Prompts include notes up to a budget: Settings › Coordinator › Max notes (default 25 notes, about 4k tokens), which a project can override in its Project settings › Notes. Over budget, agents get the newest notes that fit and the Captain is asked to prune. Settings › Coordinator › Notes retro turns the retro off.

**Previews and artifacts.** An agent starts a dev server on its own port range (`$PORT` to `$PORT+9`) and calls `report_preview`. Box Yard then asks the box for a public URL (`getPublicURL`). For files, `publish_artifact` copies the file to the server, and Box Yard hosts it at `/artifacts/...`. The agent gets the final URL back right away, so it can pass the link on.

**Pull requests.** When a turn ends on a task with a PR, Box Yard asks GitHub for its state. A merged PR marks the task done (Settings › Done when its PR merges, or the project's own). A closed one means there's nothing left to review.

**Schedules.** A schedule is a cron job inside a project or in the Coordinator chat: a name, a 5-field cron expression (or `@hourly`, `@daily`, `@weekly`, `@monthly`), a time zone and a prompt. Project schedules start an ordinary task in that project, so you watch the run live like any other task. Coordinator schedules inject a prompt into the top-level chat for cross-project digests and reminders (internally they still use target `"orchestrator"` for compatibility). Create, pause, run now and delete schedules from the Schedules panel (⏰ at the foot of the sidebar) or the Coordinator chat (`create_schedule`, `list_schedules`, `update_schedule`, `run_schedule_now`, `delete_schedule`).

- The server's own timer checks for due schedules every 15 seconds (`BOXYARD_SCHEDULER_TICK_MS`).
- If the server was down when runs were due, it starts one catch-up run when it comes back, and tells the agent how many runs it missed. Set a schedule's missed-runs option to "skip" to drop them instead.
- A new run is skipped while the previous run is still going, unless the schedule allows overlap. The reason shows on the schedule card.
- Optional: with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` (and `QSTASH_NEXT_SIGNING_KEY`) plus `BOXYARD_PUBLIC_URL`, each schedule is also created in Upstash QStash, which POSTs to `/qstash/schedules/<id>`. That request wakes a paused Box Yard box, so runs happen on time. Box Yard checks the QStash signature, and the local timer and QStash can't both start the same run.
- New schedules use `BOXYARD_TIMEZONE`, or the server's time zone if that isn't set.

**Hooks.** A hook is an automation on task events, so routine follow-ups happen without anyone watching. It runs on `task.finished`, `task.pr_ready` (a PR was opened or pushed and the turn ended), `task.failed`, `task.needs_input`, `pr.merged` or `schedule.run_finished`. It then sends a prompt template to the same task, to the project's Captain or to the Coordinator, or starts a new task. `{task_id}`, `{task_title}`, `{project}`, `{pr_number}`, `{pr_url}`, `{branch}`, `{head_sha}`, `{status}` and `{summary}` are filled in when it fires. Filters narrow it by project, title or prompt regex, who started the task, and PR labels (with an exclude list such as `no-automerge`). Draft PRs, quiet no-op runs and quiet agent wakes (a `task.finished` turn only another agent's message started, see above) are skipped unless a hook includes them (`include_drafts`, `include_quiet`, `include_agent_wakes`). Global hooks belong to the Coordinator (Settings › Hooks), and project hooks belong to the project's Captain (the project's Hooks tab). Both can be managed from chat with `create_hook`, `list_hooks`, `update_hook`, `delete_hook` and `list_hook_runs`, and a Captain's tools only reach its own project's hooks.
- The built-in **On PR ready → merge** template sends the Merge PR button's standard merge message once per head commit. It goes through the button's path, so it never runs while another merge of that PR is pending. New hooks start off.
- A hook fires once per event: per head commit for `task.pr_ready`, per PR for `pr.merged`, and per turn otherwise. It never fires on a turn its own prompt started, or on a task it created, unless it allows that. Each hook fires at most N times per task (3 by default), all hooks together at most 10 times per task a day, and at most 30 times across the yard every 10 minutes.
- Every fire goes through the normal queue, so box slots and limits apply. It shows on the task's transcript as "Hook: <name>", reaches both the Captain and the Coordinator as a 🪝 update, and is logged with its rendered prompt under Recent runs (`GET /api/hooks/runs`).

**Codex.** The Coordinator, the Captains and each project's agents can run on OpenAI's Codex instead of Claude Code (Settings › Coordinator, Settings › Box agents, a project's Agent setting, or `agent: "codex"` on one task); Claude Code stays the default. Box Yard hands Codex your ChatGPT login or an API key per turn and keeps the copy Codex refreshes, so one `codex login` serves every box. See [docs/codex.md](docs/codex.md).

**Cursor.** A project's task agents can run on Cursor's CLI (`cursor-agent`): Project › Settings › Agent, Settings › Box agents, `!cursor` in the composer, or `agent: "cursor"` on one task. Settings lists the models your Cursor account has, read live from `cursor-agent models`. Boxes sign in with a Cursor API key; this computer can use its own login. See [docs/cursor.md](docs/cursor.md).

**OpenCode.** Task agents can use OpenCode 1.19.5 from Settings, a project, a new task, `!opencode`, or same-task continuation. It has an independent provider/model default and API logins; manager chats and OAuth are unsupported. See [docs/opencode.md](docs/opencode.md).

**Subscription limits.** Settings › Usage shows each Claude subscription's and Codex plan's 5-hour and weekly windows, per login: how much is used and when each resets, from what the CLIs report on every run (Claude Code's `rate_limit_event`, Codex's rollout file). Settings › Credentials and Identities show their own login's in a line. See [docs/limits.md](docs/limits.md).

**Identities.** One Box Yard can work for several GitHub accounts: each project has an identity (an account's tokens, the git author its commits carry, an SSH signing key, a Claude login, the runners it may use), and every project starts on Default, which is Settings › Credentials. The Coordinator sets them up from this computer: `detect_identities` reads `gh`'s accounts, git's global and `includeIf` authors and the signing keys here, asks GitHub which account can push to each repo, and proposes a setup; `import_detected_identity` makes it once Cody agrees. Tokens and keys go by reference (`gh:<login>`, `file:~/.ssh/<key>`), so no value passes through the model. Or do it in Settings › Identities (Import from this computer, Add, Test) and pick each project's identity in its settings. See [docs/identities.md](docs/identities.md).

**Connectors.** External MCP servers (Gmail, Notion, Linear, or any URL or command) that Box Yard passes into the sessions Cody picks: the Coordinator, Captains and/or agents, of all or chosen projects, on chosen runners. They sign in with the MCP OAuth flow (or Cody's own OAuth client, or a token), and their secrets are kept encrypted and go into Settings only: no model sees or changes one, and `list_connectors` shows their status. See [docs/connectors.md](docs/connectors.md).

**Context usage, compaction and settings.**
- Every task's header and the Coordinator/Captain panels show how full the Claude context window is (`84k / 1m · 8%`), updated after each model call. The number is the last call's input + cache + output tokens; the window comes from the CLI.
- **Compact** summarises a session in place. For a task it runs `/compact` as its own turn on the resumed session (right after the current turn if one is running, and before any queued messages). For the Coordinator and Captains, Box Yard first asks the session to write a durable summary, saves that, then runs `/compact`.
- **Coordinator compaction history.** Each Coordinator compaction (button or auto) writes `<data>/orchestrator/compactions/<UTC time>.md` (for example `2026-10-22T03-40-05Z.md`): frontmatter (timestamp, session id, model, trigger, tokens before and after, linked task ids) and four sections (decisions and preferences, projects and repos, ongoing work, open threads). Next to it, Box Yard writes a `.json` sidecar and a SQLite record with structured metadata for tasks active or referenced since the previous compaction: title, status, project, branch, PR URL, session id and a short "what happened" summary. The `/compactions` page browses these records, and the Coordinator can call `list_compactions`, `read_compaction` and `find_compactions_by_task` through MCP when it needs history it no longer has. If the summary can't be written, nothing is compacted and the chat shows why.
- **Captain compaction logs.** Captain compactions write `<data>/captains/<project id>/compactions/<UTC time>.md`, so each project's history is tracked independently and keyed by its task ids in the summary. The Captain's system prompt gives it the folder path and tells it to read the newest files when it needs history it no longer has. The Captain's ⋯ menu › Compaction history shows these summaries read-only.
- **Task compaction history.** Each task `/compact` turn also creates a SQLite summary keyed by task id and Claude session id. It records before/after token counts, status, the latest useful transcript context and whether the workspace archive it pointed at was available. These summaries are self-contained; archive cleanup can remove raw workspace/session tarballs later, but the compaction row remains and records when an archive is known to have been removed.
- **Auto-compact.** The Coordinator and Captain threshold (percent of the window, or tokens) is checked by Box Yard between turns, not by the CLI, so the summary is always written first. Turning it off leaves only the CLI's own last-resort compaction near the window limit (no log file). Box agents use the CLI's `--autocompact <tokens>` when a custom threshold is set.
- **Settings** (gear icon at the top of the Coordinator panel): model and effort (`low`, `medium`, `high`, `xhigh`, `max`) for the Coordinator, for the project Captains and for box agents, optional Routing YAML for per-task choices, auto-compact thresholds, worker size, pool limits and storage retention. `create_task`, `send_to_task` and `set_task_model` take optional `model` and `effort` params (picked from the routing rules, or low for one-command chores, high for real coding, and so on); a task's own model and effort override the box agent defaults. Defaults are `claude-opus-5-5` with `high`, for Captains too; Captains wake on every project event, so their separate model and effort are the knob for Captain cost. `ORCHESTRATOR_MODEL`, `WORKER_MODEL`, `CAPTAIN_MODEL`, `CAPTAIN_EFFORT`, `WORKER_SIZE`, `BOX_POOL_MAX`, `BOX_SLOTS`, `BOX_MAX_AGENTS`, `BOXYARD_LOCAL_AGENTS`, `BOX_MAX_RESIDENT`, `BOX_IDLE_DELETE_MINUTES`, `BOXYARD_WORKSPACE_RETENTION_DAYS`, `BOXYARD_ARCHIVE_RETENTION_DAYS`, `BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS`, `BOXYARD_DISK_MIN_FREE_MB`, `BOXYARD_DISK_CLONE_FACTOR`, `BOXYARD_GIT_PUSH_AT_TURN_END`, `BOXYARD_NOTES_MAX` and `BOXYARD_NOTES_MAX_TOKENS` override the defaults, and values saved in the UI override env. Settings are stored in SQLite and read at the start of every turn or scheduler placement.

**Usage and costs.**
- Every headless Claude Code run that reports result JSON is recorded in SQLite (`claude_usage`): input, cache write, cache read and output tokens, duration and model/session metadata. The CLI's `total_cost_usd` and `modelUsage` are the session's running totals (a resumed session starts from the totals its transcript saved), so they are kept as `reported_cost_usd` and `reported_usage_json`, and each run is charged `cost_usd` and its tokens as the step from the session's previous report. Those tokens count every call the cost does, auto and manual compactions and subagents included; the result's `usage` counts only the main loop's calls. A report lower than the last one came back from an older save (a process that never saved its totals) or counted from about zero (a new box): the run is charged the step from the latest earlier report it still covers in cost and every token category, or else all of it. Rows logged before `reported_usage_json` was kept can't tell the two apart, so a drop after them is charged all of it, as before. A resumed session's first logged run, whose report also holds spend from before Box Yard logged it, gets its main-loop tokens, charged at the model's recent rate (at most what was reported) and marked `cost_estimated`. Task agent rows are tied to their task and project; Coordinator rows have no project; Captain rows are `source = 'captain'`. Spend stays when a task or project is deleted.
- **Usage** (the chart button at the bottom of the sidebar, or Settings › Usage › Spend over time) charts daily cost and tokens over the last 7, 30, 60 or 90 days: LLM spend stacked by model, compute stacked by provider (Upstash, Daytona, RunPod, Vast.ai; Docker, this computer and SSH machines are $0), and input, cache write, cache read and output tokens. Tapping a bar, a legend item or a breakdown row narrows everything to it (project, task, model, provider, role), down to single tasks and boxes, and every breakdown sums to the totals. Compute is an estimate (≈): each box's cost, from its metered intervals or a GPU pod's $/hr from creation to deletion, is split between the turns that ran on it (`task_turns.box_id`), the rest is idle box time. The API is `GET /api/usage/daily?days=<local midnights>` (`server/usageLedger.ts`, folded in the browser by `shared/usageLedger.ts`). `GET /api/usage?from=<ms>&to=<ms>` still returns the older period report.
- `npm run build && node scripts/usage-audit.mjs <data-dir>` prints corrected spend for today and 7 days by category next to what was logged, from a copy of the database.
- Box Yard also meters worker boxes in SQLite. When the Upstash Box API exposes real size, keep-alive or usage fields, those are used; otherwise active CPU time is estimated from periods where a turn is running, uptime is derived from the box row, and disk is probed from the box filesystem. Estimated rows are labeled as estimates in the UI.
- Default Upstash Box rates are configurable in Settings → Usage: active CPU hour (Small $0.10, Medium $0.20, Large $0.40), keep-alive month (Small $8, Medium $16, Large $32), and storage ($0.10/GB-month, including snapshots). Box cards show size, active time, disk use and estimated cost.
- Optional budgets in Settings → Usage warn at 80% of the daily or 30-day limit. When a configured limit is exceeded, new agent turns stay queued until the budget window resets or you raise the budget; running turns are not stopped and the orchestrator chat can still tell you what happened.

**Event bus.** The worker runner appends every event to `events.jsonl` in the box. If Upstash Redis is configured, it also adds the event to a Redis stream. Events carry sequence numbers, so the server can read either source without duplicates. If Redis misses something, the server falls back to the file.

### Where the SQLite data lives when Box Yard runs in a box

The database is a normal SQLite file (WAL mode) on the Box Yard box's own disk, at `/workspace/home/box-yard-data`. Box disks persist across pauses and redeploys, so this is the primary copy. For an off-box copy, the server snapshots its own box every 6 hours (`BOXYARD_SELF_SNAPSHOT_HOURS`) and keeps the last 3 snapshots. It checkpoints the WAL before each snapshot. If the box is ever lost, restore it with `npm run deploy:box -- --from-snapshot <id>`.

Redis is only the message bus. It never holds the source of truth, so losing it loses nothing.

## Development

```bash
./yard dev          # API on :3000 with reload, web on :5173
npm run test:related # affected tests while iterating (unlocked)
npm run test:fast   # merge gate tests, under the shared machine-wide lock
npm run test:slow   # integration tests, under the same lock
npm run test:full   # everything, under the same lock (npm test is an alias)
npx vitest run test/full-test-lock.test.ts  # focused runs do not take the lock
npm run typecheck
npm run worker-snapshot   # bake Claude Code into a snapshot -> WORKER_SNAPSHOT_ID for fast box starts
```

The merge gate is `npm run typecheck`, `npm run build`, then `npm run test:fast` on a committed, stable HEAD. The Captain owns one daily local schedule running typecheck, build and `npm test` (full); full and slow suites are not merge gates. [Testing](docs/testing.md) explains classification, per-file timing, lock wait measurement and daily full-suite setup.

The mock Claude (`scripts/fake-claude.mjs`) speaks the same headless protocol and calls the real MCP tools. In the Coordinator chat, try `create project demo`, then `task demo: Haiku -- write a haiku [artifact]`, or `schedule demo "*/5 * * * *": Haiku drop -- write a haiku [artifact]`. Worker prompts react to `[ask]`, `[fail]`, `[slow]`, `[hang]`, `[preview]`, `[artifact]`, `[note]`, `[noop]`, `[pr]` (end the turn without finish, like an agent waiting on PR review) and `[agent:<taskId>]`. With `FAKE_GH_STATE` set to a file, the Merge PR message makes the worker stand in for `gh pr merge` by writing `{"state":"MERGED"}` there.

| Path | What's there |
| --- | --- |
| `server/` | API, SQLite store, task manager, Coordinator/Captains, MCP tools, box providers (`upstash`, `local`) |
| `runner/box-runner.mjs` | Copied into each worker box. Runs turns and serves the agent's MCP tools, with no dependencies. |
| `web/` | The React app |
| `scripts/` | Deploy scripts and the fake Claude |

## Verified against real services

Checked on 2026-10-22 with a real Upstash Box account (free plan), a Claude Code OAuth token and a GitHub token, with Box Yard deployed in its own box:

- **Box API** (`npx tsx scripts/smoke-box.ts`): create (about 5 s, Claude Code and `gh` preinstalled), exec, file write/read, env vars, a real `claude -p` turn in a box, cloning a private repo, public URLs. `scripts/boxes.ts` lists, deletes and runs commands in boxes.
- **Pausing.** Over 20 minutes, no box paused, idle or not, and a background process kept running the whole time. So agent turns survive a dropped exec connection. Keep-alive needs a paid plan.
- **Cancelling an exec stream does not stop its process in the box.** Holds are written to end on their own.
- **End-to-end scenarios through the deployed Coordinator:**
  - Issues opened on several repos in parallel, one project and one box each.
  - "Close those issues" resumed the agents that opened them.
  - A follow-up sent mid-turn was queued into the same session.
  - New work in a known project got a fresh agent on the project's box.
  - A new repo got its own box. With the pool full, it shared a box.
  - An agent's question was relayed and the answer passed back.
  - A draft PR was opened and then closed, and its branch deleted.
  - Artifacts were published with working links.
  - The server was restarted mid-turn and the agent was picked back up.
  - With the Coordinator session reset, a follow-up still found the right agent.
- **Not yet checked live:** QStash schedules (only run against a fake), Upstash Redis as the event bus (the file log was used), and archive restore onto a different box after a box is lost (covered by the local tests).

## License

MIT — see [LICENSE](LICENSE).

The icons are [Lucide](https://lucide.dev)'s (ISC, a few MIT from Feather), apart from the Captain's cap and the
ship's helm, which are Box Yard's own: see [licenses/lucide.txt](licenses/lucide.txt) and
[docs/captain-icons.md](docs/captain-icons.md).

<div align="center">
<br>
<sub>If Box Yard saves you a tab, a ⭐ helps other people find it.</sub>
</div>

Task harnesses: [Claude Code](https://code.claude.com/docs/en/overview), [Codex](docs/codex.md), [Cursor](docs/cursor.md), and [OpenCode](docs/opencode.md). New adapters must cover the [harness integration inventory](docs/harness-integration.md).
