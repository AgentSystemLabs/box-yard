import { describe, expect, it } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { buildsDue, folderOrder, ownCleanupOrder } from "../server/ownCleanup.js"
import { cleanOutput, strippedEvent } from "../server/janitor.js"
import type { TaskRow } from "../server/store.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import { liveIn, stopLive, tmpDir } from "./helpers.js"

// Which folders on this computer (and SSH machines) the local cleanup may touch, in which order, and the runner's
// `clean <dir> builds`, which frees dependency and build output but never scratch or captures.

const H = 60 * 60_000
const now = 1_000 * H
const row = (id: string, over: Partial<TaskRow> = {}): TaskRow =>
  ({ id, box_id: LOCAL_BOX_ID, status: "done", current_turn_id: null, last_active_at: now - H, previews_json: "[]", pr_state: null, ...over }) as TaskRow
const never = () => false

describe("ownCleanupOrder", () => {
  it("takes done folders first, then the least recently active, and only resting ones on that computer", () => {
    const rows = [
      row("idle_new", { status: "idle", last_active_at: now - 2 * H }),
      row("done_new", { last_active_at: now - 3 * H }),
      row("idle_old", { status: "pr_ready", last_active_at: now - 50 * H }),
      row("done_old", { last_active_at: now - 40 * H }),
      row("failed", { status: "failed", last_active_at: now - 60 * H }),
      row("running", { status: "working", current_turn_id: "turn_1" }),
      row("starting", { status: "starting" }),
      row("queued", { status: "queued" }),
      row("asks", { status: "needs_input" }),
      row("waits", { status: "waiting" }),
      row("elsewhere", { box_id: "ssh-tower" }),
    ]
    expect(ownCleanupOrder(rows, LOCAL_BOX_ID, never).map((r) => r.id)).toEqual(["done_old", "done_new", "failed", "idle_old", "idle_new"])
  })

  it("never takes a task with a message or compaction waiting, nor a live preview unless it's done", () => {
    const rows = [
      row("has_input", { status: "idle" }),
      row("preview_idle", { status: "idle", previews_json: '[{"port":4000,"url":"http://localhost:4000"}]' }),
      row("preview_done", { previews_json: '[{"port":4000,"url":"http://localhost:4000"}]' }),
    ]
    expect(ownCleanupOrder(rows, LOCAL_BOX_ID, (r) => r.id === "has_input").map((r) => r.id)).toEqual(["preview_done"])
  })
})

describe("buildsDue and folderOrder", () => {
  it("routinely free build output and remove folders only of done tasks, however long another one has rested", () => {
    const rows = [
      row("done_now", { last_active_at: now - 1000 }),
      row("idle_week", { status: "idle", last_active_at: now - 7 * 24 * H }),
      row("pr_ready_old", { status: "pr_ready", last_active_at: now - 50 * H }),
      row("failed_old", { status: "failed", last_active_at: now - 60 * H }),
    ]
    expect(buildsDue(rows, LOCAL_BOX_ID, never).map((r) => r.id)).toEqual(["done_now"])
    expect(folderOrder(rows, LOCAL_BOX_ID, never).map((r) => r.id)).toEqual(["done_now"])
    // A low disk may still free the others' build output (the runner skips a folder a process uses).
    expect(ownCleanupOrder(rows, LOCAL_BOX_ID, never).map((r) => r.id)).toEqual(["done_now", "idle_week", "failed_old", "pr_ready_old"])
  })
})

describe("cleanOutput and strippedEvent", () => {
  it("split removed dirs from the processes that kept a folder, and say what went in the task's words", () => {
    expect(cleanOutput("node_modules\ndist\n")).toEqual({ dirs: ["node_modules", "dist"], live: [] })
    expect(cleanOutput("live: 4242 node server.js\n")).toEqual({ dirs: [], live: ["4242 node server.js"] })
    expect(strippedEvent(["node_modules", "dist"], "to free disk on this computer")).toBe(
      "Build output removed from this task's folder to free disk on this computer: work/node_modules, work/dist. Git ignores these folders and no process was using the folder. Reinstall or rebuild before running the app.",
    )
  })
})

describe("box-runner clean <dir> builds", () => {
  it("removes only ignored, untracked dependency and build output, never scratch, captures or tracked files", () => {
    const taskDir = tmpDir("box-yard-test-clean-")
    const work = path.join(taskDir, "work")
    fs.mkdirSync(work)
    const git = (...args: string[]) => execFileSync("git", args, { cwd: work, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    const put = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true })
      fs.writeFileSync(path.join(work, rel), "x")
    }
    git("init", "-q", "-b", "main")
    fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\ndist/\nbuild/\ntmp/\nshots/\n")
    put("src/index.ts")
    put("docs/build/tracked.md") // a tracked build/ is source
    git("add", ".")
    git("add", "-f", "docs/build/tracked.md")
    git("commit", "-qm", "init")
    for (const rel of ["node_modules/a/index.js", "dist/out.js", "packages/web/build/out.js", "tmp/scratch.txt", "shots/one.png"]) put(rel)

    const out = execFileSync(process.execPath, [path.resolve("runner/box-runner.mjs"), "clean", taskDir, "builds"], { encoding: "utf8" })
    expect(out.split("\n").filter(Boolean).sort()).toEqual(["dist", "node_modules", "packages/web/build"])
    for (const gone of ["node_modules", "dist", "packages/web/build"]) expect(fs.existsSync(path.join(work, gone))).toBe(false)
    for (const kept of ["tmp/scratch.txt", "shots/one.png", "src/index.ts", "docs/build/tracked.md"]) expect(fs.existsSync(path.join(work, kept))).toBe(true)
    // The next prompt says what went.
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, "cleaned.json"), "utf8")).dirs.sort()).toEqual(["dist", "node_modules", "packages/web/build"])
  })
})

describe("box-runner live and clean with a process in the folder", () => {
  const runner = path.resolve("runner/box-runner.mjs")
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync(process.execPath, [runner, ...args], { encoding: "utf8", env: { ...process.env, ...env } })

  /** A pushed-looking repo in <taskDir>/work with ignored node_modules and dist. */
  function workspace() {
    const taskDir = tmpDir("box-yard-test-live-")
    const work = path.join(taskDir, "work")
    fs.mkdirSync(work)
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work })
    fs.writeFileSync(path.join(work, ".gitignore"), "node_modules/\ndist/\n")
    for (const rel of ["node_modules/a/index.js", "dist/server.js"]) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true })
      fs.writeFileSync(path.join(work, rel), "x")
    }
    return { taskDir, work }
  }

  // /proc on Linux; BOXYARD_LIVE_VIA=lsof takes the macOS path (ps and lsof), where those exist.
  const lsof = (() => {
    try {
      execFileSync("sh", ["-c", "command -v lsof && command -v ps"], { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  })()
  const vias: { name: string; env: NodeJS.ProcessEnv }[] = [{ name: "default", env: {} }, ...(lsof ? [{ name: "lsof", env: { BOXYARD_LIVE_VIA: "lsof" } }] : [])]

  for (const via of vias) {
    it(`finds a process whose cwd is inside work/, and clean then leaves everything (${via.name})`, async () => {
      const { taskDir, work } = workspace()
      expect(run(["live", taskDir], via.env)).toBe("")
      const server = await liveIn(path.join(work, "dist"))
      try {
        const live = run(["live", taskDir], via.env)
        expect(live).toMatch(new RegExp(`^live: ${server.pid} `, "m"))
        const out = run(["clean", taskDir, "builds"], via.env)
        expect(cleanOutput(out)).toMatchObject({ dirs: [], live: [expect.stringMatching(new RegExp(`^${server.pid} `))] })
        expect(fs.existsSync(path.join(work, "node_modules", "a", "index.js"))).toBe(true)
        expect(fs.existsSync(path.join(work, "dist", "server.js"))).toBe(true)
        expect(fs.existsSync(path.join(taskDir, "cleaned.json"))).toBe(false)
      } finally {
        stopLive()
      }
    })
  }

  it("finds a process that names a file in work/ in its arguments or holds one open", async () => {
    const { taskDir, work } = workspace()
    const script = path.join(work, "dist", "server.js")
    fs.writeFileSync(script, "setInterval(() => {}, 1000)\n")
    const byArg = spawn(process.execPath, [script], { cwd: os.tmpdir(), stdio: "ignore" })
    const byFd = spawn(process.execPath, ["-e", `require("fs").openSync(${JSON.stringify(path.join(work, "node_modules", "a", "index.js"))}, "r"); console.log("up"); setInterval(() => {}, 1000)`], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "ignore"] })
    try {
      await new Promise((resolve) => byFd.stdout!.once("data", resolve))
      const live = run(["live", taskDir])
      expect(live).toMatch(new RegExp(`^live: ${byArg.pid} `, "m"))
      expect(live).toMatch(new RegExp(`^live: ${byFd.pid} `, "m"))
    } finally {
      byArg.kill("SIGKILL")
      byFd.kill("SIGKILL")
    }
  })

  it("ignores processes in a sibling folder whose name starts the same", async () => {
    const { taskDir } = workspace()
    const sibling = path.join(taskDir, "work-other")
    fs.mkdirSync(sibling)
    await liveIn(sibling)
    try {
      expect(run(["live", taskDir])).toBe("")
    } finally {
      stopLive()
    }
  })
})
