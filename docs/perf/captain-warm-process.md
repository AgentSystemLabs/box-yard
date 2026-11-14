# A warm claude process per Captain, and streamed Captain replies

Two settings under Settings › Coordinator, both on by default:

- **Warm Claude process** (`captainWarmProcess`, idle time `captainWarmIdleMinutes`, default 30 min): a Captain the
  owner is chatting with keeps one `claude` process running between its turns. Each turn is one line of
  `--input-format stream-json` written to it, and the turn ends at its `result` line. A cold turn first spends about
  0.6 s starting Claude Code (node, its config, the MCP handshake) before the model sees the prompt.
- **Stream Captain replies** (`captainStreamReplies`): the Captain runs with `--include-partial-messages`, and its
  reply shows in the chat as it is written (`captain.delta` events) instead of all at once when it's done.

## How the warm process behaves

`server/warmClaude.ts` (the process) and `Captain.warmFor`/`prewarm`/`armWarmTimer` in `server/captains.ts`.

- **When it exists.** The owner is "active" with a Captain from their message to it, from opening or typing in its
  chat box (`POST /api/projects/:id/captain/warm`, at most once a minute, `web/src/lib/captainWarm.ts`), and at the
  end of a turn they started. While they were active within the idle time, the Captain's turns run in its warm
  process. That includes turns woken by its tasks, agents or schedules, but those don't extend the idle time. Opening
  the chat box starts one ahead of the first message.
- **What it stands in for.** `warmKey` hashes the binary, the flags (without `--resume`/`--session-id`), the whole
  env, the folder and the MCP config's content. A turn whose launch hashes differently drops it and starts a new one.
  That covers a new login (the rotation's, the project's own, Settings › Credentials), env vars (the Coordinator's or
  the project's), model, effort, connectors, system prompt (notes, identity) and tools. Saving Settings re-checks
  every warm process at once. It also has to continue the turn's session.
- **Only one at a time, never shared.** One per Captain, and only for its main-session turns. Summaries,
  compactions and `/context` continue the same session, so they drop it first and start their own process as before.
  Side threads fork the session in processes of their own, and Codex Captains don't use it. A project's process has
  that project's env and login only.
- **Ends.** At the idle time, which is read live, so a shorter setting ends processes that are already older. Also
  when the setting is turned off, on Stop, when the project is deleted, and when Box Yard stops. It runs in its own
  process group, and kill reaches its MCP servers too. If Box Yard dies without killing it, its stdin closes and
  Claude Code exits.
- **Crashes.** If the process ends before it printed anything for a turn, that turn runs again in a new cold process,
  with the login it already picked. A crash part-way through a turn is reported like any failed turn.

## What streaming shows

`shared/captainStream.ts`: the live text is the reply so far, minus anything that could still turn out to be hidden.
That means a bare `(no update)`, the `<!-- boxyard-… -->` blocks (next steps, the Coordinator FYI line) and a fenced
` ```boxyard-next-steps ` block, from their first character, even when they arrive split across chunks. The stored
message is made exactly as before, from the whole assistant message; the live text is dropped when it lands.
`test/captain-stream.test.ts` checks every split of a set of replies.

## Measured

November 13, 2026, on an Apple M3 Pro (macOS 26.5, Node 24.15, Claude Code 2.1.322), local runner. Claude Opus 5.5 at
medium effort for both the Captain and the task. Six rounds per row after one warm-up round, p50 and p90, every answer
correct. Method as in #76: `scripts/perf/captain-task-loop.ts`, one scratch Box Yard per row.

**A message to a Captain → it starts a task → the task replies → the Captain answers** (`--scenario wait`: the Captain
waits for the task in the same turn).

| Row | Total p50 | Total p90 | Model p50 | CLI p50 | Box Yard p50 | Captain CLI start-up p50 |
|---|---:|---:|---:|---:|---:|---:|
| Warm off, streaming off | 9.38 s | 10.4 s | 7.27 s | 1.51 s | 0.63 s | 0.55 s |
| Warm process + streaming | 7.00 s | 7.95 s | 5.17 s | 1.10 s | 0.62 s | 0.01 s |

**The same, with the Captain woken by the task's finish** (`--scenario wake`: two Captain turns per round).

| Row | Total p50 | Total p90 | Model p50 | CLI p50 | Box Yard p50 | First words p50 | Captain start-ups p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Warm off, streaming off | 8.85 s | 11.0 s | 5.22 s | 2.56 s | 0.98 s | 3.14 s | 0.62 s + 0.57 s |
| Warm process + streaming | 5.96 s | 8.83 s | 3.81 s | 1.12 s | 0.89 s | 2.35 s | 0.01 s + 0.01 s |

The warm process changes the CLI column only: it saves each Captain turn its start-up, 0.4 s on the waiting path and
1.4 s on the wake path. The rest of each total's drop is the model's run-to-run spread; the task's model steps, which
nothing here touches, differed by up to 2.7 s between rows.

**A question the Captain answers in a paragraph, no task** (`--scenario talk`, about 730 characters).

| Row | First words p50 | First words p90 | Whole reply p50 | Whole reply p90 | Captain CLI start-up p50 |
|---|---:|---:|---:|---:|---:|
| Warm off, streaming off | 3.93 s | 4.42 s | 3.93 s | 4.42 s | 0.66 s |
| Streaming only | 1.53 s | 1.93 s | 4.76 s | 5.31 s | 0.60 s |
| Warm process only | 3.55 s | 5.21 s | 3.55 s | 5.21 s | 0.01 s |
| Warm process + streaming | **0.61 s** | 1.32 s | 3.67 s | 4.37 s | 0.01 s |
| First message after opening the chat box (a fresh process, warmed 3 s ahead) | 0.73 s | 1.69 s | 3.55 s | 4.48 s | 0.03 s |

Streaming doesn't slow the whole reply: warm-only and warm + streaming end 0.1 s apart. The streaming-only row's
whole reply is the model's spread; its first words, 2.4 s sooner than the baseline's, are not.

**Memory.** An idle warm process with its children, by process group (`ps` RSS): 225–231 MB right after its turns, and
140–210 MB over the next 3 minutes. The Captain's only MCP server is Box Yard's own, over HTTP, so there is no child
process unless the project has stdio connectors.

**Idle time.** Replaying two weeks of a real Box Yard's Captain turns (2,045 turns in 5 projects, timestamps only)
against the idle time. This doesn't count the warm-up from opening the chat box, so the real share is higher.

| Idle time | Captain turns that find it warm | of the owner's own turns | Processes alive on average | At most at once |
|---:|---:|---:|---:|---:|
| 5 min | 25 % | 48 % | 0.08 | 3 |
| 15 min | 42 % | 63 % | 0.18 | 3 |
| **30 min** | **55 %** | **74 %** | **0.29** | **3** |
| 60 min | 66 % | 82 % | 0.44 | 3 |
| 120 min | 73 % | 86 % | 0.65 | 4 |

30 minutes is the default: it is where the curve bends. Going from 30 to 60 minutes adds 11 points for 50 % more
process time.

## Not done: a spare process for tasks

A task's `claude` is fixed at spawn to its own worktree, its login, its project's env, its MCP config (with the task's
own URL) and its session. A spare started before the task exists can't be pointed at those afterwards. A task turn
also spends about 0.5 s of minutes in start-up, against a Captain turn's 0.6 s of 3–5 s. So tasks start as before:
one process per turn.

## Reproduce

```sh
# Each row: its own scratch data folder and port, never a live Box Yard. --real spends tokens (about $0.15 a round).
npx tsx scripts/perf/captain-task-loop.ts 6 --real --label base --json base.json --data /tmp/bench/base --port 4701 \
  --model claude-opus-5-5 --effort medium --scenario wait --settings '{"captainWarmProcess":false,"captainStreamReplies":false}'
npx tsx scripts/perf/captain-task-loop.ts 6 --real --label warm --json warm.json --data /tmp/bench/warm --port 4701 \
  --model claude-opus-5-5 --effort medium --scenario wait --idle-watch 180
# --scenario wake | talk; --fresh-warm --prewarm-ms 3000 for the first message after opening the chat box
npx tsx scripts/perf/captain-task-loop.ts --summarize base.json warm.json
```

Afterwards, remove the runs' session folders under `~/.claude/projects` (named after the scratch data folders).
