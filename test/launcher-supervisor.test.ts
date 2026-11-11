// The launcher's supervisor (launcher/supervisor.mjs): it runs the server, builds an update beside it when the app
// asks, restarts into it, and goes back when the new version doesn't come up. The servers here are stand-in processes
// that answer /healthz through a fake fetch; the version folders and app/current are real files.
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { InstallError, READY_MARKER } from "../launcher/install.mjs"
import { layout } from "../launcher/paths.mjs"
import { STATUS_MESSAGE, Supervisor, UPDATE_MESSAGE } from "../launcher/supervisor.mjs"
import { currentVersion, pruneVersions, readState, setCurrent, versionOfPath, writeState } from "../launcher/versions.mjs"
import { tmpDir } from "./helpers.js"

const A = "a".repeat(40)
const B = "b".repeat(40)
const C = "c".repeat(40)

type Layout = ReturnType<typeof layout>

function install(L: Layout, sha: string) {
  const dir = path.join(L.versions, sha)
  fs.mkdirSync(path.join(dir, "dist", "server", "server"), { recursive: true })
  fs.writeFileSync(path.join(dir, "dist", "server", "server", "index.js"), "")
  fs.writeFileSync(path.join(dir, READY_MARKER), "{}")
}

function home(...shas: string[]) {
  const L = layout(path.join(tmpDir(), ".boxyard"))
  for (const sha of shas) install(L, sha)
  if (shas[0]) setCurrent(L, shas[0])
  return L
}

let nextPid = 1000

/** A stand-in server process: it records what the launcher sends it and exits when signalled. */
class FakeServer extends EventEmitter {
  pid = nextPid++
  connected = true
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  sent: unknown[] = []
  killedWith: string[] = []
  constructor(
    readonly dir: string,
    readonly env: Record<string, string>,
  ) {
    super()
  }
  send(msg: unknown) {
    this.sent.push(msg)
    return true
  }
  kill(signal = "SIGTERM") {
    this.killedWith.push(signal)
    this.exit(null, signal)
    return true
  }
  exit(code: number | null, signal: string | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.connected = false
    queueMicrotask(() => this.emit("exit", code, signal))
  }
  /** The server asks the launcher for something (the app's Update button). */
  ask(action: string) {
    this.emit("message", { type: UPDATE_MESSAGE, action })
  }
  statuses() {
    return this.sent.filter((m): m is { type: string; status: Record<string, unknown> } => (m as { type?: string }).type === STATUS_MESSAGE).map((m) => m.status)
  }
  last() {
    return this.statuses().at(-1)
  }
}

/** A supervisor whose servers are FakeServers; `broken` versions exit at once with output, like a bad build. */
function supervise(L: Layout, opts: { sha?: string; broken?: string[]; install?: unknown; latestCommit?: unknown } = {}) {
  const servers: FakeServer[] = []
  const lines: string[] = []
  const spawnServer = ({ dir, env }: { dir: string; env: Record<string, string> }) => {
    const s = new FakeServer(dir, env)
    servers.push(s)
    if (opts.broken?.includes(path.basename(dir))) {
      setTimeout(() => {
        s.stderr.write("Error: Cannot find module 'missing'\n")
        s.exit(1)
      }, 5)
    }
    return s
  }
  const fetch = async () => {
    const s = servers.at(-1)
    if (!s || s.exitCode !== null || s.signalCode !== null || opts.broken?.includes(path.basename(s.dir))) throw new Error("ECONNREFUSED")
    return { ok: true, json: async () => ({ ok: true, pid: s.pid }) }
  }
  const sup = new Supervisor({
    layout: L,
    sha: opts.sha ?? A,
    env: { PORT: "4620" },
    port: 4620,
    host: "127.0.0.1",
    repo: "https://github.com/acme/yard.git",
    spawnServer,
    fetch,
    install: opts.install,
    latestCommit: opts.latestCommit ?? (async () => B),
    checkEveryMs: 0,
    healthTimeoutMs: 3000,
    log: (l: string) => lines.push(l),
    stdout: new PassThrough().resume(),
    stderr: new PassThrough().resume(),
  })
  return { sup, servers, lines }
}

async function until(cond: () => unknown, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** An install that walks the steps and "builds" `sha`. */
const installs = (L: Layout, sha: string) => async ({ onStep }: { onStep: (s: string) => void }) => {
  for (const s of ["download", "dependencies", "build", "finish"]) onStep(s)
  install(L, sha)
  return { sha, dir: path.join(L.versions, sha), fresh: true }
}

describe("Supervisor", () => {
  it("starts the current version with its commit, then tells it the update status", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L)
    expect(await sup.start()).toBe(true)
    expect(servers).toHaveLength(1)
    expect(servers[0]!.dir).toBe(path.join(L.versions, A))
    expect(servers[0]!.env).toMatchObject({ PORT: "4620", BOXYARD_BUILD_COMMIT: A })
    expect(servers[0]!.last()).toMatchObject({ current: A, phase: "idle", repoPage: "https://github.com/acme/yard" })
    await sup.stop()
  })

  it("answers hello and check", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L)
    await sup.start()
    const s = servers[0]!
    s.ask("check")
    await until(() => s.last()?.latest === B)
    expect(s.last()).toMatchObject({ checking: false, checkError: null })
    expect(s.last()!.checkedAt).toEqual(expect.any(Number))
    const before = s.sent.length
    s.ask("hello")
    expect(s.sent.length).toBe(before + 1)
    await sup.stop()
  })

  it("says when GitHub can't be reached", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L, { latestCommit: async () => null })
    await sup.start()
    servers[0]!.ask("check")
    await until(() => servers[0]!.last()?.checkError)
    expect(servers[0]!.last()).toMatchObject({ checking: false, latest: null, checkError: "Couldn't reach GitHub to look for updates." })
    await sup.stop()
  })

  it("builds an update in the background, step by step, while the server keeps running", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L, { install: installs(L, B) })
    await sup.start()
    const s = servers[0]!
    s.ask("start")
    await until(() => s.last()?.phase === "ready")
    expect(s.statuses().map((x) => x.phase)).toEqual(["idle", "download", "download", "dependencies", "build", "finish", "ready"])
    expect(s.last()).toMatchObject({ ready: B, latest: B, current: A })
    expect(servers).toHaveLength(1)
    expect(s.killedWith).toEqual([])
    expect(currentVersion(L)).toBe(A)
    await sup.stop()
  })

  it("says it's up to date when main is the running commit", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L, { install: async () => ({ sha: A, dir: path.join(L.versions, A), fresh: false }) })
    await sup.start()
    servers[0]!.ask("start")
    await until(() => servers[0]!.statuses().length > 2 && servers[0]!.last()?.phase === "idle")
    expect(servers[0]!.last()).toMatchObject({ latest: A, ready: null })
    await sup.stop()
  })

  it("reports a failed build with its output, and can try again", async () => {
    const L = home(A)
    let tries = 0
    const install = async (o: { onStep: (s: string) => void }) => {
      if (++tries === 1) throw new InstallError("Installing its dependencies", "npm ERR! network", "Check this computer's internet connection.")
      return installs(L, B)(o)
    }
    const { sup, servers } = supervise(L, { install })
    await sup.start()
    const s = servers[0]!
    s.ask("start")
    await until(() => s.last()?.phase === "failed")
    expect(s.last()).toMatchObject({ error: "Installing its dependencies failed:", detail: "npm ERR! network\n\nCheck this computer's internet connection." })
    s.ask("start")
    await until(() => s.last()?.phase === "ready")
    expect(s.last()).toMatchObject({ error: null, detail: null, ready: B })
    await sup.stop()
  })

  it("restarts into the update, records it, and prunes versions it no longer needs", async () => {
    const L = home(A, C)
    setCurrent(L, A)
    const { sup, servers, lines } = supervise(L, { install: installs(L, B) })
    await sup.start()
    const old = servers[0]!
    old.ask("start")
    await until(() => old.last()?.phase === "ready")
    old.ask("apply")
    await until(() => servers[1]?.last()?.phase === "idle" && servers[1]?.last()?.current === B)
    expect(old.statuses().at(-1)).toMatchObject({ phase: "restarting" })
    expect(old.killedWith).toEqual(["SIGTERM"])
    expect(servers[1]!.dir).toBe(path.join(L.versions, B))
    expect(servers[1]!.env.BOXYARD_BUILD_COMMIT).toBe(B)
    expect(currentVersion(L)).toBe(B)
    expect(readState(L)).toMatchObject({ previous: A, last: { from: A, to: B, ok: true } })
    // The one before stays for going back; the rest go.
    expect(fs.readdirSync(L.versions).sort()).toEqual([A, B])
    expect(lines.join("\n")).toMatch(/Box Yard updated to bbbbbbb/)
    await sup.stop()
  })

  it("goes back to the running version when the update doesn't start, and says why", async () => {
    const L = home(A)
    const { sup, servers, lines } = supervise(L, { install: installs(L, B), broken: [B] })
    await sup.start()
    servers[0]!.ask("start")
    await until(() => servers[0]!.last()?.phase === "ready")
    servers[0]!.ask("apply")
    await until(() => servers[2]?.last()?.phase === "failed")
    expect(servers.map((s) => path.basename(s.dir))).toEqual([A, B, A])
    expect(servers[2]!.last()).toMatchObject({ current: A, ready: null, failed: [B], error: "Box Yard bbbbbbb didn't start, so it went back to aaaaaaa." })
    expect(servers[2]!.last()!.detail).toMatch(/Cannot find module 'missing'/)
    expect(currentVersion(L)).toBe(A)
    expect(readState(L)).toMatchObject({ last: { from: A, to: B, ok: false }, failed: { [B]: { error: expect.stringContaining("Cannot find module") } } })
    expect(lines.join("\n")).toMatch(/didn't start, so it went back/)
    // Still running: the rolled-back server isn't taken for a crash.
    let ended = false
    void sup.wait().then(() => (ended = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(ended).toBe(false)
    await sup.stop()
  })

  it("doesn't start anything when stopped mid-restart, and the next start runs the version that worked", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L, { install: installs(L, B), broken: [B] })
    await sup.start()
    servers[0]!.ask("start")
    await until(() => servers[0]!.last()?.phase === "ready")
    servers[0]!.ask("apply")
    await until(() => servers.length === 2)
    await sup.stop()
    expect(await sup.wait()).toBe(0)
    await new Promise((r) => setTimeout(r, 600))
    expect(servers).toHaveLength(2)
    expect(currentVersion(L)).toBe(A)
  })

  it("ends with the server's exit code when it stops by itself", async () => {
    const L = home(A)
    const { sup, servers } = supervise(L)
    await sup.start()
    servers[0]!.exit(3)
    expect(await sup.wait()).toBe(3)
  })

  it("says the server didn't come up when it exits while starting", async () => {
    const L = home(A)
    const { sup } = supervise(L, { broken: [A] })
    expect(await sup.start()).toBe(false)
    expect(await sup.wait()).toBe(1)
  })
})

describe("versions", () => {
  it("points app/current at a whole install only", () => {
    const L = home(A)
    expect(currentVersion(L)).toBe(A)
    fs.mkdirSync(path.join(L.versions, B))
    setCurrent(L, B)
    expect(currentVersion(L)).toBeNull()
    expect(currentVersion(layout(path.join(tmpDir(), "empty")))).toBeNull()
  })

  it("keeps state across reads, and reads a missing or broken file as empty", () => {
    const L = home(A)
    expect(readState(L)).toEqual({ previous: null, failed: {}, last: null })
    writeState(L, { previous: A, failed: { [B]: { at: 1, error: "x" } }, last: null })
    expect(readState(L)).toMatchObject({ previous: A, failed: { [B]: { at: 1 } } })
    fs.writeFileSync(L.state, "{")
    expect(readState(L)).toEqual({ previous: null, failed: {}, last: null })
  })

  it("prunes what isn't kept, and staging folders an hour old", () => {
    const L = home(A, B, C)
    const fresh = path.join(L.app, "staging-new")
    const stale = path.join(L.app, "staging-old")
    fs.mkdirSync(fresh)
    fs.mkdirSync(stale)
    const hourAgo = (Date.now() - 2 * 60 * 60_000) / 1000
    fs.utimesSync(stale, hourAgo, hourAgo)
    expect(pruneVersions(L, new Set([A, B])).sort()).toEqual([C])
    expect(fs.readdirSync(L.versions).sort()).toEqual([A, B])
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it("knows which version a launcher file runs from", () => {
    const L = home(A)
    fs.mkdirSync(path.join(L.versions, A, "launcher"))
    const file = path.join(L.versions, A, "launcher", "main.mjs")
    fs.writeFileSync(file, "")
    expect(versionOfPath(L, file)).toBe(A)
    expect(versionOfPath(L, path.join(L.current, "launcher", "main.mjs"))).toBe(A)
    expect(versionOfPath(L, path.join(tmpDir(), "npx", "launcher", "main.mjs"))).toBeNull()
  })
})
