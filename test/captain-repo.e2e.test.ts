import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, CaptainState, Project, SideThread, SideThreadMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A Captain answers a code question from its read-only clone of the project's repo, with no task: the fake claude's
// [code] marker calls repo_clone, then tries Read, Grep, Write, Edit and Bash there under the run's real flags.
// Origins are bare repos served over file://.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  delete process.env.FAKE_CLAUDE_LOG
  delete process.env.FAKE_CLAUDE_LOG_FULL
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin whose main says hello, and a way to push a new README to it. */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  const push = (text: string) => {
    fs.writeFileSync(path.join(seed, "README.md"), text)
    git(seed, "add", ".")
    git(seed, "commit", "-qm", text.trim())
    git(seed, "push", "-q", bare, "main")
    return git(seed, "rev-parse", "--short", "HEAD")
  }
  push("hello from v1\n")
  return { url: `file://${bare}`, bare, push }
}

const logFile = () => {
  const file = path.join(tmpDir(), "fake-claude.log")
  process.env.FAKE_CLAUDE_LOG = file
  process.env.FAKE_CLAUDE_LOG_FULL = "1"
  return () =>
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l) as { args: string[]; prompt: string })
}
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

async function captainWithRepo(r: Running, url: string) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
  // The API only takes GitHub-style repos; point the project at the local origin before its Captain starts.
  r.yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(url, p.id)
  const state = () => call<CaptainState>(r, "GET", `/api/projects/${p.id}/captain`)
  const messages = () => call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
  const replies = async () => (await messages()).filter((m) => m.role === "assistant")
  const say = async (content: string) => {
    const before = (await replies()).length
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content })
    await waitFor(async () => !(await state()).busy && (await replies()).length > before, "Captain reply")
    return (await replies()).at(-1)!
  }
  return { p, say, clone: path.join(r.dataDir, "captains", p.id, "repo") }
}

describe("a Captain's read-only clone of its repo", () => {
  it("is made on a code question, read with Read and Grep, and refuses Write, Edit and Bash, with no task", async () => {
    const lines = logFile()
    const o = origin()
    const r = await start()
    const { p, say, clone } = await captainWithRepo(r, o.url)

    // A turn that doesn't read code makes no clone.
    await say("status")
    expect(fs.existsSync(clone)).toBe(false)
    const turn = lines().find((l) => l.args.includes("--mcp-config"))!
    expect(argOf(turn.args, "--append-system-prompt")).toContain(`Code questions: answer them yourself from your read-only clone of the repo at ${clone}, not with a task.`)
    expect(turn.prompt).toContain(`Repo: ${o.url} (main). Your read-only clone isn't made yet: repo_clone makes it.`)

    const answer = await say("How does the README greet people? [code]")
    expect(answer.content).toMatch(new RegExp(`Read from the clone at ${clone} \\(fresh, synced just now, \\w+ "hello from v1"`))
    expect(answer.content).toContain("- Read worked: hello from v1")
    expect(answer.content).toContain("- Grep worked: README.md")
    // No tool that edits or runs is there at all, and the clone's deny rules would refuse an edit anyway.
    expect(answer.content).toContain("- Write was refused: No such tool available: Write")
    expect(answer.content).toContain("- Edit was refused: No such tool available: Edit")
    expect(answer.content).toContain("- Bash was refused: No such tool available: Bash")
    const run = lines().at(-1)!.args
    expect(argOf(run, "--disallowedTools")!.split(",")).toEqual([`Edit(/${clone}/**)`, `Write(/${clone}/**)`])
    expect(fs.existsSync(path.join(clone, "NEW.md"))).toBe(false)
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("hello from v1\n")
    expect(r.yard.store.listTasks({ projectId: p.id })).toHaveLength(0)

    // The next turn says how fresh the clone is.
    await say("status again")
    const head = git(clone, "rev-parse", "--short", "HEAD")
    expect(lines().at(-1)!.prompt).toContain(`Your read-only clone: synced just now at ${head}.`)
  })

  it("fetches origin's new commits, and answers from the last copy with its age when the fetch fails", async () => {
    const o = origin()
    const r = await start()
    r.yard.captains.tuning.repo.throttleMs = 0
    const { say, clone } = await captainWithRepo(r, o.url)
    await say("read it [code]")
    const v2 = o.push("hello from v2\n")
    const fresh = await say("read it again [code]")
    expect(fresh.content).toContain(`(fresh, synced just now, ${v2} "hello from v2"`)
    expect(fresh.content).toContain("- Read worked: hello from v2")

    o.push("hello from v3\n")
    fs.renameSync(o.bare, `${o.bare}.away`)
    const stale = await say("and now? [code]")
    expect(stale.content).toContain(`(stale, synced just now, ${v2} "hello from v2"`)
    expect(stale.content).toMatch(/Stale: Fetching origin\/main failed \(.+\), so this is the last copy, synced just now\./)
    expect(stale.content).toContain("- Read worked: hello from v2")
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("hello from v2\n")
  })

  it("is open to the Captain's side threads, read-only the same way", async () => {
    const lines = logFile()
    const o = origin()
    const r = await start()
    const { p, say, clone } = await captainWithRepo(r, o.url)
    const reply = await say("status")
    const { thread } = await call<{ thread: SideThread }>(r, "POST", "/api/threads", { projectId: p.id, anchorId: reply.id, quote: "status", question: "Please try repo_clone" })
    const answer = await waitFor(async () => {
      const list = await call<SideThreadMessage[]>(r, "GET", `/api/threads/${thread.id}/messages`)
      return list.find((m) => m.role === "assistant" || m.role === "error")
    }, "the side thread's answer")
    expect(answer.content).toContain("repo_clone said: {")
    expect(answer.content).toContain(`"status": "fresh",\n  "path": "${clone}"`)
    expect(fs.readFileSync(path.join(clone, "README.md"), "utf8")).toBe("hello from v1\n")
    const run = lines().find((l) => l.args.includes("--fork-session"))!
    expect(argOf(run.args, "--tools")).toBe("Read,Grep,Glob,WebSearch,WebFetch,ToolSearch")
    expect(argOf(run.args, "--allowedTools")!.split(",")).toEqual(expect.arrayContaining(["mcp__boxyard__repo_clone", `Read(/${clone}/**)`]))
    expect(argOf(run.args, "--disallowedTools")!.split(",")).toEqual([`Edit(/${clone}/**)`, `Write(/${clone}/**)`])
  })

  it("says there's no code to read for a project with no repo", async () => {
    const r = await start()
    const { p, say, clone } = await captainWithRepo(r, "")
    r.yard.store.db.prepare("UPDATE projects SET repo = NULL WHERE id = ?").run(p.id)
    const answer = await say("read it [code]")
    expect(answer.content).toContain("repo_clone said: This project has no repository, so there's no code to read.")
    expect(fs.existsSync(clone)).toBe(false)
  })

  it("goes when its project is deleted, and in disk cleanup once unused", async () => {
    const o = origin()
    const r = await start()
    const a = await captainWithRepo(r, o.url)
    await a.say("read it [code]")
    expect(fs.existsSync(path.join(a.clone, "README.md"))).toBe(true)

    // Unused for two weeks: disk cleanup removes it, and the next code question makes it again.
    expect(await r.yard.captains.sweepRepos()).toEqual([])
    expect(await r.yard.captains.sweepRepos(Date.now() + 15 * 24 * 60 * 60_000)).toEqual([{ projectId: a.p.id, why: "unused for 15 days" }])
    expect(fs.existsSync(a.clone)).toBe(false)
    await a.say("read it again [code]")
    expect(fs.existsSync(path.join(a.clone, "README.md"))).toBe(true)

    // A clone left by a project deleted while Box Yard was off.
    const orphan = path.join(r.dataDir, "captains", "prj_gone0001", "repo")
    fs.mkdirSync(orphan, { recursive: true })
    fs.writeFileSync(path.join(orphan, "README.md"), "left\n")
    expect(await r.yard.captains.sweepRepos()).toEqual([{ projectId: "prj_gone0001", why: "its project was deleted" }])
    expect(fs.existsSync(orphan)).toBe(false)

    await call(r, "DELETE", `/api/projects/${a.p.id}`)
    expect(fs.existsSync(a.clone)).toBe(false)
  })
})
