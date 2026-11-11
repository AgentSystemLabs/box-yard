// Runs the Box Yard server and updates it on request (docs/npx.md › Updates).
//
// The server runs as this process's child, with an IPC channel. It asks for updates through it (the app's Update
// button) and hears how they go. The update protocol:
//
//   server → launcher  { type: "box-yard:update", action: "hello" | "check" | "start" | "apply" }
//   launcher → server  { type: "box-yard:update-status", status }
//
// "start" builds the newest main beside the running version (install.mjs) while the server keeps serving; the status
// then says "ready". "apply" stops the server, points app/current at the new version and starts it. If the new one
// doesn't answer /healthz in time, it goes back to the version before and says why. Task agents run detached from the
// server, so they keep working through the restart.
import { spawn } from "node:child_process"
import { installLatest as realInstall, latestCommit as realLatest } from "./install.mjs"
import { readState, setCurrent, writeState, pruneVersions, short } from "./versions.mjs"
import { githubPage } from "./paths.mjs"
import path from "node:path"

export const UPDATE_MESSAGE = "box-yard:update"
export const STATUS_MESSAGE = "box-yard:update-status"
/** Phases while an update installs, in order (install.mjs STEPS). */
export const INSTALL_PHASES = ["download", "dependencies", "build", "finish"]
/** How long a started server has to answer /healthz. */
export const HEALTH_TIMEOUT_MS = 90_000
/** How long a server has to stop after SIGTERM before it is killed. */
export const STOP_TIMEOUT_MS = 20_000
/** How often main is checked for a newer commit (BOXYARD_UPDATE_CHECK_MINUTES; 0 turns it off). */
export const CHECK_EVERY_MS = 30 * 60_000
/** Output lines kept from the server, for the message when a new version won't start. */
const OUTPUT_LINES = 40

export class Supervisor {
  /**
   * @param {object} o
   * @param {ReturnType<import("./paths.mjs").layout>} o.layout
   * @param {string} o.sha the version to run (installed in versions/<sha>)
   * @param {Record<string,string>} o.env the server's environment
   * @param {number} o.port
   * @param {string} o.host where the server listens; a wildcard is checked on 127.0.0.1
   * @param {string} o.repo
   * @param {string} [o.ownVersion] the version this launcher runs from, never pruned
   */
  constructor(o) {
    this.o = o
    this.layout = o.layout
    this.sha = o.sha
    this.install = o.install ?? realInstall
    this.latestCommit = o.latestCommit ?? realLatest
    this.spawnServer = o.spawnServer ?? spawnServer
    this.fetch = o.fetch ?? globalThis.fetch
    this.log = o.log ?? ((line) => console.log(line))
    this.healthTimeoutMs = o.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
    this.stopTimeoutMs = o.stopTimeoutMs ?? STOP_TIMEOUT_MS
    this.checkEveryMs = o.checkEveryMs ?? CHECK_EVERY_MS
    this.now = o.now ?? Date.now
    this.child = null
    this.output = []
    this.stopping = false
    /** Set while the supervisor itself stops or swaps the server, so its exit isn't taken for a crash. */
    this.swapping = false
    this.timer = null
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
    const state = readState(this.layout)
    this.status = {
      current: o.sha,
      latest: null,
      checkedAt: null,
      checking: false,
      checkError: null,
      phase: "idle",
      ready: null,
      error: null,
      detail: null,
      failed: Object.keys(state.failed),
      last: state.last,
      repoPage: githubPage(o.repo),
    }
  }

  /** Start the server; resolves whether it came up. Then checks main now and every `checkEveryMs`. */
  async start() {
    const ok = await this.run(this.sha)
    if (ok && this.checkEveryMs > 0) {
      void this.check()
      this.timer = setInterval(() => void this.check(), this.checkEveryMs)
      this.timer.unref?.()
    }
    return ok
  }

  /** Resolves with the exit code once the server stopped for good (a crash, or a stop). */
  wait() {
    return this.exited
  }

  /** Stop the server (Ctrl-C, systemd stop) and resolve when it's gone. */
  async stop(signal = "SIGTERM") {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    await this.stopChild(signal)
    this.resolveExit(0)
  }

  // ---- the server process

  /** Start versions/<sha> and wait for its /healthz. False when it exits or doesn't answer in time. */
  async run(sha) {
    // Ctrl-C (or systemd) during an update's restart: don't start another server.
    if (this.stopping) return false
    const dir = path.join(this.layout.versions, sha)
    this.output = []
    const env = { ...this.o.env, BOXYARD_BUILD_COMMIT: sha }
    const child = this.spawnServer({ dir, env })
    this.child = child
    const tee = (stream, out) =>
      stream?.on("data", (chunk) => {
        out.write(chunk)
        for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) this.output.push(line)
        if (this.output.length > OUTPUT_LINES) this.output.splice(0, this.output.length - OUTPUT_LINES)
      })
    tee(child.stdout, process.stdout)
    tee(child.stderr, process.stderr)
    child.on("message", (msg) => this.onMessage(msg))
    let gone = false
    child.once("exit", (code, signal) => {
      gone = true
      if (this.child === child) this.child = null
      if (this.swapping || this.stopping) return
      // The server stopped by itself: so does the launcher, with its exit code (systemd restarts it on a failure).
      if (this.timer) clearInterval(this.timer)
      this.resolveExit(code ?? (signal ? 1 : 0))
    })
    const healthy = await this.waitHealthy(child, () => gone)
    if (healthy) this.send()
    return healthy
  }

  async waitHealthy(child, gone) {
    const host = /^(0\.0\.0\.0|::|\[::\]|)$/.test(this.o.host ?? "") || this.o.host === "localhost" ? "127.0.0.1" : this.o.host
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${this.o.port}/healthz`
    const deadline = this.now() + this.healthTimeoutMs
    while (this.now() < deadline && !gone()) {
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(2000) })
        const body = res.ok ? await res.json() : null
        // Our child answering, not some other server on the port.
        if (body?.ok && (body.pid === undefined || body.pid === child.pid)) return true
      } catch {
        // not up yet
      }
      await sleep(400)
    }
    return false
  }

  async stopChild(signal = "SIGTERM") {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.kill(signal)
    const timer = setTimeout(() => child.kill("SIGKILL"), this.stopTimeoutMs)
    await exited
    clearTimeout(timer)
  }

  // ---- updates

  onMessage(msg) {
    if (!msg || msg.type !== UPDATE_MESSAGE) return
    if (msg.action === "hello") this.send()
    else if (msg.action === "check") void this.check()
    else if (msg.action === "start") void this.startUpdate()
    else if (msg.action === "apply") void this.apply()
  }

  set(patch) {
    Object.assign(this.status, patch)
    this.send()
  }

  send() {
    const child = this.child
    if (!child?.connected) return
    try {
      child.send({ type: STATUS_MESSAGE, status: { ...this.status } })
    } catch {
      // the server is going; the next one asks with "hello"
    }
  }

  /** Ask GitHub for main's newest commit. */
  async check() {
    if (this.status.checking) return
    this.set({ checking: true })
    const latest = await this.latestCommit({ repo: this.o.repo }).catch(() => null)
    this.set(latest ? { checking: false, latest, checkedAt: this.now(), checkError: null } : { checking: false, checkError: "Couldn't reach GitHub to look for updates." })
  }

  /** Build the newest main beside the running version. The server keeps serving meanwhile. */
  async startUpdate() {
    const { phase } = this.status
    if (INSTALL_PHASES.includes(phase) || phase === "ready" || phase === "restarting") return
    this.set({ phase: "download", error: null, detail: null })
    try {
      const { sha } = await this.install({
        layout: this.layout,
        repo: this.o.repo,
        buildToolsHint: this.o.buildToolsHint,
        onStep: (step) => this.set({ phase: step }),
      })
      if (sha === this.sha) this.set({ phase: "idle", latest: sha, checkedAt: this.now(), ready: null })
      else this.set({ phase: "ready", latest: sha, checkedAt: this.now(), ready: sha })
    } catch (err) {
      this.set({ phase: "failed", error: firstLine(err?.message) || "The update failed.", detail: [err?.detail, err?.hint].filter(Boolean).join("\n\n") || null })
    }
  }

  /** Restart into the version an update built; back to this one if it doesn't come up. */
  async apply() {
    const to = this.status.ready
    if (this.status.phase !== "ready" || !to) return
    const from = this.sha
    this.set({ phase: "restarting" })
    this.log(`\n▸ Updating Box Yard ${short(from)} → ${short(to)}: restarting the server…`)
    this.swapping = true
    const state = readState(this.layout)
    try {
      await this.stopChild()
      if (this.stopping) return
      setCurrent(this.layout, to)
      if (await this.run(to)) {
        this.sha = to
        delete state.failed[to]
        state.previous = from
        state.last = { from, to, ok: true, at: this.now() }
        writeState(this.layout, state)
        pruneVersions(this.layout, new Set([to, from, this.o.ownVersion].filter(Boolean)))
        this.log(`✓ Box Yard updated to ${short(to)}. Open tabs offer to reload.`)
        this.set({ current: to, phase: "idle", ready: null, error: null, detail: null, failed: Object.keys(state.failed), last: state.last })
        return
      }
      // Stopped before the new version answered: the next start runs the one known to work.
      if (this.stopping) return setCurrent(this.layout, from)
      const output = this.output.join("\n")
      await this.stopChild("SIGKILL")
      setCurrent(this.layout, from)
      const error = `Box Yard ${short(to)} didn't start, so it went back to ${short(from)}.`
      state.failed[to] = { at: this.now(), error: output.slice(-4000) }
      state.last = { from, to, ok: false, at: this.now(), error }
      writeState(this.layout, state)
      this.log(`✗ ${error}`)
      this.status = { ...this.status, phase: "failed", ready: null, error, detail: output || null, failed: Object.keys(state.failed), last: state.last }
      if (!(await this.run(from)) && !this.stopping) {
        this.log(`✗ Box Yard ${short(from)} didn't start again either. See the output above.`)
        this.resolveExit(1)
      }
    } finally {
      this.swapping = false
    }
  }
}

/** Start the server in `dir`, its output piped (the supervisor shows it and keeps the tail) and an IPC channel open. */
export function spawnServer({ dir, env }) {
  return spawn(process.execPath, [path.join(dir, "dist", "server", "server", "index.js")], {
    cwd: dir,
    env,
    stdio: ["inherit", "pipe", "pipe", "ipc"],
  })
}

const firstLine = (s) => String(s ?? "").split("\n")[0]?.trim() ?? ""
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
