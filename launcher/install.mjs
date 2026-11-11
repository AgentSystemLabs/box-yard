// Installing a version of Box Yard: a shallow clone of main, its dependencies, a build, then only what it needs to run.
// The first start and the in-app Update button both come here. A version is built beside the running one and only
// moved into versions/<sha> once it's whole, so a failed or interrupted install never touches what runs.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { BRANCH } from "./paths.mjs"

/** The marker a whole install writes last: a versions/<sha> folder without it is a leftover. */
export const READY_MARKER = ".box-yard-ready.json"
/** How many log lines an error message carries. */
const TAIL_LINES = 30

/**
 * Run `cmd args` in `cwd`, its output appended to `logFile`. Resolves `{ code, tail }`: the exit code (null when it
 * was killed or timed out) and its last lines, for an error message.
 */
export function runLogged(cmd, args, { cwd, env = process.env, logFile, timeoutMs = 20 * 60_000 }) {
  return new Promise((resolve) => {
    const log = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null
    log?.write(`\n$ ${cmd} ${args.join(" ")}\n`)
    const lines = []
    const keep = (chunk) => {
      log?.write(chunk)
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        lines.push(line)
        if (lines.length > TAIL_LINES) lines.shift()
      }
    }
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      log?.end()
      return resolve({ code: null, tail: String(err) })
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.on("error", (err) => keep(`${err.message}\n`))
    child.on("close", (code) => {
      clearTimeout(timer)
      log?.end(() => resolve({ code, tail: lines.join("\n") }))
      if (!log) resolve({ code, tail: lines.join("\n") })
    })
  })
}

/** The environment for install steps: dev dependencies included (the build needs them), no npx leftovers. */
export function installEnv(env = process.env) {
  const out = cleanEnv(env)
  delete out.NODE_ENV
  out.GIT_TERMINAL_PROMPT = "0"
  out.npm_config_update_notifier = "false"
  return out
}

/**
 * `env` without what npx adds for the command it runs: its npm_* settings and the PATH entries into its own cache
 * (the server and every agent would inherit them, and an agent's `npm ci` would follow npx's settings).
 */
export function cleanEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (/^npm_/i.test(k) || k === "INIT_CWD" || k === "NODE_CHANNEL_FD" || k === "NODE_CHANNEL_SERIALIZATION_MODE") continue
    out[k] = v
  }
  if (out.PATH) {
    out.PATH = out.PATH.split(path.delimiter)
      .filter((p) => p && !/[/\\]_npx[/\\]/.test(p) && !/node-gyp-bin/.test(p) && !/[/\\]node_modules[/\\]\.bin$/.test(p))
      .join(path.delimiter)
  }
  return out
}

export class InstallError extends Error {
  constructor(step, detail, hint) {
    super(`${step} failed${detail ? `:\n${detail}` : "."}`)
    this.step = step
    this.detail = detail
    this.hint = hint
  }
}

/** Steps, in order, for progress: what the step is called, for the UI and the terminal. */
export const STEPS = {
  download: "Downloading the newest Box Yard",
  dependencies: "Installing its dependencies",
  build: "Building it",
  finish: "Finishing up",
}

/**
 * Install the newest commit of `branch` from `repo` into `versions/<sha>`. Returns `{ sha, dir, fresh }`: `fresh` is
 * false when that commit was already installed. `onStep(step)` hears each step as it starts.
 * `run` runs one command (tests stand in for it); `buildToolsHint` is what to install when the native SQLite module
 * couldn't load.
 */
export async function installLatest({ layout, repo, branch = BRANCH, onStep = () => {}, run = runLogged, env = installEnv(), buildToolsHint = "" }) {
  fs.mkdirSync(layout.versions, { recursive: true })
  const staging = path.join(layout.app, `staging-${Date.now()}-${process.pid}`)
  const logFile = layout.updateLog
  fs.writeFileSync(logFile, `Box Yard install, ${new Date().toISOString()}\n`)
  const step = async (name, cmd, args, opts = {}) => {
    const r = await run(cmd, args, { cwd: opts.cwd ?? staging, env, logFile })
    if (r.code !== 0) throw new InstallError(STEPS[name] ?? name, r.tail, opts.hint)
    return r
  }
  try {
    onStep("download")
    await step("download", "git", ["clone", "--quiet", "--depth", "1", "--branch", branch, "--single-branch", repo, staging], {
      cwd: layout.app,
      hint: "Check this computer's internet connection (git needs to reach github.com).",
    })
    const sha = (await gitHead(staging)) ?? ""
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new InstallError(STEPS.download, `git didn't say which commit it got (${sha || "nothing"}).`)
    const dir = path.join(layout.versions, sha)
    if (isInstalled(dir)) {
      fs.rmSync(staging, { recursive: true, force: true })
      return { sha, dir, fresh: false }
    }
    onStep("dependencies")
    await step("dependencies", "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { hint: buildToolsHint ? `If a native module failed to build, install the build tools (${buildToolsHint}) and try again.` : undefined })
    onStep("build")
    await step("build", "npm", ["run", "build"])
    onStep("finish")
    await step("finish", "npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"])
    // The database driver is native: prove it loads here, not when the server first opens the database.
    await step("finish", process.execPath, ["-e", "require('better-sqlite3')(':memory:').prepare('select 1').get()"], {
      hint: `The SQLite driver (better-sqlite3) didn't load on this computer${buildToolsHint ? `. Install the build tools (${buildToolsHint}) and try again` : ""}, or use Node.js 22 or 24 LTS.`,
    })
    fs.writeFileSync(path.join(staging, READY_MARKER), JSON.stringify({ sha, installedAt: new Date().toISOString(), node: process.version }) + "\n")
    fs.rmSync(dir, { recursive: true, force: true })
    try {
      fs.renameSync(staging, dir)
    } catch (err) {
      // Another launcher finished the same commit first: theirs is as good as ours.
      if (!isInstalled(dir)) throw err
    }
    return { sha, dir, fresh: true }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** The commit checked out in `dir`. */
export async function gitHead(dir, run = runLogged) {
  const r = await run("git", ["rev-parse", "HEAD"], { cwd: dir })
  return r.code === 0 ? r.tail.trim().split("\n").pop() : null
}

/** Whether `dir` holds a whole install. */
export function isInstalled(dir) {
  return fs.existsSync(path.join(dir, READY_MARKER)) && fs.existsSync(path.join(dir, "dist", "server", "server", "index.js"))
}

/** The newest commit on `branch` in `repo`, from `git ls-remote` (no clone, no API token). Null when it can't tell. */
export async function latestCommit({ repo, branch = BRANCH, run = runLogged, env = installEnv() }) {
  const r = await run("git", ["ls-remote", repo, `refs/heads/${branch}`], { cwd: process.cwd(), env, timeoutMs: 30_000 })
  if (r.code !== 0) return null
  return /^([0-9a-f]{40})\s/m.exec(r.tail)?.[1] ?? null
}
