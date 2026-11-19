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

// A task's PR shows however it was opened: the agent ran `gh pr create` in its shell (the runner reads the URL gh
// printed), or the PR exists only on GitHub (Cody opened it by hand, or the agent used the API or a browser) and the
// PR tracker finds it by the task's branch, at a turn's end or on its scheduled round. A real worker turn (fake-claude
// on a local box) against a bare origin at <tmp>/github.com/acme/site.git, which Box Yard reads as acme/site, and a
// fake GitHub API: GraphQL lookups by branch (d<i>) and by PR number (p<i>). The mock `gh pr merge` writes
// FAKE_GH_STATE, which the fake GitHub reads. Nothing here talks to the real GitHub.

interface FakePr {
  number: number
  branch: string
  state: "OPEN" | "MERGED"
  createdAt: string
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  gh: { prs: FakePr[]; branchLookups: string[]; prLookups: number[] }
  stateFile: string
  dataDir: string
}
const running: Running[] = []
const closers: (() => Promise<void>)[] = []

const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", env }).toString().trim()

/** A bare origin with one commit on main, at a path that reads as github.com/acme/site. */
function origin() {
  const root = tmpDir("pr-detect-origin-")
  const bare = path.join(root, "github.com", "acme", "site.git")
  const seed = path.join(root, "seed")
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  return `file://${bare}`
}

function fakeGithub(stateFile: string): { gh: Running["gh"]; fetch: typeof globalThis.fetch } {
  const gh: Running["gh"] = { prs: [], branchLookups: [], prLookups: [] }
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
  const fetch = (async (url: string, init: RequestInit) => {
    // REST (a merge reads its PR for the issues it closes): a PR that names none.
    if (!String(url).endsWith("/graphql")) return json(/\/pulls\/\d+$/.test(String(url)) ? { number: Number(String(url).split("/").pop()), title: "Mock change", body: "" } : [])
    const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, string | number> }
    // The mock `gh pr merge` merged this PR.
    const merged = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { state: string; mergedBy: string; number: number }) : null
    const node = (pr: FakePr) => {
      const isMerged = pr.state === "MERGED" || (merged?.state === "MERGED" && merged.number === pr.number)
      return {
        url: `https://github.com/acme/site/pull/${pr.number}`,
        state: isMerged ? "MERGED" : "OPEN",
        isDraft: false,
        createdAt: pr.createdAt,
        mergedAt: isMerged ? new Date().toISOString() : null,
        mergedBy: isMerged ? { login: merged?.mergedBy ?? "cody" } : null,
        headRefName: pr.branch,
        headRefOid: "c0ffee".padEnd(40, "0"),
        headRepository: { nameWithOwner: "acme/site" },
        labels: { nodes: [] },
      }
    }
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
    for (const [k, v] of Object.entries(variables)) {
      const byBranch = /^b(\d+)$/.exec(k)
      if (byBranch) {
        gh.branchLookups.push(`${variables[`o${byBranch[1]}`]}/${variables[`n${byBranch[1]}`]}@${v}`)
        data[`d${byBranch[1]}`] = { nameWithOwner: "acme/site", pullRequests: { nodes: gh.prs.filter((p) => p.branch === v).map(node) }, parent: null }
      }
      const byNumber = /^p(\d+)$/.exec(k)
      if (byNumber) {
        gh.prLookups.push(Number(v))
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
  const stateFile = path.join(tmpDir("pr-detect-gh-"), "gh-state.json")
  const { gh, fetch } = fakeGithub(stateFile)
  const provider = new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE)
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider, github: { fetch, token: () => "test-token" } })
  // Captains would wake on the PR notices and start turns of their own; these tests are about the task.
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, gh, stateFile, dataDir: config.dataDir }
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

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

async function repoProject(r: Running) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "site", env: { FAKE_GH_STATE: r.stateFile } })
  // The API only takes GitHub repos; point the project at the local origin, whose path still reads as acme/site.
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(origin(), p.id)
  return p
}

const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
/** The task's turn `turns` is over and it rests in one of these statuses. */
const resting = (r: Running, id: string, statuses: string[], turns = 1) =>
  waitFor(
    async () => {
      const t = await getTask(r, id)
      return statuses.includes(t.status) && t.turnCount >= turns && !t.pendingCount && !r.yard.store.getTaskRow(id)?.current_turn_id ? t : null
    },
    `task ${id} to rest in ${statuses.join("/")} after turn ${turns}`,
    30_000,
  )
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 500)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const notices = (r: Running) =>
  r.yard.store
    .listChat(500)
    .filter((m) => m.role === "notice" && m.content.startsWith("🔀"))
    .map((m) => m.content)

/** get_task as the Coordinator sees it. */
async function mcpGetTask(r: Running, taskId: string) {
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
  const res = (await client.callTool({ name: "get_task", arguments: { task: taskId } })) as { content: { text: string }[]; isError?: boolean }
  if (res.isError) throw new Error(res.content[0]!.text)
  return JSON.parse(res.content[0]!.text) as { pr?: string; prState?: string; status: string }
}

describe("a task's PR shows however it was opened", () => {
  it("the agent ran `gh pr create`: the PR from its shell output is the task's, ready for review, merged through FAKE_GH_STATE", async () => {
    const r = await start()
    const p = await repoProject(r)
    r.gh.prs.push({ number: 12, branch: "unknown", state: "OPEN", createdAt: new Date().toISOString() })
    const created = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Fix the lights", prompt: "Fix the lights and open a PR. [gh-pr:acme/site#12]" })
    const t = await resting(r, created.id, ["pr_ready"])
    expect(t).toMatchObject({ prUrl: "https://github.com/acme/site/pull/12", prState: "open", branch: created.branch })
    expect(events(r, t.id)).toContain("Opened pull request: https://github.com/acme/site/pull/12")
    expect(notices(r)).toEqual(["🔀 **Fix the lights** opened a pull request: https://github.com/acme/site/pull/12"])
    // The runner's report had the PR: nothing to look up by branch at turn end. GitHub was asked about the PR itself.
    expect(r.gh.branchLookups).toEqual([])
    expect(r.gh.prLookups).toContain(12)
    expect(await mcpGetTask(r, t.id)).toMatchObject({ status: "pr_ready", pr: "https://github.com/acme/site/pull/12", prState: "open" })

    // It is tracked like any PR: the Merge PR message runs the mock `gh pr merge`, GitHub says merged, the task is done.
    await call<Task>(r, "POST", `/api/tasks/${t.id}/messages`, { content: "Merge your pull request #12" })
    const done = await resting(r, t.id, ["done"], 2)
    expect(done).toMatchObject({ prState: "merged", prMergedBy: "fake-claude" })
  }, 60_000)

  it("a PR only GitHub knows about is found by the task's branch at its turn's end, and on the scheduled round", async () => {
    const r = await start()
    const p = await repoProject(r)

    // A turn with no PR anywhere: its end looks the branch up, finds none, and the task rests idle.
    const first = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Tidy the docs", prompt: "Tidy the docs. [pr]" })
    const idle = await resting(r, first.id, ["idle"])
    expect(idle.prUrl).toBeNull()
    expect(r.gh.branchLookups).toEqual([`acme/site@${first.branch}`])

    // Cody opens a PR for its branch on GitHub; the task's next turn ends and finds it.
    r.gh.prs.push({ number: 21, branch: first.branch!, state: "OPEN", createdAt: new Date().toISOString() })
    await call<Task>(r, "POST", `/api/tasks/${first.id}/messages`, { content: "One more pass. [pr]" })
    const found = await resting(r, first.id, ["pr_ready"], 2)
    expect(found).toMatchObject({ prUrl: "https://github.com/acme/site/pull/21", prState: "open" })
    expect(events(r, first.id)).toContain(`Found pull request #21 on GitHub, on its branch ${first.branch}: https://github.com/acme/site/pull/21`)
    expect(notices(r)).toEqual(["🔀 **Tidy the docs** opened a pull request: https://github.com/acme/site/pull/21"])
    expect(await mcpGetTask(r, first.id)).toMatchObject({ pr: "https://github.com/acme/site/pull/21", prState: "open" })

    // Another task rests idle; its PR is opened on GitHub afterwards, with no turn of its own to end. The scheduled
    // round (every PR_DISCOVER_MS with the poll) finds it.
    const second = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Add a footer", prompt: "Add a footer. [pr]" })
    await resting(r, second.id, ["idle"])
    r.gh.prs.push({ number: 22, branch: second.branch!, state: "OPEN", createdAt: new Date().toISOString() })
    expect(await r.yard.tasks.prs.discover()).toBe(1)
    expect(await getTask(r, second.id)).toMatchObject({ status: "pr_ready", prUrl: "https://github.com/acme/site/pull/22", prState: "open" })
    expect(notices(r)).toContain("🔀 **Add a footer** opened a pull request: https://github.com/acme/site/pull/22")
    // The first task has its PR now: the round didn't look its branch up again.
    expect(r.gh.branchLookups.filter((b) => b.endsWith(`@${first.branch}`))).toHaveLength(2)
  }, 60_000)
})
