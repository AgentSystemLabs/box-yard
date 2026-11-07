# Testing

Iterate with `npm run test:related`, which selects changes against the merge base with `origin/main`, including staged, unstaged and untracked files. Use `npm run test:related -- --base <ref>` for another base. For shared setup/configuration changes, run specific affected files with `npx vitest run <files>` instead of selecting the whole suite.

Commit before the final merge gate and hold HEAD stable. The gate is:

```sh
npm run typecheck
npm run build
npm run test:fast
```

`npm run test:slow` selects integration coverage; `npm test` and `npm run test:full` run everything. Full and slow suites are not merge gates. One daily local schedule runs typecheck, build and `npm test`; there is no separate slow-only schedule. All three suite commands use the existing machine-wide `~/.boxyard/locks/vitest-full` lock, including across checkouts. Lock acquisition prints wait seconds; completion prints execution seconds excluding that wait. Exit codes, Vitest options/reporters and signal forwarding use the same wrapper. Focused and related runs stay unlocked. Do not request suite slots or announce suite completion to other tasks or the Captain.

Fix failures with focused runs. Repeat the final gate only after code changes or unresolved failures require it. A red run stays red: never subtract failures, rerun main for a baseline, or accept teardown/unhandled rejections.

## Tier inventory

`scripts/testTiers.ts` is the single inventory used by `vitest.config.ts`. Full discovery includes `test/**/*.test.ts`; slow includes the listed files and fast excludes exactly those files. New test files default fast. Add a file to the slow inventory when:

- It takes more than about 20 seconds in a locked per-file timing run.
- Its contents exercise end-to-end flows, a real browser, real Git/configuration, archives/bundles, or a full Box Yard server/task manager, even when it runs below 20 seconds.

Read the contents, including helpers, rather than relying on filenames. Happy DOM component tests with mocked fetch are unit tests; they do not launch a real browser. Pure formatting of Git/archive metadata also stays fast. Keep a reason beside every slow entry. A fast run's duration is a measurement, not a reason to move integration coverage into it.

`npm run test:tiers` loads all three actual Vitest configurations and compares discovery without executing tests. It rejects omissions, overlap, duplicates, unexpected tier-only files, wrong routing and stale slow entries. Its regression test runs in the fast tier, including synthetic broken inventories, so routing is part of the merge gate.

## Collect per-file timings

Use the locked wrapper, with the standard Vitest JSON reporter alongside terminal output:

```sh
npm run test:full -- --reporter=default --reporter=json --outputFile.json=full-timing.json
npm run test:fast -- --reporter=default --reporter=json --outputFile.json=fast-timing.json
npm run test:slow -- --reporter=default --reporter=json --outputFile.json=slow-timing.json
```

Record the Git commit, dirty state, machine/OS/CPU/RAM, Node/Vitest versions and exact command. Each JSON `testResults` item contains its file name, test-span `startTime`/`endTime`, assertions and status. **Vitest 5's JSON span can omit beforeAll/afterAll time.** For classification use Vitest's per-file `duration` (tests and hooks), saved in its result cache. Immediately after the run, before another focused/tier run updates the cache, copy `node_modules/.vite/vitest/<project-hash>/results.json` into the timing artifact. Locate it with `rg --files --hidden node_modules/.vite/vitest -g results.json`. Check that its `projects[""].files` covers every discovered file and every `lastRun` belongs to this run; reject mixed/stale records. Keep both the raw JSON and cache snapshot.

Report each file's cached `duration` in milliseconds, with skipped files explicitly marked as skipped rather than timed execution. File durations exclude some startup/import/environment/setup overhead; use wrapper execution time for the gate comparison. Record lock wait separately and do not count it as suite execution.

Reuse a fresh complete report from the same main revision when available. Otherwise collect one complete run. Publish the complete file/time/status/tier/reason list with the raw JSON and metadata. Measure typecheck and build separately. Label projected totals as estimates; a sum of per-file durations is not a measured gate wall time.

## Daily full test suite on this computer

The Captain creates this project schedule **after merge**; do not create it during tiering work. The schedule has its own nullable runner override. MCP `create_schedule`/`update_schedule` take `runs_on`; REST `POST /api/schedules` and `PATCH /api/schedules/:id` take `runsOn`. The persisted SQLite column is `schedules.runs_on`. `"local"` here explicitly means the computer running Box Yard, independent of Settings › Machines › Local means. Omission on create/null follows the project; omission on update preserves the current choice. Coordinator schedules reject runner overrides. Existing schedules and the project's runner remain unchanged. Tasks still go through the existing identity runner restrictions.

Captain setup payload (configuration only, not an instruction to create it now):

```json
{
  "project": "box-yard",
  "name": "Daily full test suite",
  "cron": "0 2 * * *",
  "timezone": "America/New_York",
  "runs_on": "local",
  "catch_up": "skip",
  "allow_overlap": false,
  "prompt": "Run the daily full test suite using Codex on this local runner. Use a clean checkout of the latest main; never touch live port 3000/data or restart/rebuild live Box Yard. Check node_modules exists and install repository dependencies if needed. Run npm run typecheck, npm run build, then the locked npm test -- --reporter=default --reporter=json --outputFile.json=full-results.json. Capture complete logs and commit/machine details, execution time and lock wait separately. Preserve every exit code and report exact failing checks, tests, suites and unhandled/teardown errors; never subtract failures or rerun main for a baseline. On any failed check, publish the available JSON/logs and a report as artifacts, and open a GitHub issue titled Daily full test suite failing: <date> using the scheduled date in America/Chicago. Include the commit, exact command, exit code, exact failures and report URL; avoid a duplicate issue for that date by updating it if already present. Call finish with the failure summary and issue/report URLs. On success, make no commits, PRs, artifacts, previews or questions; call finish with outcome noop and a one-line green summary so the successful run is filed quietly. Do not change project defaults, schedules, live data or Captain notes."
}
```

No special runner deployment or server restart is part of this change. The running server must eventually load the merged capability before the Captain can use its new MCP argument; that operational step belongs to the live service owner.
