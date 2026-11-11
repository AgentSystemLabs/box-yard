// The `box-yard` command (bin/box-yard.mjs): check the computer, install Box Yard the first time, start it, and keep
// it running so the app's Update button can swap in a newer version. docs/npx.md is the user-facing guide.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { checkComputer, formatProblems, installHint, osFamily, pickPort, realProbe, which } from "./checks.mjs"
import { cleanEnv, InstallError, installEnv, installLatest, latestCommit, runLogged, STEPS } from "./install.mjs"
import { boxyardHome, DEFAULT_PORT, ensureEnvFile, expandHome, layout as layoutOf, NPX_COMMAND, readEnvFile, repoUrl, setting, settingPath } from "./paths.mjs"
import { installService, uninstallService, unitPath } from "./service.mjs"
import { Supervisor } from "./supervisor.mjs"
import { currentVersion, readState, setCurrent, short, versionOfPath, writeState } from "./versions.mjs"

export const HELP = `Box Yard: one chat to run a yard of Claude Code agents.

  ${NPX_COMMAND}                  install (first run) and start on http://localhost:3000
  ${NPX_COMMAND} demo             try it with a fake Claude and its own data, no keys needed
  ${NPX_COMMAND} --public         listen on every address with a generated password (a VPS, your LAN)
  ${NPX_COMMAND} update           install the newest version now (the app's Update button does this too)
  ${NPX_COMMAND} doctor           check this computer and say what's missing
  ${NPX_COMMAND} service install  keep it running on a Linux server (systemd), across logouts and reboots
  ${NPX_COMMAND} service uninstall

Options:
  --port <n>       listen on this port (default 3000, or the next free one)
  --host <addr>    listen on this address (default 127.0.0.1; 0.0.0.0 with --public)
  --public         listen on 0.0.0.0, and write a strong BOXYARD_PASSWORD to the settings file if there's none
  --data <dir>     keep the database here (default ~/.boxyard/data)
  --no-open        don't open the browser
  --allow-root     run as root (only when agents run in Upstash boxes or Docker, not on this computer)
  -y, --yes        answer yes to questions (installing Claude Code)

Settings live in ~/.boxyard/.env (BOXYARD_HOME moves the whole folder). Guide: docs/npx.md
`

/** The command line, as `{ command, sub, flags, errors }`. */
export function parseArgs(argv) {
  const flags = { open: true, public: false, allowRoot: false, yes: false, help: false, version: false }
  const words = []
  const errors = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = (name) => {
      const eq = a.indexOf("=")
      if (eq > 0) return a.slice(eq + 1)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        errors.push(`${name} needs a value.`)
        return undefined
      }
      i++
      return next
    }
    if (a === "--help" || a === "-h") flags.help = true
    else if (a === "--version" || a === "-v") flags.version = true
    else if (a === "--no-open") flags.open = false
    else if (a === "--public") flags.public = true
    else if (a === "--allow-root") flags.allowRoot = true
    else if (a === "--yes" || a === "-y") flags.yes = true
    else if (a === "--port" || a.startsWith("--port=")) {
      const v = value("--port")
      const n = Number(v)
      if (v !== undefined && !(Number.isInteger(n) && n > 0 && n < 65536)) errors.push(`--port wants a port number, not "${v}".`)
      else if (v !== undefined) flags.port = n
    } else if (a === "--host" || a.startsWith("--host=")) flags.host = value("--host")
    else if (a === "--data" || a.startsWith("--data=")) flags.data = value("--data")
    else if (a.startsWith("-")) errors.push(`Unknown option ${a}.`)
    else words.push(a)
  }
  const [command = "start", sub] = words
  if (!["start", "demo", "update", "doctor", "service", "help"].includes(command)) errors.push(`Unknown command "${command}".`)
  return { command: command === "help" ? "start" : command, sub, flags: command === "help" ? { ...flags, help: true } : flags, errors }
}

/** Where the database lives: --data, else the demo's own folder (never real data), else BOXYARD_DATA_DIR, else ~/.boxyard/data. */
export function dataDirFor({ flags, demo, env, fileEnv, cwd, L }) {
  if (flags.data) return path.resolve(cwd, expandHome(flags.data))
  if (demo) return L.demoData
  const set = setting("BOXYARD_DATA_DIR", env, fileEnv)
  return set ? settingPath(set, L.home) : L.data
}

/** `localhost`, 127.x or ::1. */
const isLoopback = (h) => /^(localhost|::1|\[::1\]|127\.\d+\.\d+\.\d+)$/i.test(h.trim())

/** The Box Yard holding `dataDir`, from its server.lock (server/dataLock.ts), when that process is still alive. */
export function runningServer(dataDir) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, "server.lock"), "utf8"))
    if (!Number.isInteger(lock.pid)) return null
    process.kill(lock.pid, 0)
    return lock
  } catch {
    return null
  }
}

const urlFor = (host, port) => `http://${!host || /^(0\.0\.0\.0|::|127\.0\.0\.1)$/.test(host) ? "localhost" : host.includes(":") ? `[${host}]` : host}:${port}`

/** Open `url` in the browser, on a desktop only (never over SSH or in CI). */
function openBrowser(url) {
  if (process.env.CI || process.env.SSH_CONNECTION || !process.stdout.isTTY) return
  const cmd = process.platform === "darwin" ? "open" : process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? "xdg-open" : null
  if (!cmd || !which(cmd)) return
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
}

async function ask(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return !/^n(o)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

/**
 * Run the command line; resolves the exit code. `io.out`/`io.err` print lines. Everything that touches the computer
 * comes from the real modules; the pieces are tested one by one (test/launcher-*.test.ts).
 */
export async function main(argv, { env = process.env, cwd = process.cwd(), io = { out: (l) => console.log(l), err: (l) => console.error(l) } } = {}) {
  const { command, sub, flags, errors } = parseArgs(argv)
  if (errors.length) {
    for (const e of errors) io.err(`✗ ${e}`)
    io.err(`  → ${NPX_COMMAND} --help lists the commands and options.`)
    return 2
  }
  if (flags.help) {
    io.out(HELP)
    return 0
  }
  const home = boxyardHome(env)
  const L = layoutOf(home)
  const fileEnv = readEnvFile(L.envFile)
  const installed = currentVersion(L)
  if (flags.version) {
    const own = versionOfLauncher(L)
    io.out(`Box Yard ${installed ? short(installed) : "(not installed yet)"} · launcher ${own ? short(own) : "from npx"} · Node ${process.version} · ${home}`)
    return 0
  }

  const demo = command === "demo"
  const dataDir = dataDirFor({ flags, demo, env, fileEnv, cwd, L })
  const family = osFamily(process.platform, realProbe().osRelease())

  if (command === "service") {
    if (sub === "uninstall") return uninstallService({ layout: L, env, log: io.out })
    if (sub !== "install") {
      io.err(`✗ ${NPX_COMMAND} service install (or uninstall).`)
      return 2
    }
  }

  const wantsInstall = !installed || command === "update"
  const checks = await checkComputer({ install: wantsInstall, dirs: [home, dataDir], agents: !demo && command !== "update", allowRoot: flags.allowRoot })
  if (command === "doctor") return doctor({ checks, L, installed, dataDir, env, io })
  if (checks.stop.length) {
    io.err("")
    for (const line of formatProblems(checks.stop, "✗")) io.err(line)
    io.err("")
    return 1
  }

  const running = runningServer(dataDir)
  if (command === "update") return update({ L, installed, running, env, io, family })
  if (command === "service") {
    if (running) {
      io.err(`✗ Box Yard is already running on this data (pid ${running.pid}). Stop it first (Ctrl-C), then install the service, which starts it again.`)
      return 1
    }
    const sha = installed ?? (await firstInstall({ L, env, io, family }))
    if (!sha) return 1
    if (flags.public && !setting("BOXYARD_PASSWORD", env, fileEnv) && !(await writePassword({ L, sha, env, io }))) return 1
    const keep = []
    if (flags.port) keep.push("--port", String(flags.port))
    if (flags.host || flags.public) keep.push("--host", flags.host ?? "0.0.0.0")
    if (flags.data) keep.push("--data", dataDir)
    if (flags.allowRoot) keep.push("--allow-root")
    return installService({ layout: L, args: keep, env: cleanEnv(env), log: io.out })
  }

  if (running) {
    const url = urlFor(running.host, running.port)
    io.out(`Box Yard is already running on this data (pid ${running.pid}): ${url}`)
    if (flags.open && isLoopback(running.host === "0.0.0.0" ? "127.0.0.1" : running.host)) openBrowser(url)
    return 0
  }

  // Where to listen. A network address needs a password (server/bind.ts refuses to start without one).
  const host = flags.host ?? (flags.public ? "0.0.0.0" : setting("HOST", env, fileEnv))
  const password = setting("BOXYARD_PASSWORD", env, fileEnv)
  const allowOpen = setting("BOXYARD_ALLOW_OPEN", env, fileEnv) === "1"
  if (host && !isLoopback(host) && !password && !allowOpen && !flags.public && !demo) {
    io.err(`\n✗ Listening on ${host} lets other devices reach Box Yard, but there's no BOXYARD_PASSWORD, so anyone on that network could use it.`)
    io.err(`  → Run ${NPX_COMMAND} --public to write a strong one to ${L.envFile}, or drop --host / HOST to keep it on this computer.\n`)
    return 1
  }
  const portSetting = flags.port ?? (setting("PORT", env, fileEnv) ? Number(setting("PORT", env, fileEnv)) : undefined)
  const picked = await pickPort({ port: portSetting ?? DEFAULT_PORT, explicit: portSetting !== undefined, host: host || "127.0.0.1" })
  if (picked.error) {
    io.err(`\n✗ ${picked.error}\n  → ${picked.fix}\n`)
    return 1
  }
  if (picked.moved) io.out(`! Port ${portSetting ?? DEFAULT_PORT} is busy, so Box Yard uses ${picked.port}.`)

  for (const line of formatProblems(checks.warn.filter((w) => w.id !== "claude"), "!")) io.out(line)
  if (ensureEnvFile(L.envFile)) io.out(`▸ Created ${L.envFile} for your settings.`)
  let sha = installed
  if (!sha) {
    sha = await firstInstall({ L, env, io, family })
    if (!sha) return 1
  }
  if (flags.public && !password && !demo && !(await writePassword({ L, sha, env, io }))) return 1
  if (!demo && checks.warn.some((w) => w.id === "claude")) await offerClaude({ flags, io, env, family })

  const serverEnv = {
    ...cleanEnv(env),
    BOXYARD_ENV_FILE: L.envFile,
    BOXYARD_DATA_DIR: dataDir,
    BOXYARD_HOME: home,
    BOXYARD_LAUNCHER: "1",
    PORT: String(picked.port),
    ...(host ? { HOST: host } : {}),
    ...(demo ? { BOXYARD_MOCK: "1" } : {}),
  }
  const minutes = Number(setting("BOXYARD_UPDATE_CHECK_MINUTES", env, fileEnv) ?? 30)
  const supervisor = new Supervisor({
    layout: L,
    sha,
    env: serverEnv,
    port: picked.port,
    host: host || "127.0.0.1",
    repo: repoUrl(env),
    ownVersion: versionOfLauncher(L),
    buildToolsHint: installHint("build-tools", family),
    checkEveryMs: Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : undefined,
    log: io.out,
  })
  let stopping = false
  const stop = (signal) => {
    if (stopping) return
    stopping = true
    void supervisor.stop(signal)
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGHUP", () => stop("SIGTERM"))
  if (demo) io.out("▸ Demo: a fake Claude drives the Coordinator and agents, with its own data in " + dataDir)
  const up = await supervisor.start()
  if (up && flags.open && (!host || isLoopback(host) || host === "0.0.0.0")) openBrowser(urlFor(host, picked.port))
  else if (!up && supervisor.child) io.out("! Box Yard hasn't answered yet; it keeps starting. Its output is above.")
  return supervisor.wait()
}

/** The version this launcher runs from, when it runs from an install (the service), not from npx's copy. */
function versionOfLauncher(L) {
  try {
    return versionOfPath(L, fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

/** Write a strong random BOXYARD_PASSWORD to the settings file with the app's own `./yard password` (its rules). */
async function writePassword({ L, sha, env, io }) {
  ensureEnvFile(L.envFile)
  const users = typeof process.getuid === "function" && process.getuid() === 0 ? ["--user", "root"] : []
  const r = await runLogged(process.execPath, [path.join(L.versions, sha, "dist", "server", "scripts", "password.js"), "--env", L.envFile, ...users], { cwd: L.home, env: cleanEnv(env) })
  if (r.code !== 0) {
    io.err(`✗ Couldn't write a password to ${L.envFile}:\n${r.tail}`)
    return false
  }
  io.out(`\n${r.tail.replace("Restart Box Yard to use it.", "You log in with it.")}\n`)
  return true
}

/** Install the newest main and make it current, printing each step. Resolves its sha, or null after saying why. */
async function firstInstall({ L, env, io, family }) {
  io.out("▸ Installing Box Yard (first run: about a minute)…")
  try {
    const { sha } = await installLatest({
      layout: L,
      repo: repoUrl(env),
      env: installEnv(env),
      buildToolsHint: installHint("build-tools", family),
      onStep: (step) => io.out(`  ${STEPS[step] ?? step}…`),
    })
    setCurrent(L, sha)
    io.out(`✓ Installed Box Yard ${short(sha)} in ${L.home}`)
    return sha
  } catch (err) {
    reportInstallError(err, L, io)
    return null
  }
}

function reportInstallError(err, L, io) {
  io.err("")
  if (err instanceof InstallError) {
    io.err(`✗ ${err.step} failed.`)
    if (err.detail) io.err(err.detail.replace(/^/gm, "    "))
    if (err.hint) io.err(`  → ${err.hint}`)
  } else io.err(`✗ ${err?.message ?? err}`)
  io.err(`  The whole log: ${L.updateLog}\n`)
}

/** `box-yard update`: install the newest main now. A running Box Yard updates from its app instead. */
async function update({ L, installed, running, env, io, family }) {
  if (running) {
    io.err(`✗ Box Yard is running (pid ${running.pid}). Use Update in the app (it builds in the background and restarts by itself), or stop it and run this again.`)
    return 1
  }
  io.out("▸ Updating Box Yard…")
  try {
    const { sha } = await installLatest({ layout: L, repo: repoUrl(env), env: installEnv(env), buildToolsHint: installHint("build-tools", family), onStep: (step) => io.out(`  ${STEPS[step] ?? step}…`) })
    if (sha === installed) {
      io.out(`✓ Already up to date (${short(sha)}).`)
      return 0
    }
    setCurrent(L, sha)
    const state = readState(L)
    writeState(L, { ...state, previous: installed, last: { from: installed, to: sha, ok: true, at: Date.now() } })
    io.out(`✓ Updated Box Yard ${short(installed)} → ${short(sha)}. It runs from the next start.`)
    return 0
  } catch (err) {
    reportInstallError(err, L, io)
    return 1
  }
}

async function doctor({ checks, L, installed, dataDir, env, io }) {
  const latest = await latestCommit({ repo: repoUrl(env), env: installEnv(env) }).catch(() => null)
  io.out(`Box Yard ${installed ? short(installed) : "not installed yet"}${latest ? ` · newest on main: ${short(latest)}${installed && latest !== installed ? " (Update in the app, or run update)" : ""}` : " · couldn't reach GitHub"}`)
  io.out(`Settings: ${L.envFile} · data: ${dataDir}${fs.existsSync(unitPath()) ? ` · service: ${unitPath()}` : ""}`)
  io.out(`Node ${process.version} on ${process.platform}`)
  for (const line of formatProblems(checks.stop, "✗")) io.out(line)
  for (const line of formatProblems(checks.warn, "!")) io.out(line)
  if (!checks.stop.length && !checks.warn.length) io.out("✓ Everything Box Yard needs is here.")
  return checks.stop.length ? 1 : 0
}

/** Claude Code isn't installed: offer to install it (npm, no sudo), or say how. */
async function offerClaude({ flags, io, env, family }) {
  const cmd = "npm install -g @anthropic-ai/claude-code"
  const yes = flags.yes || (await ask(`! Claude Code (claude) isn't installed; agents on this computer run it. Install it now with \`${cmd}\`? [Y/n] `))
  if (!yes) {
    io.out(`  → Install it later: ${installHint("claude", family)}. Box Yard starts anyway; its Setup card says what's missing.`)
    return
  }
  io.out(`▸ ${cmd}`)
  const r = await runLogged("npm", ["install", "-g", "@anthropic-ai/claude-code", "--no-audit", "--no-fund"], { cwd: process.cwd(), env: cleanEnv(env) })
  if (r.code === 0) io.out("✓ Installed Claude Code. Run `claude` once in a terminal to log in, or add a Claude key in Settings › Credentials.")
  else {
    io.out(`✗ That didn't work:\n${r.tail.replace(/^/gm, "    ")}`)
    if (/EACCES|permission/i.test(r.tail)) io.out("  → npm can't write its global folder. See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally")
  }
}
