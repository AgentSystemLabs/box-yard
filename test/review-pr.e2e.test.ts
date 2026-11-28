import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A task that reviews a PR (Task.reviewPrUrl) shows it and follows its state, and never takes it as its own: not from
// the runner's `gh pr create` report, not from the lookup by branch after the reviewer checked its branch out, not for
// Merge PR, pr_ready or Done when its PR merges, and Box Yard never pushes its branch. A real worker turn (fake-claude
// on a local box) against a bare origin at <tmp>/github.com/acme/site.git, which Box Yard reads as acme/site, with the
// PR under review on its `picker` branch, and a fake GitHub API (GraphQL by branch d<i> and by number p<i>). Nothing
// here talks to the real GitHub.

interface FakePr {
  number: number
  branch: string
  state: "OPEN" | "MERGED"
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  gh: { prs: FakePr[]; branchLookups: string[] }
  bare: string
  dataDir: string
}
const running: Running[] = []
const closers: (() => Promise<void>)[] = []

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", env }).toString().trim()

/**
 * A bare origin with main and the reviewed PR's branch `picker`, at a path that reads as github.com/acme/site. Mock
 * mode never pushes to a GitHub repo, so `github: false` puts it at a plain path, for the turn-end push.
 */
function origin(github = true) {
  const root = tmpDir("review-pr-origin-")
  const bare = github ? path.join(root, "github.com", "acme", "site.git") : path.join(root, "origins", "site.git")
  const seed = path.join(root, "seed")
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  git(seed, "checkout", "-qb", "picker")
  fs.writeFileSync(path.join(seed, "picker.txt"), "the author's change\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "Pick Latest")
  git(seed, "push", "-q", bare, "picker")
  return bare
}

function fakeGithub(): { gh: Running["gh"]; fetch: typeof globalThis.fetch } {
  const gh: Running["gh"] = { prs: [], branchLookups: [] }
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
  const fetch = (async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/graphql")) return json([])
    const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, string | number> }
    const node = (pr: FakePr) => ({
      url: `https://github.com/acme/site/pull/${pr.number}`,
      state: pr.state,
      isDraft: false,
      createdAt: new Date().toISOString(),
      mergedAt: pr.state === "MERGED" ? new Date().toISOString() : null,
      mergedBy: pr.state === "MERGED" ? { login: "cody" } : null,
      headRefName: pr.branch,
      headRefOid: "c0ffee".padEnd(40, "0"),
      headRepository: { nameWithOwner: "acme/site" },
      labels: { nodes: [] },
    })
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
    for (const [k, v] of Object.entries(variables)) {
      const byBranch = /^b(\d+)$/.exec(k)
      if (byBranch) {
        gh.branchLookups.push(String(v))
        data[`d${byBranch[1]}`] = { nameWithOwner: "acme/site", pullRequests: { nodes: gh.prs.filter((p) => p.branch === v).map(node) }, parent: null }
      }
      const byNumber = /^p(\d+)$/.exec(k)
      if (byNumber) {
        const pr = gh.prs.find((p) => p.number === Number(v))
        data[`p${byNumber[1]}`] = pr ? { pullRequest: node(pr) } : null
      }
    }
    return json({ data })
  }) as unknown as typeof globalThis.fetch
  return { gh, fetch }
}

async function start(): Promise<Running> {
  const port = await freePort()
  const { gh, fetch } = fakeGithub()
  const provider = new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE)
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider, github: { fetch, token: () => "test-token" } })
  // Captains would wake on the notices and start turns of their own; these tests are about the task.
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh, bare: "", dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {})
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function raw(r: Running, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(r.base + urlPath, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as unknown }
}
async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const { status, data } = await raw(r, method, urlPath, body)
  if (status >= 400) throw new Error(`${method} ${urlPath} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

async function repoProject(r: Running, github = true) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "site" })
  r.bare = origin(github)
  // The API only takes GitHub repos; point the project at the local origin, whose path still reads as acme/site.
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(`file://${r.bare}`, p.id)
  return p
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const resting = (r: Running, id: string, statuses: string[], turns = 1) =>
  waitFor(
    async () => {
      const t = await getTask(r, id)
      return statuses.includes(t.status) && t.turnCount >= turns && !t.pendingCount && !r.yard.store.getTaskRow(id)?.current_turn_id ? t : null
    },
    `task ${id} to rest in ${statuses.join("/")} after turn ${turns}`,
    30_000,
  )
/** The task's turn-end push after `since` is done. */
const pushed = (r: Running, id: string, since: number) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return (t.pushState?.at ?? 0) > since ? t : null
  }, `task ${id}'s turn-end push`)
/** The reviewed PR's state, once the poll has asked about it. */
const reviewState = (r: Running, id: string, state: string) =>
  waitFor(async () => ((await getTask(r, id)).reviewPrState === state ? true : null), `task ${id}'s reviewed PR to be ${state}`)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const prNotices = (r: Running) =>
  r.yard.store
    .listChat(500)
    .filter((m) => m.role === "notice" && m.content.startsWith("🔀"))
    .map((m) => m.content)
const originTip = (r: Running, branch: string) => git(r.bare, "rev-parse", `refs/heads/${branch}`)

/** An MCP client as the Coordinator. */
async function coordinator(r: Running) {
  const deps = {
    store: r.yard.store,
    tasks: r.yard.tasks,
    hub: r.yard.hub,
    artifacts: null as never,
    publicUrl: () => "",
    scheduler: r.yard.scheduler,
    captains: r.yard.captains,
    settings: r.yard.settings,
    hooks: r.yard.hooks,
    uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024),
  }
  const mcp = buildMcpServer(deps, { kind: "coordinator" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  closers.push(async () => (await client.close(), await mcp.close()))
  return async <T,>(name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (res.isError) throw new Error(res.content[0]!.text)
    return JSON.parse(res.content[0]!.text) as T
  }
}

describe("a task that reviews a PR", () => {
  it("shows the PR it reviews and follows its state, but never takes it as its own PR", async () => {
    const r = await start()
    const p = await repoProject(r)
    r.gh.prs.push({ number: 7, branch: "picker", state: "OPEN" })
    const picker = originTip(r, "picker")

    // The reviewer checks the PR's branch out and commits a note on it, then runs `gh pr create`, which says the
    // branch already has PR #7.
    const created = await call<Task>(r, "POST", "/api/tasks", {
      projectId: p.id,
      title: "Review PR #7 (Pick Latest) and leave a verdict comment",
      prompt: "Check out its branch and test it. [checkout:picker] [gh-pr-exists:acme/site#7]",
    })
    expect(created).toMatchObject({ reviewPrUrl: "https://github.com/acme/site/pull/7", prUrl: null })
    await resting(r, created.id, ["idle"])
    await reviewState(r, created.id, "open")
    const t = await getTask(r, created.id)
    expect(t).toMatchObject({ prUrl: null, prState: null, reviewPrUrl: "https://github.com/acme/site/pull/7", reviewPrState: "open" })
    expect(r.yard.store.getTaskRow(t.id)!.review_pr_head).toBe("picker")
    expect(events(r, t.id)).toContain("Didn't take https://github.com/acme/site/pull/7 as this task's own pull request: it's the PR this task reviews.")
    expect(prNotices(r)).toEqual([])
    // Box Yard never pushed the reviewer's commit to the PR's branch.
    expect(originTip(r, "picker")).toBe(picker)

    // The scheduled lookup by branch skips the PR's head branch: still no PR of its own.
    await r.yard.tasks.prs.discover()
    expect(r.gh.branchLookups).not.toContain("picker")
    expect((await getTask(r, t.id)).prUrl).toBeNull()

    // No Merge PR for it.
    const merge = await raw(r, "POST", `/api/tasks/${t.id}/merge`)
    expect(merge.status).toBe(400)
    expect(r.yard.store.getTaskRow(t.id)!.merge_request_json).toBeNull()

    // The Coordinator sees it as the PR the task reviews, not its PR.
    const mcp = await coordinator(r)
    const brief = await mcp<{ status: string; pr?: string; reviewsPr?: string; reviewsPrState?: string }>("get_task", { task: t.id })
    expect(brief).toMatchObject({ status: "idle", reviewsPr: "https://github.com/acme/site/pull/7", reviewsPrState: "open" })
    expect(brief.pr).toBeUndefined()

    // It merges: the task shows it, and nothing else happens (no done, no notification).
    r.gh.prs[0]!.state = "MERGED"
    await r.yard.tasks.prs.pollAll()
    expect(await getTask(r, t.id)).toMatchObject({ status: "idle", reviewPrState: "merged", prUrl: null })
    expect(r.yard.store.listNotifications().filter((n) => n.taskId === t.id && /merged/i.test(n.summary ?? ""))).toEqual([])
  }, 60_000)

  it("push at turn end never pushes the reviewed PR's branch, even when it's the task's own branch name", async () => {
    const r = await start()
    const p = await repoProject(r, false)
    r.gh.prs.push({ number: 7, branch: "picker", state: "OPEN" })
    const picker = originTip(r, "picker")
    const first = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Check the picker", prompt: "Look at it.", reviewsPr: "https://github.com/acme/site/pull/7" })
    expect(first.reviewPrUrl).toBe("https://github.com/acme/site/pull/7")
    await resting(r, first.id, ["idle"])
    await reviewState(r, first.id, "open")
    expect(r.yard.store.getTaskRow(first.id)!.review_pr_head).toBe("picker")
    // Its own branch named like the PR's head (a Captain's name, a convention): the next turn commits on it.
    r.yard.store.db.prepare("UPDATE tasks SET branch = 'picker' WHERE id = ?").run(first.id)
    const since = Date.now()
    await call<Task>(r, "POST", `/api/tasks/${first.id}/messages`, { content: "Test it on its branch. [checkout:picker]" })
    const t = await resting(r, first.id, ["idle"], 2)
    await pushed(r, t.id, since)
    expect(originTip(r, "picker")).toBe(picker)
    // The WIP ref carries the reviewer's commit instead.
    expect(git(r.bare, "log", "--format=%s", `refs/boxyard/wip/${t.id}`)).toContain("Reviewer's notes")
  }, 60_000)

  it("a review task that opens its own PR shows both: its own is the one Merge PR and Done when its PR merges follow", async () => {
    const r = await start()
    const p = await repoProject(r)
    r.gh.prs.push({ number: 7, branch: "picker", state: "OPEN" }, { number: 8, branch: "fix-from-review", state: "OPEN" })
    const mcp = await coordinator(r)
    const made = await mcp<{ id: string; reviewsPr?: string }>("create_task", {
      project: p.id,
      title: "Verdict on the picker",
      prompt: "Leave a verdict, and open a fix of your own. [gh-pr:acme/site#8]",
      reviews_pr: "https://github.com/acme/site/pull/7",
    })
    expect(made.reviewsPr).toBe("https://github.com/acme/site/pull/7")
    await resting(r, made.id, ["pr_ready"])
    await reviewState(r, made.id, "open")
    const t = await getTask(r, made.id)
    expect(t).toMatchObject({ prUrl: "https://github.com/acme/site/pull/8", prState: "open", reviewPrUrl: "https://github.com/acme/site/pull/7", reviewPrState: "open" })

    // The reviewed PR merging leaves it ready for review; its own merging makes it done.
    r.gh.prs[0]!.state = "MERGED"
    await r.yard.tasks.prs.pollAll()
    expect(await getTask(r, t.id)).toMatchObject({ status: "pr_ready", reviewPrState: "merged", prState: "open" })
    r.gh.prs[1]!.state = "MERGED"
    await r.yard.tasks.prs.pollAll()
    expect(await getTask(r, t.id)).toMatchObject({ status: "done", prState: "merged" })
  }, 60_000)

  it("create_task refuses a reviews_pr that isn't a PR, and set_reviewed_pr corrects or clears it, never to the task's own PR", async () => {
    const r = await start()
    const p = await repoProject(r)
    const mcp = await coordinator(r)
    await expect(mcp("create_task", { project: p.id, title: "Look", prompt: "x [pr]", reviews_pr: "the picker one" })).rejects.toThrow(/isn't a pull request/)
    expect(r.yard.store.listTasks()).toEqual([])

    // "" opts out of what the title says.
    const none = await mcp<{ id: string; reviewsPr?: string }>("create_task", { project: p.id, title: "Review PR #7", prompt: "x [pr]", reviews_pr: "" })
    expect(none.reviewsPr).toBeUndefined()
    await resting(r, none.id, ["idle"])
    const set = await mcp<{ reviewsPr?: string }>("set_reviewed_pr", { task: none.id, pr: "acme/site#9" })
    expect(set.reviewsPr).toBe("https://github.com/acme/site/pull/9")
    expect(events(r, none.id).some((e) => e.startsWith("Reviews pull request https://github.com/acme/site/pull/9"))).toBe(true)
    r.yard.store.updateTask(none.id, { prUrl: "https://github.com/acme/site/pull/12" }, { quiet: true })
    await expect(mcp("set_reviewed_pr", { task: none.id, pr: "#12" })).rejects.toThrow(/own PR/)
    const cleared = await mcp<{ reviewsPr?: string }>("set_reviewed_pr", { task: none.id, pr: "" })
    expect(cleared.reviewsPr).toBeUndefined()
  }, 60_000)
})
