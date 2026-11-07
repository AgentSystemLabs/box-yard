# Retained chat history and Days navigation

The Coordinator, each Captain and each task can browse to the beginning of retained history. Date jumps scroll only the transcript; they cannot move its clipped ancestors or hide the header. History is fetched in pages rather than downloaded or rendered in full at startup.

## Reading and navigation

The opening Coordinator/Captain response still contains at most 500 messages; tasks retain their existing 1,000-message opening response. A separate, small date index supplies every retained visible day in the reader's timezone. New dates from SSE appear immediately, even before the date index is refreshed.

Scrolling back first reveals cached rows, then requests older pages. Archived reading windows keep at most 200 messages, and the rendered tail keeps at most 200 logical rows. Groups and day separators add their own markup. The day rail renders at most 80 buttons; scrolling, arrows, Home/End and Tab reach the rest. Newer-message controls move forward without fetching the intervening transcript all at once. Return to latest, sending a message and Jump to latest return to the current live cache.

A jump to an unloaded message fetches a page around its id before revealing and focusing it. A fetched window never splices a gap into the live cache. Late responses from an old chat or a cancelled jump are ignored; edits arriving over SSE update matching messages in a reading window. Conversation data remains in web-app memory only.

Day summaries describe loaded messages and recorded task milestones; a day with many messages can take several pages to read. The UI does not claim that missing loaded milestones mean a day had no work. Tool-only dates remain absent from the visible rail, consistent with the existing transcript filters; cursor pages retain tool messages.

## API and scope

The authenticated owner's browser API exposes:

- `/api/chat/history`
- `/api/projects/:id/captain/history`
- `/api/tasks/:id/history`

Without a cursor, these return the latest 100 messages. Supply exactly one of `before`, `after` or `around`. `around` accepts a message id; `before`/`after` accept the returned opaque cursor, or a currently loaded message id for the first transition out of the live cache. Responses contain ascending `messages`, `before`/`after` cursors (or `null` at an end), and a lightweight `positions` map for retained window edges. Around-target pages include up to 20 preceding messages and 80 starting at the target. Equal timestamps use SQLite rowid order, matching the existing logs. Opaque cursors retain the original timestamp/rowid while validating their message inside the requested conversation, so delivery of a queued boundary message cannot move the cursor past intervening history. Live timestamp changes are sorted within the current reading range; a message moved into a newer turn is read on a newer page. Fresh fetched rows replace overlapping snapshots by id. A deleted or foreign conversation cursor is rejected instead of silently changing scope.

`?days=1&tz=America%2FNew_York` returns only `{ at, messageId }` for each visible local date. Indexed timestamp seeks find its first message and the first message beyond its next local midnight. Timezone boundary lookup handles 23/25-hour dates and fractional-hour offsets. There is no per-message formatting or transcript-body scan for a busy date. The existing chat timestamp, Captain/project timestamp and task timestamp indexes serve both day seeks and cursor pages; no schema migration is required.

These routes sit behind browser authentication and the existing Host/Origin boundary. They add no MCP tools. Coordinator status-only restrictions and Captain project scoping remain enforced by the existing agent history tools. Tests cover both those privacy rules and rejection of cross-project/task browser cursors.

## Reproduction and methodology

Measurements below compare public main `97a6e9e` with the history change merged onto that same main. Both production builds ran sequentially on one local ARM64 workstation with shared 18 GB RAM, Node 24.15.0, an unthrottled headless Chromium, 1400×900 viewport, and `America/New_York` timezone. Each sample uses a fresh browser context; tables report medians of three runs. Jobs ran sequentially. Other activity on a shared workstation remains a source of noise.

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

Launch readiness (`first-load.mjs`) was **73.2 → 74.5 ms**; FCP **136 → 124 ms**; blocking time to readiness **0 → 0 ms**. JavaScript fetched to readiness was **331.4 → 333.2 KB**, eight files in both builds. Lazy surface opening medians were Settings **30.3 → 52.9 ms**, project settings **12.7 → 14.5 ms**, schedules **21.6 → 23.2 ms**. These are local wall times with shared-machine noise, not network-throttled results.

| Opening response / page | Coordinator before → after | Captain before → after | Task before → after |
| --- | ---: | ---: | ---: |
| Initial decoded JSON bytes | 500,404 → 501,106 | 714,570 → 718,692 | 865,314 → 866,165 |
| Initial document elements | 3,072 → 3,097 | 4,067 → 4,112 | 4,347 → 4,376 |
| Initial transcript child rows | 63 → 64 | 65 → 66 | 63 → 64 |
| Document elements after oldest-date jump | 15,348 → 2,535 | 10,013 → 4,512 | 11,718 → 3,794 |

The date index adds 702 / 4,122 / 851 decoded bytes in this fixture. Initial message limits stay the same; history bodies are requested only when needed. Initial markup adds navigation/loading wrappers, while historical DOM size falls substantially.

The following holds the work constant: one draft fill plus 22 keystrokes, five 600px upward scrolls, and one cached-row prepend. Times are milliseconds; CPU means CDP main-thread work.

| Interaction | Coordinator before → after | Captain before → after | Task before → after |
| --- | ---: | ---: | ---: |
| Typing sequence CPU | 41.7 → 50.4 | 31.3 → 37.0 | 21.2 → 28.8 |
| Typing sequence wall time | 57.5 → 66.3 | 38.8 → 45.7 | 30.9 → 43.3 |
| Streamed reply CPU, per reply | 18.9 → 19.4 | — | — |
| Five-scroll CPU | 22.1 → 28.0 | 65.0 → 51.1 | 65.0 → 51.3 |
| Five-scroll wall time | 149.0 → 190.2 | 235.9 → 244.3 | 278.8 → 289.7 |
| Prepend wall time | 23.5 → 25.2 | 25.6 → 21.7 | 23.1 → 21.0 |
| Prepend anchor displacement, pixels | −0.2 → −0.2 | 0 → 0 | −0.7 → +0.3 |
| Same-calendar-date jump | 93.2 → 98.0 | 94.4 → 152.3 | 107.8 → 128.0 |
| Jump to true retained beginning | unavailable → 124.5 | unavailable → 68.3 | unavailable → 109.9 |

Typing's measured aggregate CPU rises by 5.7–8.7 ms across the whole sequence (under 0.4 ms per typed character); the streamed reply delta is 0.5 ms. These small costs are reported, not assumed to be zero. The bounded-window and memoized-transcript tests cover draft isolation. The Captain's same-date jump now fetches that date's actual first message (`cm_example-1084`), instead of stopping at the opening cap's `cm_example-1100`; that accounts for an extra request and useful work. Coordinator/task date jumps likewise reach the actual date boundary.

Before, the oldest reachable ids were `chat_heavy00702`, `cm_example-1100`, and `tm_heavy01000`. After, the true beginnings are `chat_heavy00000`, `cm_example-0`, and `tm_heavy00000`. Header top positions after date jumps were **−56 / −41 / −56 px** before and **0 / 54 / 0 px** after. The Captain header normally begins below the 53px page header. Before, clipped `MAIN` ancestors acquired 56–95px of scroll; after, none did.

The existing `long-transcript.mjs` also ran three times on each build:

| Full walk and subsequent interaction | Coordinator before → after | Task before → after |
| --- | ---: | ---: |
| Raw retained rows reachable by the walk | 500 → 1,200 | 1,000 → 2,000 |
| Document elements at oldest point | 15,348 → 4,980 | 11,718 → 4,855 |
| Direct transcript child rows at oldest point | 329 → 136 | 446 → 87 |
| Reply CPU while reading history | 26.3 → 6.3 ms | — |
| Rotation CPU after reading history | 256.4 → 98.5 ms | 173.8 → 77.7 ms |
| Entire walk CPU, different amounts of work | 524.6 → 1,272.9 ms | 341.8 → 754.6 ms |
| Walk frames exceeding 50 ms, different work | 18 → 45 | 18 → 35 |
| Median longest walk frame | 83.4 → 91.7 ms | 66.8 → 100.0 ms |

The largest observed single task-walk frame across runs was 415.8 ms before and 358.3 ms after. Full-walk totals include the additional network pages and retained history now accessible. They are not equivalent-work latency comparisons. Reading-window reply/rotation costs improve as the DOM stays bounded.

## Browser and layout checks

Chromium and WebKit each passed date jumps at **320 / 400 / 560 / 800px**, at **100% and 125% CSS zoom**: 16 combinations. Every jump focused the true oldest Captain message, left the header visible, kept clipped ancestors at zero scroll, and avoided horizontal page overflow. Date targets measure 44px at normal scale and 55 visual pixels at 125%.

A separate 400px interaction check sends 20 streaming updates while reading older content, then performs four prepends (including a bounded-window change). Streaming moved the reading anchor **0px** in both engines at both scales. Prepend displacements were:

| Engine / scale | Four visual-pixel displacements |
| --- | --- |
| Chromium 100% | −0.25, −0.25, −0.25, +0.50 |
| Chromium 125% | +0.05, +0.19, +0.06, −0.22 |
| WebKit 100% | +0.75, +0.75, −0.25, +0.50 |
| WebKit 125% | −0.69, +0.44, +0.06, +0.13 |

The WebKit zoom check initially exposed 1.3–1.4px drift: WebKit floors fractional `scrollTop` assignments. Choosing the nearest representable scroll position reduced every measured displacement below one visual pixel; Chromium retains its fractional positioning. A regression test models that rounding behavior.


## Limits of the comparison

The cached-date comparison selects the same calendar date, but the new version reaches its actual first retained message. The old capped response can begin partway through that date. A network page fetch can therefore replace a cached-only jump. The separate oldest-date result represents newly reachable history, not an equivalent operation on the old version.

The stock long-transcript script walks until no earlier sentinel remains: before, it stops at the 500/1,000 API caps; after, it traverses all 1,200/2,000 retained rows in successive windows. Its total traversal cost and frame counts cover different amounts of work and should not be presented as a like-for-like regression. The five-scroll comparison above holds work constant.

These are headless local measurements, not physical-device or production-network benchmarks. The fit matrix uses CSS `zoom: 1.25` to exercise layout scaling, rather than browser-chrome zoom controls. Long-task observer results vary by browser support; CDP main-thread durations and frame gaps are the useful Chromium comparisons. Results do not establish latency for every possible transcript size or message body. No full test suite is part of this task's gate.
