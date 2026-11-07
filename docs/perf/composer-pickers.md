# Composer picker timing evidence

Root cause: Both picker lists were fetched only on click or typed trigger, and the location endpoint waited for the slowest local/Docker availability check before returning stored SSH machine rows.

## Conditions and reproduction

Measured on November 3, 2026 in headless Chromium 156 on this Upstash ARM64 box, using production Vite builds: baseline 6b1904a (includes #259), after 765e776. Desktop 1440×1000 with mouse, phone 400×860 with touch emulation; 100% zoom, no CPU/network throttling. One observation per scenario (32 total); these are diagnostic samples, not percentiles or live SSH/network measurements. Both picker API routes are intercepted in the browser and each response is delayed exactly 1200 ms. Other reads use a separate mock yard on port 4010; writes and SSE are blocked. Synthetic machines are emma (ready) and addie-bug (offline); no live machines were contacted.

Cold: a new browser context, opening as soon as the composer is actionable; prefetch may already have consumed part of the imposed delay. Mount-idle: a new context, wait 1500 ms after the button appears before first opening (prefetch is warm only after the fix). Reopen: open once, wait for values, close and reopen within 30 seconds. Stale: warm once, advance Date.now by 31 seconds without changing performance.now, then reopen while the response is delayed. Menu means first animation frame with a nonempty menu rectangle. First options means first animation frame containing a target row; Default/loading do not count. The timer starts at browser pointerdown, excluding Playwright actionability waiting; these are DOM/frame observations, not photon measurements.

```sh
npm run build
PORT=4010 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/picker-perf-yard node dist/server/server/index.js
PLAYWRIGHT_MODULE=/tmp/picker-browser/node_modules/playwright/index.mjs \
  node scripts/perf/composer-pickers.mjs http://localhost:4010 before /tmp/picker-evidence/before
# Apply/build the change, then run the same script:
PLAYWRIGHT_MODULE=/tmp/picker-browser/node_modules/playwright/index.mjs \
  node scripts/perf/composer-pickers.mjs http://localhost:4010 after /tmp/picker-evidence/after
```

Install Playwright outside the repository and its Chromium binary if needed. Stop the isolated server after capturing. Do not use a live yard or port 3000.

## Results (milliseconds, before → after)

| Cache condition | Device | Picker | Menu | First options |
|---|---|---|---|---|
| mount-idle | desktop | Where / machines | 12.6 → 12.6 | 1213.8 → 12.6 |
| mount-idle | desktop | Harness | 12.8 → 12.9 | 1212.8 → 13.0 |
| mount-idle | phone | Where / machines | 15.9 → 15.8 | 1215.7 → 15.9 |
| mount-idle | phone | Harness | 18.6 → 15.5 | 1215.3 → 15.5 |
| cold | desktop | Where / machines | 11.4 → 11.3 | 1215.0 → 1046.2 |
| cold | desktop | Harness | 12.5 → 12.9 | 1212.5 → 1147.7 |
| cold | phone | Where / machines | 11.9 → 15.5 | 1214.4 → 1117.0 |
| cold | phone | Harness | 16.0 → 15.6 | 1215.6 → 1149.3 |
| reopen | desktop | Where / machines | 13.8 → 13.7 | 13.8 → 13.8 |
| reopen | desktop | Harness | 14.5 → 14.3 | 14.5 → 14.3 |
| reopen | phone | Where / machines | 16.0 → 15.9 | 16.0 → 16.0 |
| reopen | phone | Harness | 16.1 → 16.0 | 16.1 → 16.0 |
| stale | desktop | Where / machines | 13.9 → 11.7 | 13.9 → 11.7 |
| stale | desktop | Harness | 14.3 → 13.8 | 14.3 → 13.8 |
| stale | phone | Where / machines | 16.0 → 16.0 | 16.0 → 16.1 |
| stale | phone | Harness | 16.2 → 16.0 | 16.2 → 16.0 |

The menu shell was already quick before the fix. The change removes the first-open wait after the mounted composer has had time to prefetch. A truly cold cache still waits for its first authoritative response and shows a checking state; no runner is invented as available. Reopens and cached stale refreshes were already quick and remain so. After the fix, each fresh scope makes two initial requests (location + current/default harness) and a stale open adds only one request for the opened list. The harness rows for an uncached new location remain visible but disabled until checked. Background completion updates options without moving focus. Unit tests also verify shared in-flight deduplication across composers, zero composer commits for unchanged background results, focus refresh, error/retry behavior and retained explicit selections.

## Request trace

- `Composer.tsx` already fetches `/api/settings` on mount for upload limits; it does not wait for that request to open either picker.
- `useChatPicks` previously enabled `/api/run-targets[?project=…]` only for an `@` in the draft or the Where popover, and `/api/harness-targets[?project=…&runsOn=…]` only for the harness picker/pick.
- `/api/run-targets` calls `listRunTargets`, which awaits local, box, Docker and GPU runner checks together before building all rows. Local tool/login checks have a one-minute cache and share in-flight work; Docker info has its own cache and in-flight deduplication. A slow check delays the entire response, including unrelated machine rows.
- Machine rows, labels and “Local means” come synchronously from `MachineActions.status()` → `MachineService.status()` and the registry: saved tests/reachability and current task counts. Opening the menu does not call Test connection, SSH tools probes, install/login flows or `/api/machines`.
- `/api/harness-targets` uses `Setup.runnerProblem` or the project-aware `TaskManager.requireRunner`, plus the current/default runner and project keys. SSH placement later checks installed CLIs and logins; the menu adds no SSH probe.
- The fix mounts the existing shared React Query observers early. Cache keys retain project and runner scope, the existing 30-second freshness window bounds open/focus requests, in-flight calls deduplicate, and there is no interval polling or automatic retry. Machine events already invalidate the lists; identity/settings events now also invalidate them. Server send-time checks are unchanged. The draft remains owned by Composer.
