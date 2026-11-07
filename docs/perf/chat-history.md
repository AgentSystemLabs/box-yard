# Retained chat history and Days navigation

The Coordinator, each Captain and each task can browse to the beginning of retained history. Date jumps scroll only the transcript; they cannot move its clipped ancestors or hide the header. History is fetched in pages rather than downloaded or rendered in full at startup.

## Reading and navigation

The opening Coordinator/Captain response still contains at most 500 messages; tasks retain their existing 1,000-message opening response. A separate, small date index supplies every retained visible day in the reader's timezone. New dates from SSE appear immediately, even before the date index is refreshed.

Scrolling back first reveals cached rows, then requests older pages. Archived reading windows keep at most 200 messages, and the rendered tail keeps at most 200 logical rows. Groups and day separators add their own markup. The day rail renders at most 80 buttons; scrolling, arrows, Home/End and Tab reach the rest. Newer-message controls move forward without fetching the intervening transcript all at once. Return to latest, sending a message and Jump to latest return to the current live cache.

A jump to an unloaded message fetches a page around its id before revealing and focusing it. A fetched window never splices a gap into the live cache. Late responses from an old chat or a cancelled jump are ignored; edits arriving over SSE update matching messages in a reading window. Conversation data remains in web-app memory only.

Day summaries describe loaded messages and recorded task milestones; a day with many messages can take several pages to read. The UI does not claim that missing loaded milestones mean a day had no work. Tool-only and queued/cancelled-only dates remain absent from the visible rail, consistent with the transcript's day dividers; cursor pages retain those raw messages. The metadata also identifies the oldest raw message, so hidden rows do not incorrectly suppress access to earlier pages.

## API and scope

The authenticated owner's browser API exposes:

- `/api/chat/history`
- `/api/projects/:id/captain/history`
- `/api/tasks/:id/history`

Without a cursor, these return the latest 100 messages. Supply exactly one of `before`, `after` or `around`. `around` accepts a message id; `before`/`after` accept the returned opaque cursor, or a currently loaded message id for the first transition out of the live cache. Responses contain ascending `messages`, `before`/`after` cursors (or `null` at an end), and a lightweight `positions` map for retained window edges. Around-target pages include up to 20 preceding messages and 80 starting at the target. Equal timestamps use SQLite rowid order, matching the existing logs. Opaque cursors retain the original timestamp/rowid while validating their message inside the requested conversation, so delivery of a queued boundary message cannot move the cursor past intervening history. Live timestamp changes are sorted within the current reading range; a message moved into a newer turn is read on a newer page. Fresh fetched rows replace overlapping snapshots by id. A deleted or foreign conversation cursor is rejected instead of silently changing scope.

`?days=1&tz=America%2FNew_York` returns `{ days: [{ at, messageId }], oldestId }`: one entry per visible local date plus the oldest raw message id, without transcript bodies. Indexed timestamp seeks find its first message and the first message beyond its next local midnight. Timezone boundary lookup handles 23/25-hour dates and fractional-hour offsets. There is no per-message formatting or transcript-body scan for a busy date. The existing chat timestamp, Captain/project timestamp and task timestamp indexes serve both day seeks and cursor pages; no schema migration is required.

These routes sit behind browser authentication and the existing Host/Origin boundary. They add no MCP tools. Coordinator status-only restrictions and Captain project scoping remain enforced by the existing agent history tools. Tests cover both those privacy rules and rejection of cross-project/task browser cursors.

## Reproduction and methodology

Measurements below compare public main `ec92dac` with runtime implementation `ae301db`, merged onto that same main. Subsequent commits refine only measurement setup and documentation. Both production builds ran sequentially on one local ARM64 workstation with shared 18 GB RAM, Node 24.15.0, an unthrottled headless Chromium, 1400×900 viewport, and `America/New_York` timezone. Each sample uses a fresh browser context; tables report medians of three runs. Jobs ran sequentially. Other activity on a shared workstation remains a source of noise.

Two isolated mock servers used independent data directories and ports above 4011. Neither the live app nor its data was used. Both received the same SQLite backup: the heavy fixture's 1,200 Coordinator messages and 2,000 task events, plus 1,600 Captain messages. Captain ids are `cm_example-0` through `cm_example-1599`, one hourly from `2026-09-01T00:00:00Z`, one user then two assistant messages per three rows. Their content is a numbered example reply followed by four repetitions of “An example reply with enough text to wrap in a narrow conversation.” The Captain belongs to `prj_heavy-yard` (`acme/box-yard`). Mock pulse replies are SSE-only and do not change the retained fixture.

Use the same fixture backup for each build, then run these commands sequentially, substituting isolated mock URLs and an installed Playwright module/browser:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs
CHROME_PATH=/path/to/chromium
CHROMIUM_PATH="$CHROME_PATH"
export PLAYWRIGHT_MODULE CHROME_PATH CHROMIUM_PATH
node scripts/perf/history.mjs http://localhost:4263 before 3
node scripts/perf/history.mjs http://localhost:4262 after 3
node scripts/perf/long-transcript.mjs http://localhost:4263 before 3
node scripts/perf/long-transcript.mjs http://localhost:4262 after 3
node scripts/perf/first-load.mjs http://localhost:4263 --runs=3
node scripts/perf/first-load.mjs http://localhost:4262 --runs=3
node scripts/perf/history-layout.mjs http://localhost:4262 after /path/to/screenshots
HISTORY_BROWSER=webkit node scripts/perf/history-layout.mjs http://localhost:4262 after-webkit /path/to/screenshots
node scripts/perf/history-interactions.mjs http://localhost:4262
HISTORY_BROWSER=webkit HISTORY_ZOOM=1.25 node scripts/perf/history-interactions.mjs http://localhost:4262
```

`history.mjs` measures a draft fill plus 22 keystrokes, ten streamed replies, five 600px upward scrolls, a prepend's position and latency, a jump to the same calendar date on each version, and a separate jump to the rail's oldest date. Main-thread work comes from Chromium CDP `TaskDuration`. Payload counts are decoded JSON bytes for initial boot/message/recent-Captain/date-index responses, not compressed wire bytes. Date/prepend wall times include render frames. Initial readiness in that script includes an explicit settling delay; use `first-load.mjs` for launch readiness.

## Results

Launch readiness (`first-load.mjs`) was **71.7 → 81.2 ms**; blocking time to readiness **0 → 0 ms**. JavaScript fetched to readiness was **332.5 → 334.3 KB**, eight files in both builds. The existing script returned a missing-paint sentinel (0) for the after FCP median: its paint entry was not available when readiness was sampled. That value is unavailable, not a zero-millisecond paint or a measured improvement. Lazy surface opening medians were Settings **43.3 → 39.6 ms**, project settings **14.4 → 11.9 ms**, schedules **23.3 → 23.2 ms**. These are local wall times with shared-machine noise, not network-throttled results.

| Opening response / page | Coordinator before → after | Captain before → after | Task before → after |
| --- | ---: | ---: | ---: |
| Initial decoded JSON bytes | 500,404 → 501,144 | 714,570 → 718,764 | 865,314 → 866,238 |
| Initial document elements | 3,073 → 3,098 | 4,068 → 4,113 | 4,348 → 4,377 |
| Initial transcript child rows | 63 → 64 | 65 → 66 | 63 → 64 |
| Document elements after oldest-date jump | 15,349 → 2,536 | 10,014 → 4,513 | 11,719 → 3,795 |

The date index adds 740 / 4,194 / 924 decoded bytes in this fixture. Initial message limits stay the same; history bodies are requested only when needed. Initial markup adds navigation/loading wrappers, while historical DOM size falls substantially.

The following holds the work constant: one draft fill plus 22 keystrokes, five 600px upward scrolls, and one cached-row prepend. Times are milliseconds; CPU means CDP main-thread work.

| Interaction | Coordinator before → after | Captain before → after | Task before → after |
| --- | ---: | ---: | ---: |
| Typing sequence CPU | 36.3 → 35 | 26.5 → 27.4 | 34.5 → 30.8 |
| Typing sequence wall time | 52.9 → 48.5 | 38 → 42.2 | 47.9 → 50.8 |
| Streamed reply CPU, per reply | 20.2 → 19.9 | — | — |
| Five-scroll CPU | 30 → 17.2 | 41.8 → 47.9 | 68.9 → 57.4 |
| Five-scroll wall time | 151.6 → 182 | 252.5 → 299.9 | 288.1 → 327.3 |
| Prepend wall time | 32.9 → 26.1 | 14.1 → 42.2 | 16.4 → 21.7 |
| Prepend anchor displacement, pixels | -0.2 → -0.2 | 0 → 0 | -0.7 → 0.3 |
| Same-calendar-date jump | 107.2 → 151.5 | 126.7 → 171.6 | 117.2 → 121.5 |
| Jump to true retained beginning | unavailable → 204.9 | unavailable → 92.1 | unavailable → 158.9 |

The Captain same-date jump now reaches `cm_example-1084`, instead of stopping at the opening cap's `cm_example-1100`; Coordinator/task jumps likewise reach the actual first message of the date. Fetching that boundary can add a request in place of a cached-only jump. Typing and streaming values above cover the same work on both builds; small wall-time differences include frame scheduling and shared-machine activity. The separate prepend scheduling/CPU check below supplies a larger sample for that operation.

Before, the oldest reachable ids were `chat_heavy00702`, `cm_example-1100`, and `tm_heavy01000`. After, the true beginnings are `chat_heavy00000`, `cm_example-0`, and `tm_heavy00000`. Header top positions after date jumps were **−56 / −41 / −56 px** before and **0 / 54 / 0 px** after. The Captain header normally begins below the 53px page header. Before, clipped `MAIN` ancestors acquired 56–95px of scroll; after, none did.

The existing `long-transcript.mjs` also ran three times on each build:

| Full walk and subsequent interaction | Coordinator before → after | Task before → after |
| --- | ---: | ---: |
| Raw retained rows reachable by the walk | 500 → 1,200 | 1,000 → 2,000 |
| Document elements at oldest point | 15,349 → 4,981 | 11,719 → 4,856 |
| Direct transcript child rows at oldest point | 329 → 136 | 446 → 87 |
| Rotation CPU after reading history | 221.3 → 77.7 | 167.1 → 74.1 |
| Entire walk CPU, different amounts of work | 545.1 → 1,469.4 | 341.6 → 844.3 |
| Walk frames exceeding 50 ms, different work | 24 → 131 | 19 → 62 |
| Median longest walk frame | 91.9 → 250 | 83.4 → 266.7 |
| Reply CPU while reading history | 24.6 → 4.9 ms | — |

The largest observed single task-walk frame across runs was 375 → 384 ms. Full-walk totals include the additional network pages and retained history now accessible. They are not equivalent-work latency comparisons. Reading-window reply/rotation costs improve as the DOM stays bounded.

A supplemental five-run task-only prepend check measured 41.6 → 23.7 ms wall time and 20 → 18.1 ms main-thread CPU. The measured anchor stayed within one pixel. This control ran after the stable-cursor fix and before the final visible-date metadata adjustment, which changes no prepend/render code. It illustrates scheduling variation in the three-run wall times; it does not replace the primary results above.

A separate five-run Captain check waits for at least 60 initial rows and five unchanged frames before the same interaction sequence. Its prepend median was **21.4 → 25.5 ms wall time**, **15.6 → 14.5 ms main-thread CPU**, with **-0.0 → -0.0px** displacement. This check investigates the primary Captain wall-time increase with a settled initial transcript; it does not replace that primary result.

## Browser and layout checks

Chromium and WebKit each passed date jumps at **320 / 400 / 560 / 800px**, at **100% and 125% CSS zoom**: 16 combinations. Every jump focused the true oldest Captain message, left the header visible, kept clipped ancestors at zero scroll, and avoided horizontal page overflow. Date targets measure 44px at normal scale and 55 visual pixels at 125%. The current matrix uses the default system-light appearance from the new main; the preceding dark appearance was also checked during implementation.

A separate 400px interaction check sends 20 streaming updates while reading older content, then performs four prepends (including a bounded-window change). Streaming moved the reading anchor **0px** in both engines at both scales. Prepend displacements were:

| Engine / scale | Four visual-pixel displacements |
| --- | --- |
| Chromium 100% | -0.25, -0.25, -0.25, +0.50 |
| Chromium 125% | +0.05, +0.19, +0.06, -0.22 |
| WebKit 100% | +0.75, +0.75, -0.25, +0.50 |
| WebKit 125% | -0.69, +0.44, +0.06, +0.12 |

An earlier interaction sample mixed a native wheel with an immediate scripted 2,400px scroll and failed by that setup distance. The final protocol uses native wheel input alone, waits for five unchanged animation frames before marking its anchor, and reruns all four engine/scale cases. Date-rail checks wait for the virtualized first button and the requested oldest divider, rather than relying on a fixed delay.

The WebKit zoom check initially exposed 1.3–1.4px drift: WebKit floors fractional `scrollTop` assignments. Choosing the nearest representable scroll position reduced every measured displacement below one visual pixel; Chromium retains its fractional positioning. A regression test models that rounding behavior.

## Limits of the comparison

The cached-date comparison selects the same calendar date, but the new version reaches its actual first retained message. The old capped response can begin partway through that date. A network page fetch can therefore replace a cached-only jump. The separate oldest-date result represents newly reachable history, not an equivalent operation on the old version.

The stock long-transcript script walks until no earlier sentinel remains: before, it stops at the 500/1,000 API caps; after, it traverses all 1,200/2,000 retained rows in successive windows. Its total traversal cost and frame counts cover different amounts of work and should not be presented as a like-for-like regression. The five-scroll comparison above holds work constant.

These are headless local measurements, not physical-device or production-network benchmarks. The fit matrix uses CSS `zoom: 1.25` to exercise layout scaling, rather than browser-chrome zoom controls. Long-task observer results vary by browser support; CDP main-thread durations and frame gaps are the useful Chromium comparisons. Results do not establish latency for every possible transcript size or message body. No full test suite is part of this task's gate.
