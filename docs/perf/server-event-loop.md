# Server event-loop blocking: SQLite statement compiling

Root cause: better-sqlite3 compiles a statement's SQL on every `db.prepare()`, and the Store called `prepare()` on
every read and write. Compiling `SELECT * FROM tasks WHERE id = ?` takes ~40 µs; running it takes ~7 µs. One task
row for the UI (`taskFromRow`) runs five or six small queries, so `GET /api/tasks`, every live `task` event
(`emitTask` → `getTask`) and the scheduler's placement passes spent most of their time compiling SQL. All of it is
synchronous, so it blocked the event loop: no request, SSE write or turn poll ran meanwhile.

In a CPU profile of the mock server under load (20 running mock agents, 4 clients, SSE pulses), `prepare` was the
largest self-time entry: 2.6 s of 8.9 s busy (29 %), ahead of `child_process.spawn` (1.5 s, the local provider's
per-poll `bash`) and GC (0.4 s).

Fix: `openDb` keeps a bounded LRU (500) of compiled statements per connection (`cacheStatements` in
`server/db.ts`). No call sites changed.

## Reproduce

```sh
npm run build
# Event-loop delay and server CPU under load: starts its own mock server per run (temp data dir, --port)
node scripts/perf/server-eld.mjs --port 4011 --runs 5 --seconds 30 --tasks 20 --clients 4 --extra-tasks 400
# Per-call cost of the Store reads on the same yard
node scripts/perf/store-bench.mjs --extra-tasks 400
# Baseline: build main in another worktree and pass --dist <worktree>/dist to either script
```

`server-eld.mjs` load: the heavy mock yard plus 400 finished tasks (460 in all), 20 mock agents running turns of
0–40 s, 4 browser-like clients each holding `/api/stream` open and repeating the app's start-up requests every 5 s,
and 5 SSE task messages every 250 ms. It measures 30 s after a 3 s warm-up, with `monitorEventLoopDelay`
(5 ms resolution, so ~5 ms is an idle loop) preloaded into the server (`scripts/perf/eld-preload.mjs`).

## Results

Measured November 4, 2026 on Upstash boxes (aarch64, 64 vCPUs shared with other agents' runs, Node 25.9.0).
Baseline 0145011 (main), after 82626b2. Medians.

`server-eld.mjs`, 5 runs per build, interleaved main/branch (medium box):

| Metric | Before | After | Change |
|---|---|---|---|
| Server CPU over the 30 s window | 4,546 ms (15.2 %) | 2,058 ms (6.9 %) | −55 % |
| Event-loop delay p99 | 34.7 ms | 14.3 ms | −59 % |
| Event-loop delay max | 159.5 ms | 53.3 ms | −67 % |
| Stalls over 50 ms | 26 (1,578 ms) | 0 | gone |
| Start-up request latency p50 | 50.2 ms | 13.9 ms | −72 % |
| Start-up request latency p95 | 79.5 ms | 21.1 ms | −73 % |
| Start-up request latency max | 139.6 ms | 32.2 ms | −77 % |
| Requests answered in the window | 288 | 288 | same load |

`store-bench.mjs`, 3 runs per build, interleaved (large box), ms per call:

| Call | Before | After | Change |
|---|---|---|---|
| `listTasks()`, 460 tasks (`GET /api/tasks`) | 35.59 | 5.48 | 6.5× faster |
| `getTask(id)` (every live `task` event) | 0.136 | 0.014 | 9.7× faster |
| `getTaskRow(id)` | 0.061 | 0.005 | 12× faster |
| `listProjects()` | 0.175 | 0.030 | 5.8× faster |
| `listTaskMessages(1000)` | 0.982 | 0.895 | −9 % (row building dominates) |

## Not fixed here

- **Local runner polls spawn `bash`.** Every 1.5 s each working task on a local box (this computer, mock mode,
  `BOX_PROVIDER=local`) runs `bash -c 'wc; ls -i; tail | head'` to read `events.jsonl`. `spawn` forks the server
  synchronously: ~2.5 ms of main thread each, 1.5 s per 45 s with 20 agents. Reading the file with `fs.promises` for
  local boxes would remove it. Upstash/Docker boxes read over the network and aren't affected.
- **`LocalProvider.usage()`** walks a box folder with `statSync`/`readdirSync` (`dirSize`) every 5 minutes per box:
  long stalls once workspaces hold `node_modules`. Only the folder-box provider (mock mode, single-VPS installs);
  the local runner already skips it.
- **`listTasks()` is N+1:** five or six queries per task (pending inputs, usage totals, runner, placement). Still
  5.5 ms at 460 tasks; one joined query per list would make it flat.
- **`schedulePass` → `pickBox`:** placing 20 tasks queued at once showed busy stretches of 100–530 ms in the
  profile (before this fix; part of it was the compiling fixed here).
