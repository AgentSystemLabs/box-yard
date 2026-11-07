import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { PR_DETAILS_FRESH_MS, PrDetailsSource, checkState, mergeState, toDetails, type GqlPrDetails } from "../server/prDetails.js"
import type { PrInfo } from "../server/prs.js"
import { tmpDir } from "./helpers.js"

const url = "https://github.com/acme/site/pull/76"

const pr = (extra: Partial<GqlPrDetails> = {}): GqlPrDetails => ({
  number: 76,
  title: "Retry webhooks with backoff",
  url,
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  mergedBy: null,
  baseRefName: "main",
  headRefName: "webhook-retry",
  headRefOid: "abc123",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  changedFiles: 8,
  additions: 120,
  deletions: 34,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/test" }] } } } }] },
  ...extra,
})

const rollup = (state: string, nodes: object[]) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes } } } }] })

describe("PR details from GitHub", () => {
  it("reads check runs and commit statuses in four words", () => {
    expect(checkState({ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null })).toBe("pending")
    expect(checkState({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" })).toBe("passed")
    expect(checkState({ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" })).toBe("skipped")
    expect(checkState({ __typename: "CheckRun", status: "COMPLETED", conclusion: "TIMED_OUT" })).toBe("failed")
    expect(checkState({ __typename: "StatusContext", state: "ERROR" })).toBe("failed")
    expect(checkState({ __typename: "StatusContext", state: "EXPECTED" })).toBe("pending")
  })

  it("says whether it would merge: conflicts win over branch rules, and GitHub still working it out is unknown", () => {
    expect(mergeState({ mergeable: "CONFLICTING", mergeStateStatus: "BLOCKED" })).toBe("conflicts")
    expect(mergeState({ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" })).toBe("behind")
    expect(mergeState({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" })).toBe("blocked")
    expect(mergeState({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" })).toBe("clean")
    expect(mergeState({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toBe("unknown")
  })

  it("counts checks, lists failing ones first and keeps only web links", () => {
    const d = toDetails(
      pr({
        commits: rollup("FAILURE", [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/build" },
          { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: "javascript:alert(1)" },
          { __typename: "StatusContext", context: "ci/lint", state: "FAILURE", targetUrl: "https://ci/lint" },
          { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null },
        ]),
        reviewDecision: "CHANGES_REQUESTED",
      }),
      url,
    )!
    expect(d.checks).toMatchObject({ state: "failing", passed: 1, failed: 1, pending: 1, skipped: 1 })
    expect(d.checks.list.map((c) => c.name)).toEqual(["ci/lint", "e2e", "build", "docs"])
    expect(d.checks.list[0]!.url).toBe("https://ci/lint")
    expect(d.checks.list[1]!.url).toBeNull()
    expect(d).toMatchObject({ number: 76, state: "open", base: "main", head: "webhook-retry", merge: "clean", review: "changes_requested", files: { changed: 8, additions: 120, deletions: 34 } })
  })

  it("has no checks when the commit has none, and a merged PR is never 'conflicting'", () => {
    expect(toDetails(pr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }), url)!.checks.state).toBe("none")
    const merged = toDetails(pr({ state: "MERGED", mergedAt: "2026-11-03T10:00:00Z", mergedBy: { login: "cody" }, mergeable: "UNKNOWN" }), url)!
    expect(merged).toMatchObject({ state: "merged", mergedBy: "cody", merge: "clean" })
    expect(toDetails(pr({ isDraft: true }), url)!.state).toBe("draft")
  })
})

function setup(opts: { fetch?: typeof fetch | null; token?: string | null; paused?: number } = {}) {
  const store = new Store(openDb(tmpDir()))
  const project = store.createProject({ name: "site" })
  const t = store.createTask({ projectId: project.id, title: "Retry", prompt: "p" })
  store.updateTask(t.id, { status: "pr_ready", prUrl: url, prState: "open" }, { quiet: true })
  let now = 1_000_000
  const calls: { auth: string; variables: unknown }[] = []
  let answer: () => Response = () => new Response(JSON.stringify({ data: { repository: { pullRequest: pr() } } }), { status: 200 })
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    calls.push({ auth: String((init.headers as Record<string, string>).Authorization), variables: JSON.parse(String(init.body)).variables })
    return answer()
  }) as unknown as typeof fetch
  const applied: PrInfo[] = []
  const source = new PrDetailsSource({
    store,
    fetch: opts.fetch === undefined ? fakeFetch : opts.fetch,
    token: () => (opts.token === undefined ? "tok" : opts.token),
    pausedUntil: () => opts.paused ?? 0,
    apply: (_id, _url, info) => applied.push(info),
    now: () => now,
  })
  return { store, taskId: t.id, source, calls, applied, tick: (ms: number) => (now += ms), answer: (fn: () => Response) => (answer = fn) }
}

describe("PrDetailsSource", () => {
  it("asks GitHub once for every tab within the freshness window, then again", async () => {
    const s = setup()
    const [a, b] = await Promise.all([s.source.get(s.taskId), s.source.get(s.taskId)])
    expect(a.details!.title).toBe("Retry webhooks with backoff")
    expect(b).toBe(a)
    expect(s.calls).toEqual([{ auth: "Bearer tok", variables: { o: "acme", n: "site", p: 76 } }])
    s.tick(PR_DETAILS_FRESH_MS)
    await s.source.get(s.taskId)
    expect(s.calls).toHaveLength(2)
  })

  it("saves the state it read like a poll would, so the header agrees with the sheet", async () => {
    const s = setup()
    s.answer(() => new Response(JSON.stringify({ data: { repository: { pullRequest: pr({ state: "MERGED", mergedAt: "2026-11-03T10:00:00Z", mergedBy: { login: "cody" } }) } } }), { status: 200 }))
    await s.source.get(s.taskId)
    expect(s.applied).toEqual([{ state: "merged", mergedAt: Date.parse("2026-11-03T10:00:00Z"), mergedBy: "cody", headSha: "abc123" }])
  })

  it("says why there are no details, without asking GitHub when it can't", async () => {
    expect((await setup({ fetch: null }).source.get("task_nope00")).error).toBe("Task not found.")
    const mock = setup({ fetch: null })
    expect((await mock.source.get(mock.taskId)).error).toMatch(/mock mode/)
    const noToken = setup({ token: null })
    expect((await noToken.source.get(noToken.taskId)).error).toMatch(/no GitHub token/)
    const paused = setup({ paused: 2_000_000 })
    expect((await paused.source.get(paused.taskId)).error).toMatch(/rate limit/)
    for (const s of [noToken, paused]) expect(s.calls).toEqual([])
    const noPr = setup()
    noPr.store.updateTask(noPr.taskId, { prUrl: null }, { quiet: true })
    expect(await noPr.source.get(noPr.taskId)).toEqual({ details: null, error: "This task has no pull request.", checkedAt: null })
  })

  it("turns GitHub's refusals into words", async () => {
    const s = setup()
    s.answer(() => new Response(JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }), { status: 200 }))
    expect((await s.source.get(s.taskId)).error).toMatch(/can't see the pull request/)
    s.tick(PR_DETAILS_FRESH_MS)
    s.answer(() => new Response("{}", { status: 401 }))
    expect((await s.source.get(s.taskId)).error).toMatch(/refused this project's token/)
    s.tick(PR_DETAILS_FRESH_MS)
    s.answer(() => {
      throw new Error("ECONNRESET")
    })
    expect((await s.source.get(s.taskId)).error).toMatch(/didn't answer: ECONNRESET/)
    expect(s.applied).toEqual([])
  })
})
