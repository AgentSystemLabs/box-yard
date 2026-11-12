import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { COMMENTS_RATE_FLOOR, PR_COMMENTS_DETAIL_BATCH, PR_COMMENTS_PROBE_BATCH, PrCommentTracker, toActivity, type GqlPrActivity } from "../server/prComments.js"
import { PrDetailsSource } from "../server/prDetails.js"
import { PrTracker, type TokenHealth } from "../server/prs.js"
import { PR_COMMENT_MINUTES, countNewComments, prCommentsLabel, prCommentsText, prViewKey } from "../shared/prComments.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

const T0 = Date.parse("2026-11-01T00:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const by = (login: string | null) => (login ? { login } : null)
const comment = (minutes: number, login: string | null = "reviewer") => ({ createdAt: at(minutes), author: by(login) })
const thread = (isResolved: boolean, ...comments: ReturnType<typeof comment>[]) => ({ isResolved, comments: { nodes: comments } })

/** A PR on the fake GitHub: what its comments query answers. `updatedAt` moves when anything is added. */
interface FakePr extends GqlPrActivity {
  state: "OPEN" | "CLOSED" | "MERGED"
}
const openPr = (extra: Partial<FakePr> = {}): FakePr => ({ state: "OPEN", updatedAt: at(0), author: by("agent"), comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...extra })

/** A fake GitHub GraphQL endpoint: PRs by "owner/name#number", and what each request asked for (a probe or the comments). */
function fakeGithub() {
  const prs = new Map<string, FakePr>()
  const calls: { token: string; kind: "probe" | "comments"; asked: string[] }[] = []
  let remaining = 4000
  let fail: (() => Response) | null = null
  const fetch = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string | number> }
    const n = Object.keys(variables).filter((k) => k.startsWith("p")).length
    const asked = Array.from({ length: n }, (_, i) => `${variables[`o${i}`]}/${variables[`n${i}`]}#${variables[`p${i}`]}`)
    const kind = query.includes("reviewThreads") ? ("comments" as const) : ("probe" as const)
    calls.push({ token: String((init.headers as Record<string, string>).Authorization).replace("Bearer ", ""), kind, asked })
    if (fail) return fail()
    const cost = kind === "probe" ? 1 : Math.max(1, Math.round((n * 53) / 100))
    remaining -= cost
    const data: Record<string, unknown> = { rateLimit: { cost, remaining, resetAt: new Date(T0 + 60 * 60_000).toISOString() }, viewer: { login: "agent" } }
    asked.forEach((key, i) => {
      const pr = prs.get(key)
      data[`p${i}`] = pr ? { pullRequest: kind === "probe" ? { state: pr.state, updatedAt: pr.updatedAt } : pr } : null
    })
    return new Response(JSON.stringify({ data }), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { prs, calls, fetch, setRemaining: (n: number) => (remaining = n), failWith: (res: (() => Response) | null) => (fail = res) }
}

function setup(opts: { minutes?: number; token?: (projectId: string) => string | null } = {}) {
  const store = new Store(openDb(tmpDir()))
  const gh = fakeGithub()
  const project = store.createProject({ name: "site" })
  let now = T0 + 30 * 60_000
  let minutes = opts.minutes ?? PR_COMMENT_MINUTES.default
  const counted: string[] = []
  const logs: string[] = []
  const shared = new Map<string, TokenHealth>()
  const health = (token: string) => shared.get(token) ?? shared.set(token, { failures: 0, retryAt: 0, pausedUntil: 0 }).get(token)!
  const tracker = new PrCommentTracker({
    store,
    fetch: gh.fetch,
    token: opts.token ?? (() => "tok"),
    health,
    intervalMs: () => minutes * 60_000,
    onCount: (id) => counted.push(id),
    now: () => now,
    log: (m) => logs.push(m),
  })
  const task = (n: number, repo = "acme/site", projectId = project.id) => {
    const t = store.createTask({ projectId, title: `Task ${n}`, prompt: "p" })
    store.updateTask(t.id, { status: "pr_ready", prUrl: `https://github.com/${repo}/pull/${n}`, prState: "open" }, { quiet: true })
    return t.id
  }
  const count = (id: string) => store.getTask(id)!.prNewComments
  return { store, gh, tracker, task, count, counted, logs, health, project, tick: (ms: number) => (now += ms), now: () => now, setMinutes: (m: number) => (minutes = m) }
}

describe("what counts as a new PR comment", () => {
  it("counts conversation comments, reviews with a summary and comments in unresolved threads", () => {
    const activity = toActivity({
      updatedAt: at(9),
      author: by("agent"),
      comments: { nodes: [comment(1), comment(2, "maintainer"), null] },
      reviews: {
        nodes: [
          { state: "CHANGES_REQUESTED", submittedAt: at(3), body: "Please split this.", author: by("reviewer") },
          // Only its inline comments: they're in the threads.
          { state: "COMMENTED", submittedAt: at(4), body: "  ", author: by("reviewer") },
          // Still being written: nobody else sees it.
          { state: "PENDING", submittedAt: null, body: "draft", author: by("reviewer") },
        ],
      },
      reviewThreads: { nodes: [thread(false, comment(5), comment(6)), thread(true, comment(7), comment(8))] },
    })
    expect(activity).toMatchObject({ updatedAt: at(9), author: "agent" })
    expect(activity.remarks.map((r) => (r.at - T0) / 60_000)).toEqual([1, 2, 3, 5, 6])
    expect(countNewComments(activity.remarks, null, [])).toBe(5)
  })

  it("counts only what was written after the last view, by someone else", () => {
    const remarks = [
      { at: 10, author: "reviewer" },
      { at: 20, author: "Agent" },
      { at: 30, author: "cody" },
      { at: 40, author: "reviewer" },
      { at: 50, author: null },
    ]
    // Never viewed: all of them but the PR author's and the token account's own, whatever the case of the login.
    expect(countNewComments(remarks, null, ["agent", "CODY", null])).toBe(3)
    expect(countNewComments(remarks, 10, ["agent", "cody"])).toBe(2)
    expect(countNewComments(remarks, 40, ["agent"])).toBe(1)
    expect(countNewComments(remarks, 50, [])).toBe(0)
  })

  it("names a PR the same however its link is written", () => {
    expect(prViewKey("https://github.com/Acme/Site/pull/12")).toBe("acme/site#12")
    expect(prViewKey("https://github.com/acme/site/pull/12/files#diff-1")).toBe("acme/site#12")
    expect(prViewKey("https://github.com/acme/site/pull/12#issuecomment-9")).toBe("acme/site#12")
    expect(prViewKey("https://github.com/acme/site/issues/12")).toBe("acme/site#12")
    expect(prViewKey("https://github.com/acme/site/pull/12abc")).toBeNull()
    expect(prViewKey("https://example.com/acme/site/pull/12")).toBeNull()
    expect(prViewKey(null)).toBeNull()
  })

  it("words the badge", () => {
    expect(prCommentsText(5)).toBe("5")
    expect(prCommentsText(120)).toBe("99+")
    expect(prCommentsLabel(1)).toBe("1 new comment since you last opened this PR")
    expect(prCommentsLabel(5)).toBe("5 new comments since you last opened this PR")
    expect(prCommentsLabel(2, false)).toBe("2 comments to read: you haven't opened this PR from Box Yard yet")
  })
})

describe("PR views in the store", () => {
  it("keeps the latest view per PR", () => {
    const { store } = setup()
    expect(store.prViewedAt("acme/site#1")).toBeNull()
    store.recordPrView("acme/site#1", 2000)
    store.recordPrView("acme/site#1", 1000)
    store.recordPrView("acme/site#2", 500)
    expect(store.prViewedAt("acme/site#1")).toBe(2000)
    expect(store.prViewedAt("acme/site#2")).toBe(500)
  })

  it("a task's count is its PR's: another PR starts uncounted", () => {
    const { store, task } = setup()
    const id = task(1)
    store.updateTask(id, { prNewComments: 4 }, { quiet: true })
    store.updateTask(id, { prUrl: "https://github.com/acme/site/pull/1" }, { quiet: true })
    expect(store.getTask(id)!.prNewComments).toBe(4)
    store.updateTask(id, { prUrl: "https://github.com/acme/site/pull/2" }, { quiet: true })
    expect(store.getTask(id)!.prNewComments).toBeNull()
  })
})

describe("the background round", () => {
  it("probes every open PR in one query, then reads the comments of those that moved", async () => {
    const { gh, tracker, task, count, counted, store } = setup()
    const a = task(1)
    const b = task(2)
    const merged = task(3)
    store.updateTask(merged, { prState: "merged" }, { quiet: true })
    gh.prs.set("acme/site#1", openPr({ comments: { nodes: [comment(1), comment(2), comment(3, "agent")] } }))
    gh.prs.set("acme/site#2", openPr())
    await tracker.pollAll()
    // Merged and closed PRs are never asked about.
    expect(gh.calls).toEqual([
      { token: "tok", kind: "probe", asked: ["acme/site#1", "acme/site#2"] },
      { token: "tok", kind: "comments", asked: ["acme/site#1", "acme/site#2"] },
    ])
    expect([count(a), count(b), count(merged)]).toEqual([2, 0, null])
    expect(counted.sort()).toEqual([a, b].sort())

    // Nothing moved on #2, so only #1 (its count isn't 0: a thread may have been resolved) is read again.
    await tracker.pollAll()
    expect(gh.calls.slice(2)).toEqual([
      { token: "tok", kind: "probe", asked: ["acme/site#1", "acme/site#2"] },
      { token: "tok", kind: "comments", asked: ["acme/site#1"] },
    ])

    // A new comment moves #2's updatedAt.
    gh.prs.set("acme/site#2", openPr({ updatedAt: at(40), comments: { nodes: [comment(40)] } }))
    await tracker.pollAll()
    expect(gh.calls.at(-1)).toEqual({ token: "tok", kind: "comments", asked: ["acme/site#1", "acme/site#2"] })
    expect(count(b)).toBe(1)
    expect(tracker.requests).toBe(6)
    expect(tracker.points).toBe(6)
  })

  it("costs one probe and nothing else while no PR changes", async () => {
    const { gh, tracker, task } = setup()
    for (let n = 1; n <= 30; n++) {
      task(n)
      gh.prs.set(`acme/site#${n}`, openPr())
    }
    await tracker.pollAll()
    expect(gh.calls.map((c) => [c.kind, c.asked.length])).toEqual([["probe", 30], ["comments", PR_COMMENTS_DETAIL_BATCH], ["comments", 10]])
    gh.calls.length = 0
    for (let i = 0; i < 5; i++) await tracker.pollAll()
    expect(gh.calls.map((c) => [c.kind, c.asked.length])).toEqual(Array(5).fill(["probe", 30]))
  })

  it("batches the probe, and asks about a PR once however many tasks have it", async () => {
    const { gh, tracker, task, count } = setup()
    const ids = Array.from({ length: PR_COMMENTS_PROBE_BATCH + 5 }, (_, i) => task(i + 1))
    const twin = task(1)
    for (let n = 1; n <= PR_COMMENTS_PROBE_BATCH + 5; n++) gh.prs.set(`acme/site#${n}`, openPr({ comments: { nodes: n === 1 ? [comment(1)] : [] } }))
    await tracker.pollAll()
    const probes = gh.calls.filter((c) => c.kind === "probe")
    expect(probes.map((c) => c.asked.length)).toEqual([PR_COMMENTS_PROBE_BATCH, 5])
    expect(gh.calls.filter((c) => c.kind === "comments").flatMap((c) => c.asked).filter((k) => k === "acme/site#1")).toHaveLength(1)
    expect([count(ids[0]!), count(twin), count(ids[1]!)]).toEqual([1, 1, 0])
  })

  it("lowers the count when a thread is resolved, though the PR's updatedAt didn't move", async () => {
    const { gh, tracker, task, count } = setup()
    const id = task(1)
    gh.prs.set("acme/site#1", openPr({ reviewThreads: { nodes: [thread(false, comment(1), comment(2)), thread(false, comment(3))] } }))
    await tracker.pollAll()
    expect(count(id)).toBe(3)
    gh.prs.set("acme/site#1", openPr({ reviewThreads: { nodes: [thread(true, comment(1), comment(2)), thread(false, comment(3))] } }))
    await tracker.pollAll()
    expect(count(id)).toBe(1)
  })

  it("asks each project's PRs with its own token, and leaves a project without one alone", async () => {
    const s = setup()
    const other = s.store.createProject({ name: "other" })
    const bare = s.store.createProject({ name: "bare" })
    const token = (id: string) => (id === bare.id ? null : `tok-${id}`)
    const tracker = new PrCommentTracker({ store: s.store, fetch: s.gh.fetch, token, intervalMs: () => 60_000, now: s.now })
    s.task(1)
    s.task(2, "acme/other", other.id)
    s.task(3, "acme/bare", bare.id)
    for (const key of ["acme/site#1", "acme/other#2", "acme/bare#3"]) s.gh.prs.set(key, openPr())
    await tracker.pollAll()
    expect(s.gh.calls.map((c) => [c.token, c.kind, c.asked])).toEqual([
      [`tok-${s.project.id}`, "probe", ["acme/site#1"]],
      [`tok-${s.project.id}`, "comments", ["acme/site#1"]],
      [`tok-${other.id}`, "probe", ["acme/other#2"]],
      [`tok-${other.id}`, "comments", ["acme/other#2"]],
    ])
  })
})

describe("backing off", () => {
  it("rests until the budget resets once it runs low, and leaves PrTracker's own pause alone", async () => {
    const { gh, tracker, task, count, health, logs, tick } = setup()
    const id = task(1)
    task(2)
    gh.prs.set("acme/site#1", openPr({ comments: { nodes: [comment(1)] } }))
    gh.prs.set("acme/site#2", openPr())
    gh.setRemaining(COMMENTS_RATE_FLOOR)
    await tracker.pollAll()
    // The probe's answer said the budget is under the floor: the comments aren't read this hour.
    expect(gh.calls.map((c) => c.kind)).toEqual(["probe"])
    expect(count(id)).toBeNull()
    expect(tracker.tokenHealth("tok").pausedUntil).toBe(T0 + 60 * 60_000)
    expect(health("tok").pausedUntil).toBe(0)
    expect(logs.join("\n")).toMatch(/paused for one token until .*999 GitHub points left/)
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(1)

    // Past the reset, with a full budget again.
    gh.setRemaining(5000)
    tick(31 * 60_000)
    await tracker.pollAll()
    expect(gh.calls.slice(1).map((c) => c.kind)).toEqual(["probe", "comments"])
    expect(count(id)).toBe(1)
  })

  it("stops for as long as GitHub says, for PrTracker's requests with that token too", async () => {
    const { gh, tracker, task, health, now, tick } = setup()
    task(1)
    gh.prs.set("acme/site#1", openPr())
    gh.failWith(() => new Response("{}", { status: 403, headers: { "retry-after": "120" } }))
    await tracker.pollAll()
    expect(health("tok").pausedUntil).toBe(now() + 120_000)
    expect(tracker.tokenHealth("tok").pausedUntil).toBe(now() + 120_000)
    gh.failWith(null)
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(1)
    tick(121_000)
    await tracker.pollAll()
    expect(gh.calls.length).toBeGreaterThan(1)
  })

  it("honours a pause PrTracker set", async () => {
    const { gh, tracker, task, health, now } = setup()
    task(1)
    gh.prs.set("acme/site#1", openPr())
    health("tok").pausedUntil = now() + 60_000
    await tracker.pollAll()
    expect(gh.calls).toEqual([])
  })

  it("backs off exponentially after errors, and one token's errors don't hold back another's", async () => {
    const s = setup()
    const other = s.store.createProject({ name: "other" })
    s.task(1)
    s.task(2, "acme/other", other.id)
    s.gh.prs.set("acme/other#2", openPr())
    const real = s.gh.fetch
    const flaky = (async (url: string, init: RequestInit) =>
      String((init.headers as Record<string, string>).Authorization) === "Bearer bad" && broken ? new Response("{}", { status: 502 }) : real(url, init)) as unknown as typeof fetch
    let broken = true
    const t = new PrCommentTracker({ store: s.store, fetch: flaky, token: (id) => (id === other.id ? "good" : "bad"), intervalMs: () => 5 * 60_000, now: s.now, log: (m) => s.logs.push(m) })
    await t.pollAll()
    expect(t.tokenHealth("bad")).toMatchObject({ failures: 1, retryAt: s.now() + 10 * 60_000 })
    expect(t.tokenHealth("good").failures).toBe(0)
    expect(s.store.listTasks().find((x) => x.title === "Task 2")!.prNewComments).toBe(0)
    expect(s.logs.filter((l) => /backing off/.test(l))).toHaveLength(1)
    // The next scheduled rounds skip the failing token until its retry time.
    const before = t.requests
    s.tick(5 * 60_000)
    await t.pollAll()
    expect(t.requests - before).toBe(1) // the good token's probe only
    s.tick(5 * 60_000)
    await t.pollAll()
    expect(t.tokenHealth("bad")).toMatchObject({ failures: 2, retryAt: s.now() + 15 * 60_000 })
    broken = false
    s.gh.prs.set("acme/site#1", openPr())
    s.tick(15 * 60_000)
    await t.pollAll()
    expect(t.tokenHealth("bad")).toMatchObject({ failures: 0, retryAt: 0 })
    expect(s.logs.at(-1)).toMatch(/working again/)
  })
})

describe("viewing a PR", () => {
  it("zeroes the count at once without asking GitHub, and later counts only what came after", async () => {
    const { gh, tracker, task, count, counted, store, now, tick } = setup()
    const id = task(1)
    const twin = task(1)
    gh.prs.set("acme/site#1", openPr({ comments: { nodes: [comment(1), comment(2)] } }))
    await tracker.pollAll()
    expect([count(id), count(twin)]).toEqual([2, 2])
    const asked = gh.calls.length
    counted.length = 0

    expect(tracker.viewed("https://github.com/acme/site/pull/1/files")).toBe(now())
    expect(gh.calls).toHaveLength(asked)
    expect([count(id), count(twin)]).toEqual([0, 0])
    expect(counted.sort()).toEqual([id, twin].sort())
    expect(store.prViewedAt("acme/site#1")).toBe(now())

    // The old comments stay read; one written after the view counts.
    tick(5 * 60_000)
    await tracker.pollAll()
    expect(gh.calls.slice(asked).map((c) => c.kind)).toEqual(["probe"])
    const after = (now() - T0) / 60_000 - 1
    gh.prs.set("acme/site#1", openPr({ updatedAt: at(after), comments: { nodes: [comment(1), comment(2), comment(after)] } }))
    await tracker.pollAll()
    expect([count(id), count(twin)]).toEqual([1, 1])
  })

  it("records a view by any link to the PR, and ignores links that aren't one", () => {
    const { tracker, task, store, now } = setup()
    task(7)
    // "#7" in text links to /issues/7, which is this task's PR.
    expect(tracker.viewed("https://github.com/acme/site/issues/7")).toBe(now())
    expect(store.prViewedAt("acme/site#7")).toBe(now())
    // A PR no task has is remembered too (a link in a message); an issue isn't a PR.
    expect(tracker.viewed("https://github.com/acme/site/pull/99")).toBe(now())
    expect(tracker.viewed("https://github.com/acme/site/issues/98")).toBeNull()
    expect(tracker.viewed("https://example.com/")).toBeNull()
    expect(store.prViewedAt("acme/site#98")).toBeNull()
  })

  it("counts from a view recorded while GitHub was still answering", async () => {
    const { gh, tracker, task, count } = setup()
    const id = task(1)
    gh.prs.set("acme/site#1", openPr({ comments: { nodes: [comment(1), comment(2)] } }))
    const round = tracker.pollAll()
    tracker.viewed("https://github.com/acme/site/pull/1")
    await round
    expect(count(id)).toBe(0)
  })
})

describe("Settings › New PR comments", () => {
  it("off asks nothing and forgets the counts; on again asks", async () => {
    const { gh, tracker, task, count, counted, setMinutes } = setup()
    const id = task(1)
    gh.prs.set("acme/site#1", openPr({ comments: { nodes: [comment(1)] } }))
    tracker.start()
    await tracker.pollAll()
    expect(count(id)).toBe(1)
    counted.length = 0

    setMinutes(0)
    tracker.reschedule()
    expect(count(id)).toBeNull()
    expect(counted).toEqual([id])
    const asked = gh.calls.length
    await tracker.pollAll()
    expect(gh.calls).toHaveLength(asked)
    expect(tracker.ingest("https://github.com/acme/site/pull/1", toActivity(openPr({ comments: { nodes: [comment(1)] } })), "agent")).toBeNull()
    expect(count(id)).toBeNull()

    setMinutes(1)
    tracker.reschedule()
    await tracker.pollAll()
    expect(count(id)).toBe(1)
    tracker.stop()
  })

  it("is one of the listed intervals, 5 minutes unless saved", async () => {
    const port = await freePort()
    const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } } })
    try {
      expect(yard.settings.get().prCommentMinutes).toBe(5)
      expect(yard.settings.update({ prCommentMinutes: 0 }).settings.prCommentMinutes).toBe(0)
      expect(() => yard.settings.update({ prCommentMinutes: 7 })).toThrow(/Pick one of/)
    } finally {
      yard.stop()
    }
  })
})

describe("the task page's PR sheet", () => {
  const url = "https://github.com/acme/site/pull/1"
  const details = { number: 1, title: "Retry", url, state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "retry" }

  it("reads the comments in its own query and saves the count like a round would", async () => {
    const { store, tracker, task, count, now } = setup()
    const id = task(1)
    const queries: string[] = []
    const fetch = (async (_u: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query)
      return new Response(JSON.stringify({ data: { viewer: { login: "agent" }, repository: { pullRequest: { ...details, ...openPr({ comments: { nodes: [comment(1), comment(2), comment(3, "agent")] } }) } } } }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    let on = true
    const source = new PrDetailsSource({ store, fetch, token: () => "tok", now, comments: { enabled: () => on, ingest: (u, a, v) => tracker.ingest(u, a, v) } })
    const answer = await source.get(id)
    expect(queries[0]).toMatch(/viewer \{ login \}.*reviewThreads/s)
    expect(answer.details!.comments).toEqual({ count: 2, viewedAt: null })
    expect(count(id)).toBe(2)

    // With the count off, the sheet asks what it always did.
    on = false
    const off = new PrDetailsSource({ store, fetch, token: () => "tok", now, comments: { enabled: () => on, ingest: (u, a, v) => tracker.ingest(u, a, v) } })
    expect((await off.get(id)).details!.comments).toBeNull()
    expect(queries[1]).not.toMatch(/reviewThreads|viewer/)
  })
})

describe("POST /api/pr-views", () => {
  let yard: BoxYard | undefined
  let server: Server | undefined
  afterEach(async () => {
    yard?.stop()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    yard = server = undefined
  })

  it("records the view, zeroes the PR's tasks and tells the stream", async () => {
    const port = await freePort()
    yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } } })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    const project = yard.store.createProject({ name: "Site" })
    const t = yard.store.createTask({ projectId: project.id, title: "Retry", prompt: "p" })
    yard.store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/4", prState: "open", prNewComments: 5 }, { quiet: true })
    const sent: unknown[] = []
    const broadcast = yard.hub.broadcast.bind(yard.hub)
    yard.hub.broadcast = (event) => {
      sent.push(event)
      broadcast(event)
    }
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/pr-views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

    const before = Date.now()
    const res = await post({ url: "https://github.com/acme/site/pull/4#issuecomment-1" })
    expect(res.status).toBe(200)
    const { viewedAt } = (await res.json()) as { viewedAt: number }
    expect(viewedAt).toBeGreaterThanOrEqual(before)
    expect(yard.store.prViewedAt("acme/site#4")).toBe(viewedAt)
    expect(yard.store.getTask(t.id)!.prNewComments).toBe(0)
    expect(sent).toContainEqual(expect.objectContaining({ type: "task", task: expect.objectContaining({ id: t.id, prNewComments: 0 }) }))

    expect(await (await post({ url: "https://example.com/not-a-pr" })).json()).toEqual({ viewedAt: null })
    expect((await post({})).status).toBe(400)
  })
})

it("PrTracker's batched query still reads PR states through the shared GraphQL helper", async () => {
  const store = new Store(openDb(tmpDir()))
  const project = store.createProject({ name: "site" })
  const t = store.createTask({ projectId: project.id, title: "T", prompt: "p" })
  store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/1" }, { quiet: true })
  const fetch = (async () => new Response(JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: at(60) }, p0: { pullRequest: { state: "OPEN", isDraft: true } } } }), { status: 200 })) as unknown as typeof globalThis.fetch
  const prs = new PrTracker({ store, token: () => "tok", fetch })
  await prs.pollAll()
  expect(store.getTask(t.id)!.prState).toBe("draft")
})
