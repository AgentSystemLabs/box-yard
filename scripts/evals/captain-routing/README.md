# Captain routing eval

Does a project's Captain still route well at a lower effort? This eval sends a Captain the same messages at different
`--effort` levels and grades what it does: whether it creates a task or messages an existing one, fans out in one call,
answers code and status questions itself, carries the owner's constraints into the agent's prompt, passes runner and
model options only when asked, stays in its project, and leaves closing and merging to the owner.

## How it works

- **`seed.ts`**: the state every case starts from. It has a small storefront repo (`acme/storefront`, served from a
  local bare repo) and nine tasks in every state: working, idle, PR ready, done, waiting on a question, failed, plus a
  PR whose Merge PR request is under way. It also has three notes and a second project (`acme/marketing-site`) the
  Captain must not touch.
- **`fixtures.ts`**: 49 cases in 14 categories. Each case has a message (or a notes-retro wake-up) and what a good
  Captain does, written as checks on its tool calls, the tasks it created, the messages it sent and its reply. Each
  case's `why` names the rule it tests.
- **`run.ts`**: starts a scratch Box Yard. That means its own data folder under the temp dir, its own port, an empty
  `GH_CONFIG_DIR`, a fake GitHub and `BOXYARD_MOCK=1`. It never touches a live server or `~/.boxyard`. Only the Captain
  runs the real `claude` CLI; task agents are `scripts/fake-claude.mjs`, so a case costs only the Captain's turn.

  Before each case the runner puts the project back as seeded and starts a fresh Captain session. Then it posts the
  message, waits for the turn to end and grades it. It appends one JSON line per run to `results/<effort>.jsonl`. When
  it's done it stops every agent and removes the Captain's session folders from `~/.claude/projects`.
- **`grade.ts`**: the deterministic grader (pure; `test/captain-routing-eval.test.ts` covers it).
- **`judge.ts`**: an LLM judge (Sonnet, no tools) that checks prompt quality on the cases with a rubric: does the
  created task's prompt keep each of the owner's requirements? `handcheck.json` holds hand verdicts on a sample, and
  the report shows how often the judge agrees with them.
- **`report.ts`**: builds `results/report.md`, `results/report.html` and `results/summary.json`. It regrades every run
  with the current grader, so a grader fix applies to runs already done.

## Running it

It spends money on this computer's own `claude` login: about $0.05 to $0.10 per case on Opus 5.5. Without `--real`
it only says what it would do.

```sh
# A free check of the plumbing: fake-claude as the Captain too.
npx tsx scripts/evals/captain-routing/run.ts --fake-captain --reps 1 --cases create-footer-year,notes-retro

# One effort level: 49 cases x 3 reps. Run levels in parallel on different ports; --total-budget caps them together.
npx tsx scripts/evals/captain-routing/run.ts --real --effort low --reps 3 --port 4704 --total-budget 37 \
  --out scripts/evals/captain-routing/results/low.jsonl

# Then judge the rubric cases and build the report.
npx tsx scripts/evals/captain-routing/judge.ts scripts/evals/captain-routing/results/*.jsonl
npx tsx scripts/evals/captain-routing/report.ts
```

Other options: `--cases id,id`, `--category fan-out`, `--model`, `--budget` (this run's own cap), `--keep` (keep
the scratch data folder) and `--label pruned-low` (a variant that differs by more than effort, such as a changed system
prompt: the report groups runs by label, or else by effort, and `report.ts --reference low` picks the group the paired
differences compare against). Ctrl-C finishes the case under way, then stops every agent and cleans up. Killing the
process outright would leave the fake agents running.

`results/` is git-ignored: the runs hold whole transcripts.

## Adding a case

Add it to `CASES` in `fixtures.ts`, using the seeded tasks' aliases (`csv`, `tax`, `webp`, `settings`, `flaky`,
`node22`, `dark`, `sentry`, `search`). Make sure the repo in `seed.ts` has whatever the message talks about. A
careful Captain checks the code, and if it finds nothing it asks instead of acting.

Try the new case with `--fake-captain`, then run it once for real. Read the failure in the report before trusting the
case: a failure can be a grader that's too strict, not a Captain mistake.
