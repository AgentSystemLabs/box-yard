# Command palette timing on a big yard

What was slow: every keystroke scanned and lowercased every field of every item (about 8,600 on a yard with 300
projects, 5,000 tasks and 1,000 files), then ranked the same query a second time; every open rebuilt every item; and
"Show all" on a short query put every matching row in the DOM at once.

## Conditions and reproduction

The yard is `scripts/perf/palette-yard.mjs`: deterministic, 300 projects, 5,000 tasks (12 working, 6 queued, the rest
mostly done), 1,000 files. The browser bench serves those lists from Playwright routes, and blocks the event stream and
the page's early `/api/boot` snapshot, so only the palette moves. Headless Chromium, 1600×1000, no CPU throttling,
production Vite builds. Each run prints medians over its samples; run it a few times per side, interleaved.

```sh
npm run build
PORT=4001 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/palette-yard node dist/server/server/index.js &
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/perf/palette-bench.mjs http://localhost:4001 after
# The ranking alone, in Node, with the memory an open keeps:
node --expose-gc --import tsx scripts/perf/palette-rank-bench.mjs
```

Install Playwright outside the repository. Stop the server afterwards; don't point the bench at a live yard.

- **open**: Ctrl+K to the frame after the first result row is in the DOM; the first open and ten reopens.
- **openWork**: main-thread time (CDP `TaskDuration`) in the 500 ms after Ctrl+K, fifteen times. Frames in headless
  Chromium come about 65 ms apart behind the modal's backdrop blur, so **open** barely moves; this shows the work.
- **typing**: six queries typed a key at a time with 400 ms between keys; each key to the frame that shows its results.
- **burst**: the same queries at 25 ms a key, from the first key to the frame with the final results.
- **Show all**: "Show all" on the Tasks group for the query `e`, to the next frame; then the rows and elements in the page.
- **firstKey**: reload, open, and type `e`: the first search, when no row has been indexed yet. Ten reloads.

## Results

AWS Graviton4 (Neoverse V2, aarch64, 64 vCPUs), 2026-11-04. Before is `main` at `66eac2b`, after is this change; each
figure is the median of three interleaved runs' medians.

| Metric | Before | After |
|---|---|---|
| Keystroke → its results on screen, median / p95 | 27.1 / 69.5 ms | 15.7 / 59.3 ms |
| First keystroke after a reload → its results | 78.0 ms | 57.7 ms |
| Main-thread work per keystroke | 32.0 ms | 17.7 ms |
| Burst, first key → final results | 524 ms | 479 ms |
| "Show all" → next frame | 1,206 ms | 26.7 ms |
| Option rows / page elements after "Show all" | 5,017 / 92,463 | 50 / 18,126 |
| Main-thread work per open | 36.4 ms | 26.5 ms |
| Ctrl+K → first rows, first open / reopen median | 100.8 / 93.2 ms | 106.1 / 90.9 ms |
| Node: ranking per keystroke, median / worst | 8.9 / 18.5 ms | 7.5 / 13.2 ms |
| Node: building the list on reopen | 5.5 ms | 1.9 ms |
| Node: heap one open holds / keeps after closing | 4.6 / < 0.1 MB | 14.1 / 13.9 MB |

The search index stays while its rows do: building it from scratch costs about 20 ms in Node, so the palette builds it
once, after its first paint, and reuses it on later opens. The price is the memory in the last row, and a first open after
a reload that measures about 5 ms later: the probe waits for the frame after the one that shows the rows, and the index
build runs between them.
