#!/usr/bin/env node
// Box Yard worker runner. Copied into every worker box and run there with plain
// Node (no npm install). It has three modes:
//
//   node box-runner.mjs turn  <taskDir>  run one headless Claude Code (or Codex, or Cursor) turn for a task
//   node box-runner.mjs mcp   <taskDir>  stdio MCP server the agent uses to talk back
//   node box-runner.mjs clean <taskDir> [builds]  delete regenerable dirs from a resting work/ (builds: only
//                                        dependency and build output, never scratch or captures)
//                                        (leaves it all when a live process uses work/: prints `live: <pid> <command>`)
//   node box-runner.mjs live  <taskDir>  print `live: <pid> <command>` for each process using work/ (cwd, open file, argument)
//   node box-runner.mjs deps  <taskDir> restore|save   the dependency cache step of a turn, on its own
//
// Every event goes into <taskDir>/events.jsonl, and also into an Upstash Redis
// stream when task.json has Redis credentials. Each event has a `seq` number so
// the orchestrator can mix both sources without duplicates.
//
// Layout of <taskDir>:
//   task.json     task settings written by the orchestrator (env, repo, redis)
//   turn.json     the turn to run (prompt, session id, resume flag)
//   work/         the agent's working directory (repo clone or scratch space)
//   claude/       CLAUDE_CONFIG_DIR, so the session transcript lives with the task
//   codex/        CODEX_HOME for a Codex task (task.json agent: "codex"): its sessions, and its login file
//   codex-auth.json  the Codex ChatGPT login for the next turn, when Box Yard hands one over; the turn moves it into codex/
//   cursor/       CURSOR_CONFIG_DIR and CURSOR_DATA_DIR for a Cursor task (agent: "cursor"): its chats and project state
//   cursor-plugin/  Box Yard's MCP server as a cursor-agent plugin (written each turn)
//   events.jsonl  append-only event log
//   turn.pid      pid of the running turn (it leads a process group of its own)
//   run.json      the running turn's record: pid, process identity, turn id, events offset
//   signing.key   the identity's signing key for the next turn, when Box Yard keeps it; the turn takes it away

import { spawn, spawnSync, execFile, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

const RUNNER_VERSION = "3"
const [, , mode, taskDirArg, cleanWhat] = process.argv

if (!mode || !taskDirArg) {
  console.error("usage: box-runner.mjs <turn|mcp|clean|live|deps> <taskDir>")
  process.exit(2)
}

const taskDir = path.resolve(taskDirArg)
const task = mode === "clean" || mode === "live" || mode === "deps" ? {} : readJson(path.join(taskDir, "task.json"))

/** Box Yard's built-in text says "Cody"; swap in the configured owner name (same rule as shared/owner.ts). */
function owner(text) {
  const name = typeof task.ownerName === "string" ? task.ownerName.trim() : ""
  return name && name !== "Cody" ? text.replace(/\bCody\b/g, () => name) : text
}
/** Tool definitions with every description run through owner(). */
function namedTools(value) {
  if (Array.isArray(value)) return value.map(namedTools)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "description" && typeof v === "string" ? owner(v) : namedTools(v)]))
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err) {
    if (fallback !== undefined) return fallback
    throw new Error(`Can't read ${file}: ${err.message}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Event log. A mkdir lock keeps seq numbers and file order in step even though
// the turn runner and the MCP server are separate processes.

const eventsFile = path.join(taskDir, "events.jsonl")
const seqFile = path.join(taskDir, "events.seq")
const lockDir = path.join(taskDir, "events.lock")

async function withLock(fn) {
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      // A crashed writer can leave the lock behind. Break it after 10s.
      if (Date.now() - started > 10_000) {
        try {
          fs.rmdirSync(lockDir)
        } catch {}
      }
      await sleep(15)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {}
  }
}

async function redis(command) {
  if (!task.redis?.url || !task.redis?.token) return null
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(task.redis.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${task.redis.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
      return body.result
    } catch (err) {
      lastErr = err
      await sleep(250 * 2 ** attempt)
    }
  }
  // The event is still in events.jsonl; the orchestrator falls back to it.
  process.stderr.write(`[box-yard] redis failed: ${lastErr?.message}\n`)
  return null
}

async function emit(event) {
  return withLock(async () => {
    const prev = Number.parseInt(fs.existsSync(seqFile) ? fs.readFileSync(seqFile, "utf8") : "0", 10) || 0
    const seq = prev + 1
    fs.writeFileSync(seqFile, String(seq))
    const full = { seq, ts: Date.now(), turnId: currentTurnId(), ...event }
    const line = JSON.stringify(full)
    fs.appendFileSync(eventsFile, line + "\n")
    if (task.redis?.key) await redis(["XADD", task.redis.key, "MAXLEN", "~", "5000", "*", "e", line])
    return full
  })
}

function currentTurnId() {
  return readJson(path.join(taskDir, "turn.json"), {}).turnId ?? null
}

const clip = (s, n) => {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "")
  return str.length > n ? `${str.slice(0, n)}…` : str
}

// ---------------------------------------------------------------------------
// Turn mode

let activeChild = null
let activeInterrupt = null
let stopping = false

// `kill -TERM -<pid>` from the orchestrator stops the turn: end Claude, then
// still write turn_end so the task doesn't look stuck.
process.on("SIGTERM", () => {
  if (mode !== "turn" || stopping) return
  stopping = true
  try {
    if (activeInterrupt) void activeInterrupt()
    else activeChild?.kill("SIGTERM")
  } catch {}
  setTimeout(() => {
    try {
      activeChild?.kill("SIGKILL")
    } catch {}
  }, 5000).unref()
})

// The same lines as by_boot/by_start in server/turnProcess.ts: the machine's boot, and when a process started (clock
// ticks since boot on Linux, ps's start time elsewhere). Box Yard compares them with what run.json says, so a pid the
// system hands out again after a reboot or a box resume isn't taken for this turn.
const IDENT_SH = String.raw`by_boot() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.bootsessionuuid 2>/dev/null || true; }
by_start() { if [ -r "/proc/$1/stat" ]; then sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20; else LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; fi; }
printf '%s|%s' "$(by_boot)" "$(by_start "$1")"`

function processIdent(pid) {
  try {
    const ident = execFileSync("sh", ["-c", IDENT_SH, "sh", String(pid)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
    return /^[^|"\\\n]*\|[^"\\\n]+$/.test(ident) ? ident : null
  } catch {
    return null
  }
}

/** The process group `pid` is in, or null when this system can't say. */
function groupOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]) || null
  } catch {}
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) || null
  } catch {
    return null
  }
}

/**
 * A turn leads a process group of its own, Claude and its tools in it, so Box Yard can stop all of it with one
 * `kill -- -<pid>`, and a server stopping (Ctrl-C in its terminal, an upgrade) never reaches it. Box Yard starts it
 * under setsid where there is one; where there isn't (macOS) it starts again here as a new session.
 */
function leadOwnGroup() {
  if (process.env.BOXYARD_RUNNER_DETACHED === "1") {
    delete process.env.BOXYARD_RUNNER_DETACHED
    return true
  }
  const group = groupOf(process.pid)
  if (group === null || group === process.pid) return true
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BOXYARD_RUNNER_DETACHED: "1" },
  })
  child.unref()
  return false
}

/**
 * The turn's run record, so a Box Yard that restarts while it runs can find it again: which process this is (pid,
 * with the boot and its start time), its turn, and where its events start in events.jsonl. run.json goes first and
 * turn.pid after it, so a turn.pid always has its record. Both stay behind after the turn (see the end of runTurn).
 */
function writeRunRecord(turn) {
  let eventsOffset = 0
  try {
    eventsOffset = fs.statSync(eventsFile).size
  } catch {}
  const record = {
    pid: process.pid,
    ident: processIdent(process.pid),
    turnId: turn.turnId ?? null,
    startedAt: Date.now(),
    events: "events.jsonl",
    eventsOffset,
    log: "runner.log",
    runner: RUNNER_VERSION,
  }
  const tmp = path.join(taskDir, `run.json.${process.pid}`)
  fs.writeFileSync(tmp, JSON.stringify(record))
  fs.renameSync(tmp, path.join(taskDir, "run.json"))
  fs.writeFileSync(path.join(taskDir, "turn.pid"), String(process.pid))
}

async function runTurn() {
  const turn = readJson(path.join(taskDir, "turn.json"))
  writeRunRecord(turn)
  // While the machine sleeps the wall clock runs on and the monotonic one doesn't: the gap is time asleep (sleptMs).
  const clocks = { wall: Date.now(), mono: performance.now() }
  // Answers to message_captain waits that ran out last turn; their replies come as this turn's messages.
  for (const f of fs.readdirSync(taskDir)) if (/^captain-reply-.*\.json$/.test(f)) fs.rmSync(path.join(taskDir, f), { force: true })
  // Steers that missed an earlier turn: Box Yard gave them back when it ended, and they're in a later prompt.
  for (const f of fs.readdirSync(taskDir)) {
    const steer = STEER_FILE.test(f) ? readJson(path.join(taskDir, f), null) : null
    if (steer && steer.turnId !== turn.turnId) fs.rmSync(path.join(taskDir, f), { force: true })
  }
  await emit({ t: "turn_start", runner: RUNNER_VERSION })
  prepareIdentityHome()
  const unsigned = setupSigning()
  if (unsigned) await emit({ t: "signing", ok: false, format: task.signing?.format, error: unsigned })
  if (unsigned && task.signing?.kind === "gpg" && !fs.existsSync(allowedSigners)) throw new Error(`GPG signing setup failed: ${unsigned}`)

  const mcpConfigFile = path.join(taskDir, "mcp.json")
  fs.writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        // The connectors this turn gets (task.json `connectors`, Claude Code only): each names its secrets as ${VAR},
        // so this file holds no value. Box Yard's own server comes last, so no connector can stand in for it.
        ...connectorServers(),
        boxyard: { type: "stdio", command: process.execPath, args: [process.argv[1], "mcp", taskDir] },
      },
    }),
  )

  // Dependencies back from the box's cache, and a word on what changed in work/ while the task rested.
  const workDir = path.join(taskDir, "work")
  let prompt = turn.prompt
  if (!turn.compact) {
    const restored = depsStep(depsRestore, turn.deps, workDir)
    if (restored && restored.action !== "miss") await emit({ t: "deps", ...restored })
    const note = workspaceNote(restored?.action === "restored")
    if (note) prompt = `${note}\n\n${prompt}`
  }

  const codex = task.agent === "codex"
  const cursor = task.agent === "cursor"
  const opencode = task.agent === "opencode"
  const harness = codex ? "Codex" : cursor ? "Cursor" : opencode ? "OpenCode" : "Claude"
  if (codex) prepareCodexHome(turn)
  // Codex and Cursor have no /compact to run headless (they compact on their own); Box Yard doesn't ask, but an old
  // turn.json might.
  if ((codex || cursor || opencode) && turn.compact) {
    await emit({ t: "turn_end", startedAt: Date.now(), stopped: false, exitCode: 0, ok: true, result: null, sessionId: turn.sessionId, compact: true, usage: null, error: null, sleptMs: 0 })
    return
  }
  const runAgent = codex ? runCodex : cursor ? runCursor : opencode ? runOpenCode : runClaude
  let sessionId = turn.sessionId
  // Runner start → the CLI's spawn (signing, MCP config, dependency restore): the box side of a task's setup.
  const preSpawnMs = Date.now() - clocks.wall
  let attempt = await runAgent({ turn, sessionId, resume: turn.resume, prompt, mcpConfigFile })

  // The session file can go missing (fresh box, lost archive), or a Codex thread can't open on the login this turn
  // was handed (its saved reasoning is encrypted for the account that wrote it). Start a new session that carries a
  // recap instead of failing the task.
  if (!stopping && !attempt.steerSubmitted && attempt.exitCode !== 0 && turn.resume && /no conversation found|session.*not found|no rollout found|invalid_encrypted_content|encrypted content\b.{0,60}\bcould not be (?:verified|decrypted)/i.test(attempt.errorText)) {
    sessionId = randomUUID()
    await emit({ t: "session_reset", sessionId, reason: `Previous ${harness} session was not found on this box.` })
    attempt = await runAgent({ turn, sessionId, resume: false, prompt: `${turn.recap ?? ""}\n\n---\n\n${prompt}`.trim(), mcpConfigFile })
  }
  // Codex names its own thread; that's the session the next turn resumes.
  if (attempt.sessionId) sessionId = attempt.sessionId
  if (codex) parkCodexAuth()

  const ok = stopping || (attempt.exitCode === 0 && !attempt.result?.is_error)
  if (!turn.compact && !stopping) {
    const saved = depsStep(depsSave, turn.deps, workDir)
    if (saved) await emit({ t: "deps", ...saved })
  }
  let usage = attempt.usage
  if (turn.compact && ok && !stopping) {
    // /compact prints no usage of its own; ask the session what it holds now.
    usage = (await contextReport(sessionId, turn.model || task.model)) ?? null
  }
  dropTaskJson()
  await emit({
    t: "turn_end",
    startedAt: attempt.startedAt,
    stopped: stopping,
    exitCode: attempt.exitCode,
    ok,
    result: attempt.result?.result ?? null,
    costUsd: attempt.result?.total_cost_usd ?? null,
    durationMs: attempt.result?.duration_ms ?? null,
    numTurns: attempt.result?.num_turns ?? null,
    sessionId,
    // Whether this turn continued its session; the CLI's total_cost_usd then includes earlier turns.
    resumed: Boolean(turn.resume) && sessionId === turn.sessionId,
    ...(opencode ? { costScope: "run" } : {}),
    compact: Boolean(turn.compact),
    usage,
    resultUsage: attempt.result?.usage ?? null,
    // The session's running totals per model, which count compactions and subagents (server/usage.ts sessionUsageOf).
    modelUsage: attempt.result?.modelUsage ?? null,
    // Cursor names the model it ran (its label); Claude's and Codex's come from task_turns.
    ...(cursor && attempt.result?.model ? { model: attempt.result.model } : {}),
    error: ok ? null : clip(attempt.errorText || attempt.result?.result || `${codex ? "codex" : cursor ? "cursor-agent" : opencode ? "opencode" : "claude"} exited with code ${attempt.exitCode}`, 2000),
    sleptMs: Math.max(0, Math.round(Date.now() - clocks.wall - (performance.now() - clocks.mono))),
    // Where the turn's time went (shared/turnTimings.ts), on the box's clock: the server adds its side.
    timing: attempt.timing ? { ...attempt.timing, preSpawnMs, runnerStartedAt: clocks.wall } : null,
  })
  // turn.pid and run.json stay behind on purpose: the orchestrator checks the
  // process with them, and a fast turn must not finish before it sees it started.
}

/** The connectors' MCP servers (docs/connectors.md › Sessions), never one named boxyard. */
function connectorServers() {
  const servers = task.agent !== "claude" && task.agent != null ? null : task.connectors?.servers
  if (!servers || typeof servers !== "object") return {}
  return Object.fromEntries(Object.entries(servers).filter(([name]) => name !== "boxyard"))
}

/** The values the connectors' ${VAR}s name: in `claude`'s env only, never a file the runner writes. */
function connectorEnv() {
  const env = task.agent !== "claude" && task.agent != null ? null : task.connectors?.env
  if (!env || typeof env !== "object") return {}
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => /^BOXYARD_CONNECTOR_[A-Z0-9_]+$/.test(k) && typeof v === "string"))
}

function claudeEnv() {
  const claudeConfigDir = path.join(taskDir, "claude")
  const isolate = task.isolateConfig !== false
  return {
    ...turnBaseEnv(),
    ...connectorEnv(),
    ...(isolate ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    IS_SANDBOX: "1",
    DISABLE_AUTOUPDATER: "1",
    PORT: String(task.port ?? 4000),
    BOXYARD_TASK_ID: task.taskId,
    BOXYARD_TASK_DIR: taskDir,
  }
}

/**
 * The runner's own environment with the turn's credentials: task.unsetEnv first drops the ones this turn mustn't use
 * (a box's env can still hold another login, see server/turnCredentials.ts), then task.env sets its own.
 */
function turnBaseEnv() {
  const env = { ...process.env }
  for (const k of task.unsetEnv ?? []) delete env[k]
  const base = { ...env, ...task.env }
  return { ...base, ...signingEnv(base) }
}

// ---------------------------------------------------------------------------
// Commit signing (docs/identities.md). task.json's `signing` says how this task's identity signs; a key Box Yard
// keeps arrives as signing.key for one turn. The turn moves it to a 0700 folder outside the task (no archive takes
// it), or into the box's memory when it has a tmpfs for secrets (task.json `secretsDir`, Docker's). git gets its
// signing settings from env (GIT_CONFIG_COUNT), so they reach this turn's processes and nothing else, and the folder
// and key are removed when the turn ends. With requireSigned, core.hooksPath points at hooks that stop a push of
// commits its key didn't sign and otherwise run the repo's own hooks (in the folder: the tmpfs is noexec).

const signingDir = path.join(os.tmpdir(), `boxyard-sign-${task.taskId ?? "none"}`)
const signingKeyFile = path.join(taskDir, "signing.key")
/** The private key while the turn signs with it. */
const signingKeyPath = task.secretsDir ? path.join(task.secretsDir, `sign-${task.taskId ?? "none"}.key`) : path.join(signingDir, "key")
const allowedSigners = path.join(signingDir, "allowed_signers")
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
/** Every hook git runs from core.hooksPath on this side of a push. */
const GIT_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite", "pre-auto-gc", "reference-transaction", "sendemail-validate", "post-index-change",
]

/**
 * Get the turn's signing ready. Returns why its commits won't be signed, or null (signed, or no key to sign with).
 * With requireSigned, the push guard goes in even when signing can't: the turn's commits then can't be pushed.
 */
function setupSigning() {
  cleanupSigning()
  let key = null
  try {
    key = fs.readFileSync(signingKeyFile, "utf8")
  } catch {}
  takeDelivered(signingKeyFile)
  const s = task.signing
  if (!s) return null
  const problem = signingProblem(s, key)
  if (problem && !s.requireSigned && s.kind !== "gpg") return problem
  const stopped = problem && (s.requireSigned ? `${problem}; the ${s.identity} identity requires signed commits, so this turn's pushes are stopped` : problem)
  try {
    // Not recursive, and just after removing it: a folder someone else made first (a shared /tmp) is refused,
    // never written into.
    fs.mkdirSync(signingDir, { mode: 0o700 })
    if (!problem || s.kind === "gpg") {
      if (s.kind === "gpg") writeGpgProgram(s)
      if (s.kind === "file") fs.writeFileSync(signingKeyPath, key, { mode: 0o600, flag: "wx" })
      fs.writeFileSync(path.join(signingDir, "signs"), "")
    }
    if (s.requireSigned) writeSigningHooks(s)
    // Last: signingEnv takes this file as the sign that the folder is ready.
    fs.writeFileSync(allowedSigners, `box-yard namespaces="git" ${s.publicKey}\n`)
  } catch (err) {
    cleanupSigning()
    return stopped || `the folder for its signing key couldn't be made (${err.path ?? signingDir}: ${err.code ?? err.message})`
  }
  return stopped || null
}

function signingProblem(s, key) {
  if (s.problem) return s.problem
  if (s.kind === "gpg") {
    if (!s.hostKeyring) return "only the local runner can use this computer's GPG keyring; boxes, SSH, Docker and GPU runners are refused"
    const probe = spawnSync("gpg", ["--batch", "--no-tty", "--pinentry-mode", "error", "--yes", "--local-user", s.publicKey, "--detach-sign", "--output", os.devNull], {
      env: { ...process.env, ...task.env }, input: "Box Yard signing check\n", encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    })
    return probe.status === 0 ? null : gpgFailure
  }
  if (s.kind === "file" && !key) return `the ${s.identity} identity's signing key didn't reach this box`
  const version = /git version (\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "")
  if (!version || Number(version[1]) * 1000 + Number(version[2]) < 2034) return `git on this box ${version ? `is ${version[1]}.${version[2]}, and ` : ""}can't sign with SSH keys before 2.34`
  if (s.program) {
    try {
      fs.accessSync(s.program, fs.constants.X_OK)
    } catch {
      return `the signing program ${s.program} isn't on this computer`
    }
  } else if (spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error?.code === "ENOENT") return "this box has no ssh-keygen, which git signs with"
  else if (s.kind === "agent" && !{ ...process.env, ...task.env }.SSH_AUTH_SOCK) return "no SSH agent reaches this runner (SSH_AUTH_SOCK isn't set in Box Yard's environment)"
  return null
}

const gpgFailure = "GPG could not sign headlessly within 15 seconds. Install gpg, check the secret key exists and unlock it in gpg-agent before retrying; pinentry/passphrase prompts cannot be answered here. No unsigned commit was made."

/** No key or passphrase is written here: this adapter bounds every git invocation of the host's gpg. */
function writeGpgProgram(s) {
  const script = path.join(signingDir, "gpg.mjs")
  fs.writeFileSync(script, `import { spawnSync } from "node:child_process"
if (!${JSON.stringify(Boolean(s.hostKeyring))}) { process.stderr.write("The host GPG keyring is available only on the local runner.\\n"); process.exit(1) }
const r = spawnSync("gpg", ["--batch", "--no-tty", "--pinentry-mode", "error", "--no-auto-key-retrieve", ...process.argv.slice(2)], { stdio: [0, "pipe", "pipe"], timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 })
if (r.status !== 0) { process.stderr.write(${JSON.stringify(gpgFailure + "\n")}); process.exit(1) }
process.stdout.write(r.stdout)
process.stderr.write(r.stderr)
`)
  fs.writeFileSync(path.join(signingDir, "gpg"), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(script)} "$@"\n`, { mode: 0o700 })
}

function writeSigningHooks(s) {
  const hooks = path.join(signingDir, "hooks")
  fs.mkdirSync(hooks, { recursive: true, mode: 0o700 })
  // The repo's own hooks folder, as git would find it without Box Yard's core.hooksPath.
  const own = (name) => `by_own="$(GIT_CONFIG_COUNT=0 git rev-parse --git-path hooks 2>/dev/null)/${name}"`
  for (const name of GIT_HOOKS) {
    if (name === "pre-push") continue
    fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\n# Box Yard's core.hooksPath for this turn (requireSigned): the repo's own hook still runs.\n${own(name)}\n[ -x "$by_own" ] || exit 0\nexec "$by_own" "$@"\n`, { mode: 0o755 })
  }
  const refused = path.join(signingDir, "push-refused.txt")
  fs.writeFileSync(
    refused,
    `box-yard: the ${s.identity} identity requires signed commits, and this push has commits its key (${s.fingerprint}) didn't sign. Nothing was pushed.\n` +
      `box-yard: sign them again, e.g. git rebase --force-rebase --gpg-sign origin/${task.baseBranch || "main"}, then push. The commits:\n`,
  )
  fs.writeFileSync(
    path.join(hooks, "pre-push"),
    [
      "#!/bin/sh",
      "# Box Yard (requireSigned): stop a push of commits the identity's key didn't sign, then run the repo's own pre-push.",
      `by_in=$(mktemp "\${TMPDIR:-/tmp}/boxyard-push.XXXXXX") || exit 1`,
      `cat > "$by_in"`,
      `by_bad=`,
      `while read -r by_lref by_lsha by_rref by_rsha; do`,
      `  case "$by_lsha" in *[!0]*) ;; *) continue ;; esac`,
      `  case "$by_rref" in refs/boxyard/*) continue ;; esac`,
      `  by_not=; case "$by_rsha" in *[!0]*) git cat-file -e "$by_rsha^{commit}" 2>/dev/null && by_not="^$by_rsha" ;; esac`,
      s.kind === "gpg"
        ? `  if git log --format='%h %G? %GF %GP' "$by_lsha" $by_not --not --remotes > "$by_in.verify" 2>/dev/null; then by_bad="$by_bad$(awk -v fp=${shq(s.fingerprint)} '($2 != "G" && $2 != "U") || ($3 != fp && $4 != fp) { n++; if (n <= 10) printf " %s", $1 }' "$by_in.verify")"; else by_bad="$by_bad verification-failed"; fi; rm -f "$by_in.verify"`
        : `  by_bad="$by_bad$(git -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile=${shq(allowedSigners)} log --format='%h %G?' "$by_lsha" $by_not --not --remotes 2>/dev/null | awk '$2 != "G" { n++; if (n <= 10) printf " %s", $1 }')"`,
      `done < "$by_in"`,
      `if [ -n "$by_bad" ]; then rm -f "$by_in"; cat ${shq(refused)} >&2; echo "box-yard:$by_bad" >&2; exit 1; fi`,
      own("pre-push"),
      `if [ -x "$by_own" ]; then "$by_own" "$@" < "$by_in"; by_s=$?; else by_s=0; fi`,
      `rm -f "$by_in"`,
      `exit $by_s`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
}

/** The git config that signs this turn's commits, as GIT_CONFIG_* env added after any `env` already has. */
function signingEnv(env) {
  const s = task.signing
  if (!s || !fs.existsSync(allowedSigners)) return {}
  const signs = fs.existsSync(path.join(signingDir, "signs"))
  const pairs = [
    ...(signs
      ? [
          ["gpg.format", s.kind === "gpg" ? "openpgp" : "ssh"],
          ["user.signingKey", s.kind === "gpg" ? s.publicKey : s.kind === "file" ? signingKeyPath : `key::${s.publicKey}`],
          ...(s.kind === "gpg" ? [["gpg.openpgp.program", path.join(signingDir, "gpg")], ["gpg.program", path.join(signingDir, "gpg")]] : []),
          ["commit.gpgSign", "true"],
          ...(s.program ? [["gpg.ssh.program", s.program]] : []),
        ]
      : []),
    ["gpg.ssh.allowedSignersFile", allowedSigners],
    ...(s.requireSigned ? [["core.hooksPath", path.join(signingDir, "hooks")]] : []),
  ]
  const n = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0)
  const out = { GIT_CONFIG_COUNT: String(n + pairs.length) }
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k
    out[`GIT_CONFIG_VALUE_${n + i}`] = v
  })
  return out
}

function cleanupSigning() {
  for (const p of [signingDir, signingKeyPath]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Remove a file Box Yard delivered to the task folder. In a box with a tmpfs for secrets it's a link to the copy kept
 * there (DockerProvider.writeFile), which goes too; a link anywhere else is only unlinked.
 */
function takeDelivered(file) {
  let held = null
  try {
    if (task.secretsDir && fs.lstatSync(file).isSymbolicLink()) {
      const real = fs.realpathSync(file)
      if (path.dirname(real) === fs.realpathSync(task.secretsDir)) held = real
    }
  } catch {}
  fs.rmSync(file, { force: true })
  if (held) fs.rmSync(held, { force: true })
}

/**
 * task.json carries the turn's credentials (its env). On an SSH machine (task.json `dropAfterTurn`) they don't stay
 * there between turns: it goes before turn_end, so Box Yard's next turn writes a fresh one and this never removes that.
 * The turn already holds what it needs in memory, and its MCP server read its own copy when Claude started it.
 */
function dropTaskJson() {
  if (!task.dropAfterTurn) return
  try {
    takeDelivered(path.join(taskDir, "task.json"))
  } catch {}
}

/** On this computer, an identity's own git and gh config folders (task.json identityHome), made on first use. */
function prepareIdentityHome() {
  if (!task.identityHome) return
  try {
    fs.mkdirSync(path.join(task.identityHome, "gh"), { recursive: true, mode: 0o700 })
  } catch {}
}

/** Tokens in the context after one API call: its prompt side plus what it just wrote. */
function contextTokensOf(u) {
  if (!u) return null
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n > 0 ? n : null
}

function contextWindowOf(modelUsage) {
  let best = null
  for (const v of Object.values(modelUsage ?? {})) if (typeof v?.contextWindow === "number" && v.contextWindow > (best ?? 0)) best = v.contextWindow
  return best
}

const AMOUNT = { "": 1, k: 1e3, m: 1e6 }
function parseAmount(str) {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(str.trim())
  return m ? Math.round(Number(m[1]) * AMOUNT[m[2].toLowerCase()]) : null
}

/** `claude -p "/context"` on the session: its "Tokens: 84k / 1m (8%)" line, or null if anything is off. */
function contextReport(sessionId, model) {
  return new Promise((resolve) => {
    const args = [...(task.claudeArgs ?? []), "-p", "--resume", sessionId]
    if (model) args.push("--model", model)
    const child = spawn(task.claudeBin || "claude", [...args], { cwd: path.join(taskDir, "work"), env: claudeEnv(), stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000)
    child.stdout.on("data", (d) => (out += d))
    child.on("error", () => resolve(null))
    child.on("close", () => {
      clearTimeout(timer)
      const m = /Tokens:?\**\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(out)
      const tokens = m && parseAmount(m[1])
      const window = m && parseAmount(m[2])
      resolve(tokens && window ? { tokens, window } : null)
    })
    child.stdin.on("error", () => {})
    child.stdin.end("/context")
  })
}

/**
 * The CLI run's timings (shared/turnTimings.ts TurnClockReading) for turn_end, with the stdio MCP server's handshake
 * (mcp-handshake.json, from this run's MCP process) as processMs and mcpMs. Never throws: timings are optional.
 */
function turnTimingOf(clock, ok) {
  try {
    const reading = clock.finish(ok)
    const h = readJson(path.join(taskDir, "mcp-handshake.json"), null)
    const mine = h && typeof h.initializeAt === "number" && h.initializeAt >= reading.startedAt && h.initializeAt <= (clock.ready ?? reading.endedAt)
    return {
      ...reading,
      processMs: mine ? h.initializeAt - reading.startedAt : null,
      mcpMs: mine && typeof h.readyAt === "number" ? h.readyAt - h.initializeAt : null,
    }
  } catch {
    return null
  }
}

function runClaude({ turn, sessionId, resume, prompt, mcpConfigFile }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const clock = new TurnClock(startedAt)
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigFile,
      "--append-system-prompt",
      turn.systemPrompt ?? "",
    ]
    if (resume) args.push("--resume", sessionId)
    else args.push("--session-id", sessionId)
    const model = turn.model || task.model
    if (model) args.push("--model", model)
    if (turn.effort) args.push("--effort", turn.effort)
    if (turn.autocompact) args.push("--autocompact", String(turn.autocompact))
    // Steers (steerInbox) need stdin open as stream-json; /compact takes plain text.
    const steerable = !turn.compact
    if (steerable) args.push("--input-format", "stream-json")

    const workDir = path.join(taskDir, "work")
    const claudeConfigDir = path.join(taskDir, "claude")
    // Keep the session transcript inside the task folder so it moves with the
    // task between boxes. Local runs that rely on the user's own `claude`
    // login turn this off, since that login lives in the default config dir.
    const isolate = task.isolateConfig !== false
    if (isolate) fs.mkdirSync(claudeConfigDir, { recursive: true })

    const child = spawn(task.claudeBin || "claude", [...(task.claudeArgs ?? []), ...args], {
      cwd: workDir,
      env: claudeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })

    activeChild = child
    let result = null
    let usage = null
    let stderr = ""
    let buf = ""
    let pending = Promise.resolve()
    const queue = (fn) => (pending = pending.then(fn).catch((e) => process.stderr.write(`${e.stack}\n`)))
    const steers = steerable ? steerInbox(child, turn.turnId, queue) : null

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          queue(() => emit({ t: "log", text: clip(line, 1000) }))
          continue
        }
        steers?.started()
        if (msg.type === "result") {
          result = addResult(result, msg)
          steers?.close()
        }
        clock.line(msg)
        const tokens = msg.type === "assistant" && msg.message?.model !== "<synthetic>" ? contextTokensOf(msg.message?.usage) : null
        if (tokens && tokens !== usage?.tokens) {
          usage = { tokens, window: usage?.window ?? null }
          queue(() => emit({ t: "usage", tokens, window: usage.window }))
        }
        for (const ev of translate(msg)) queue(() => emit(ev))
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000)
    })
    child.on("error", (err) => {
      stderr += `\n${err.message}`
    })
    child.on("close", (code, signal) => {
      steers?.close()
      if (buf.trim()) {
        try {
          const msg = JSON.parse(buf)
          if (msg.type === "result") result = addResult(result, msg)
          clock.line(msg)
          for (const ev of translate(msg)) queue(() => emit(ev))
        } catch {}
        buf = ""
      }
      pending.then(() => {
        const window = contextWindowOf(result?.modelUsage)
        if (usage && window) usage.window = window
        // Killed by a signal: 128 + its number, as a shell says it (137 for SIGKILL, what a box's out-of-memory killer sends).
        const killed = code === null && signal ? `claude was killed (${signal})` : ""
        const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)
        const timing = turnTimingOf(clock, exitCode === 0 && !result?.is_error)
        resolve({ exitCode, startedAt, result, usage, timing, errorText: [stderr.trim(), result?.is_error ? result.result : "", killed].filter(Boolean).join("\n") })
      })
    })

    child.stdin.on("error", () => {})
    if (steerable) child.stdin.write(userLine(prompt))
    else child.stdin.end(prompt)
  })
}

/** A stream-json user message for the CLI's stdin. */
const userLine = (text) => `${JSON.stringify({ type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null })}\n`

/**
 * Results added up: a message that reached the CLI as its turn ended runs as one more turn in the same process, with
 * its own result, and Box Yard's turn is all of them. total_cost_usd is already a running total.
 */
function addResult(prev, next) {
  if (!prev) return next
  const sum = (a, b) => (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0)
  const usage = next.usage && typeof next.usage === "object" ? { ...next.usage } : next.usage
  if (usage && prev.usage && typeof prev.usage === "object") {
    for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) usage[k] = sum(prev.usage[k], usage[k])
  }
  return { ...next, duration_ms: sum(prev.duration_ms, next.duration_ms), num_turns: sum(prev.num_turns, next.num_turns), usage }
}

const STEER_FILE = /^steer-[\w-]+\.json$/

/**
 * Steers into a running Claude turn (server/tasks.ts steerQueued). Box Yard writes steer-<id>.json into the task
 * folder; this hands each to the CLI's open stdin as a user message, and Claude reads it at its next step (between
 * tool calls), without stopping. Then the file goes and a `steer` event tells Box Yard it landed. Steers are taken from
 * the CLI's first line until its first result: after that the turn is ending, so a steer left in the folder goes in
 * as the next turn (Box Yard sees the turn end without it). One already written runs before the CLI exits, as one
 * more turn in the same process. A file another turn was meant for is dropped: that turn's end gave it back.
 */
function steerInbox(child, turnId, queue) {
  let live = false
  let closed = false
  let busy = false
  const take = async () => {
    if (!live || closed || busy || stopping) return
    busy = true
    try {
      let names = []
      try {
        names = fs.readdirSync(taskDir).filter((f) => STEER_FILE.test(f))
      } catch {}
      // A file still being written doesn't parse yet; the next look takes it.
      const ready = names.map((name) => ({ file: path.join(taskDir, name), steer: readJson(path.join(taskDir, name), null) })).filter((s) => s.steer)
      ready.sort((a, b) => (Number(a.steer.at) || 0) - (Number(b.steer.at) || 0))
      for (const { file, steer } of ready) {
        if (closed || stopping) return
        if (steer.turnId !== turnId || typeof steer.text !== "string") {
          fs.rmSync(file, { force: true })
          continue
        }
        const written = await new Promise((resolve) => child.stdin.write(userLine(steer.text), (err) => resolve(!err)))
        if (!written) return
        fs.rmSync(file, { force: true })
        queue(() => emit({ t: "steer", id: steer.id ?? null, inputIds: Array.isArray(steer.inputIds) ? steer.inputIds : [] }))
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void take(), 300)
  return {
    /** The CLI is up (its first line): a failed resume never gets this far, so no steer goes into a run that won't read it. */
    started() {
      if (live) return
      live = true
      void take()
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      try {
        child.stdin.end()
      } catch {}
    },
  }
}

/** Turn one Claude stream-json message into zero or more compact events. */
function translate(msg) {
  const out = []
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text?.trim()) out.push({ t: "assistant", text: block.text })
      // Box Yard's own tools emit their own, richer events.
      if (block.type === "tool_use" && !String(block.name).startsWith("mcp__boxyard__")) {
        out.push({ t: "tool", name: block.name, input: clip(block.input, 400) })
      }
    }
  } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("") : block.content
        out.push({ t: "tool_error", text: clip(text, 400) })
      }
    }
  } else if (msg.type === "rate_limit_event" && msg.rate_limit_info && typeof msg.rate_limit_info === "object") {
    // A subscription's limits (server/loginLimits.ts): the server knows which login the turn had.
    out.push({ t: "limits", harness: "claude", info: msg.rate_limit_info })
  }
  return out
}

// ---------------------------------------------------------------------------
// Codex tasks use app-server JSON-RPC over stdio. The event/context helpers mirror server/codex.ts's exec adapter
// (still used by managers). This file must run on every worker with plain Node and an installed Codex CLI.

const codexState = path.join(taskDir, "codex")
// SSH machines keep a forwarded ChatGPT login in tmpfs even while Codex replaces auth.json on refresh.
// Sessions stay in the workspace so archives and moves retain the conversation.
const codexMemoryHome = task.memoryCodexHome && task.secretsDir ? path.join(task.secretsDir, `${task.taskId}.codex`) : null
const codexHome = codexMemoryHome || codexState
const codexAuthDelivery = path.join(taskDir, "codex-auth.json")

/** Every task uses its own Codex home, including tasks that import this computer's login. */
function codexHomeInUse() {
  return codexHome
}

function codexEnv() {
  const env = { ...turnBaseEnv(), IS_SANDBOX: "1", PORT: String(task.port ?? 4000), BOXYARD_TASK_ID: task.taskId, BOXYARD_TASK_DIR: taskDir }
  delete env.CLAUDE_CONFIG_DIR
  env.CODEX_HOME = codexHome
  return env
}

const parseAuth = (text) => {
  try {
    const raw = JSON.parse(text)
    const at = Date.parse(raw?.last_refresh ?? "")
    return { account: raw?.tokens?.account_id ?? null, at: Number.isFinite(at) ? at : 0 }
  } catch {
    return null
  }
}
/** `candidate` is `current`'s login refreshed later (server/codex.ts isRefreshOf). */
function isRefreshOf(current, candidate) {
  const a = parseAuth(current)
  const b = parseAuth(candidate)
  return Boolean(a && b && a.account && a.account === b.account && b.at > a.at)
}

/**
 * The task's Codex home, with the login Box Yard handed over (codex-auth.json, taken out of the task folder) unless
 * the copy already there is the same login refreshed since: Codex rotates the refresh token, so the newer one wins.
 * Box Yard reads the copy back after the turn. With an API key (or no login) a login file left there is removed: it
 * would win over CODEX_API_KEY.
 */
let localCodexAuthSource = null
function prepareCodexHome(turn) {
  let delivered = null
  try {
    delivered = fs.readFileSync(codexAuthDelivery, "utf8")
  } catch {}
  takeDelivered(codexAuthDelivery)
  if (task.isolateCodex === false) {
    // app-server has no --ignore-user-config. Use a clean task home, importing only this login and legacy thread.
    const source = turnBaseEnv().CODEX_HOME || path.join(os.homedir(), ".codex")
    localCodexAuthSource = path.join(source, "auth.json")
    try { delivered = fs.readFileSync(localCodexAuthSource, "utf8") } catch {}
    if (turn?.resume && /^[a-f0-9-]+$/i.test(turn.sessionId ?? "")) {
      const walk = (dir) => {
        let entries = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const file = path.join(dir, e.name)
          if (e.isDirectory()) walk(file)
          else if (e.name.endsWith(`-${turn.sessionId}.jsonl`)) {
            const dest = path.join(codexHome, "sessions", path.relative(path.join(source, "sessions"), file))
            if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(file, dest) }
          }
        }
      }
      walk(path.join(source, "sessions"))
    }
  }
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  if (codexMemoryHome) {
    fs.mkdirSync(codexState, { recursive: true, mode: 0o700 })
    const sessions = path.join(codexState, "sessions")
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(path.join(codexHome, "sessions"))) fs.symlinkSync(sessions, path.join(codexHome, "sessions"))
    const readback = path.join(codexState, "auth.json")
    fs.rmSync(readback, { force: true })
    fs.symlinkSync(path.join(codexHome, "auth.json"), readback)
  }
  const file = path.join(codexHome, "auth.json")
  if (task.codexLogin !== "chatgpt" && !(task.isolateCodex === false && delivered)) {
    fs.rmSync(file, { force: true })
    return
  }
  let existing = ""
  try {
    existing = fs.readFileSync(file, "utf8")
  } catch {}
  // The copy the last turn parked in memory (parkCodexAuth) is the newest unless the hand-over beats it.
  const keep = existing && (!delivered || existing === delivered || isRefreshOf(delivered, existing))
  const text = keep ? existing : delivered
  if (!text) return
  let linked = false
  try {
    linked = fs.lstatSync(file).isSymbolicLink()
  } catch {}
  if (keep && !linked) return
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * In a box with a tmpfs for secrets (Docker), the login goes back into memory between turns: moved there and linked
 * from codex/auth.json, where Box Yard reads it back. The next turn copies it onto the disk again for Codex, which
 * replaces the file when it refreshes. A container that stops loses it, and the next turn takes Box Yard's copy.
 */
function parkCodexAuth() {
  if (localCodexAuthSource) {
    // Never overwrite a switched account or a newer concurrent refresh.
    try {
      const current = fs.readFileSync(localCodexAuthSource, "utf8")
      const refreshed = fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")
      if (isRefreshOf(current, refreshed)) {
        const tmp = `${localCodexAuthSource}.${process.pid}.tmp`
        fs.writeFileSync(tmp, refreshed, { mode: 0o600 }); fs.renameSync(tmp, localCodexAuthSource)
      }
    } catch {}
  }
  if (!task.secretsDir || task.isolateCodex === false || codexMemoryHome) return
  const file = path.join(codexHome, "auth.json")
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return
  } catch {
    return
  }
  const held = path.join(task.secretsDir, `${task.taskId ?? "none"}.codex-auth.json`)
  try {
    fs.copyFileSync(file, `${held}.tmp`)
    fs.chmodSync(`${held}.tmp`, 0o600)
    fs.renameSync(`${held}.tmp`, held)
    fs.rmSync(file, { force: true })
    fs.symlinkSync(held, file)
  } catch {}
}

const toml = (v) => JSON.stringify(v)
const CODEX_OFF = ["apps", "plugins", "computer_use", "browser_use", "in_app_browser", "image_generation", "memories"]

/** server/codex.ts codexExecArgs for a task agent: Box Yard's stdio tools, approved, and no sandbox (the box is one). */
function codexArgs({ effort, instructions, autoCompactTokens }) {
  const args = ["app-server", "--listen", "stdio://"]
  const c = (k, v) => args.push("-c", `${k}=${toml(v)}`)
  c("developer_instructions", instructions)
  c("approval_policy", "never")
  c("sandbox_mode", "danger-full-access")
  c("mcp_servers.boxyard.command", process.execPath)
  c("mcp_servers.boxyard.args", [process.argv[1], "mcp", taskDir])
  c("mcp_servers.boxyard.default_tools_approval_mode", "approve")
  c("mcp_servers.boxyard.startup_timeout_sec", 60)
  c("mcp_servers.boxyard.tool_timeout_sec", 900)
  c("web_search", "live")
  if (effort) c("model_reasoning_effort", effort)
  if (autoCompactTokens) c("model_auto_compact_token_limit", autoCompactTokens)
  for (const f of CODEX_OFF) c(`features.${f}`, false)
  return args
}

// Persist before the RPC, then after acceptance. A transport failure is ambiguous: never blindly replay it.
function writeCodexDelivery(state) {
  const file = path.join(taskDir, `codex-delivery-${state.turnId}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, "w", 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}

/** server/codex.ts codexContext: the last token count in the thread's rollout file, and the last rate_limits one had. */
function codexContext(home, thread) {
  const root = path.join(home, "sessions")
  const desc = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse()
    } catch {
      return []
    }
  }
  let file = null
  outer: for (const y of desc(root))
    for (const m of desc(path.join(root, y)))
      for (const d of desc(path.join(root, y, m))) {
        const hit = desc(path.join(root, y, m, d)).find((f) => f.startsWith("rollout-") && f.endsWith(`-${thread}.jsonl`))
        if (hit) {
          file = path.join(root, y, m, d, hit)
          break outer
        }
      }
  if (!file) return null
  let text = ""
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - (2 << 20))
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const lines = text.split("\n")
  let ctx = null
  let limits = null
  for (let i = lines.length - 1; i >= 0 && (!ctx || !limits); i--) {
    if (!lines[i].includes('"token_count"')) continue
    try {
      const d = JSON.parse(lines[i])
      const p = d?.payload
      if (p?.type !== "token_count") continue
      const u = p.info?.last_token_usage
      const tokens = u ? (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) : 0
      if (!ctx && tokens > 0) ctx = { tokens, window: typeof p.info.model_context_window === "number" ? p.info.model_context_window : null, totalUsage: p.info.total_token_usage ?? null }
      if (!limits && p.rate_limits && typeof p.rate_limits === "object") {
        const at = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN
        limits = { rateLimits: p.rate_limits, rateLimitsAt: Number.isFinite(at) ? at : null }
      }
    } catch {}
  }
  return ctx ? { ...ctx, ...limits } : null
}

/** Codex's token counts in Claude's terms (server/codex.ts claudeUsageOf): its input_tokens include the cached ones. */
function claudeUsageOf(u) {
  if (!u) return null
  const input = Number(u.input_tokens) || 0
  const cached = Number(u.cached_input_tokens) || 0
  const written = Number(u.cache_write_input_tokens) || 0
  return { input_tokens: Math.max(0, input - cached - written), cache_creation_input_tokens: written, cache_read_input_tokens: cached, output_tokens: Number(u.output_tokens) || 0 }
}

/** Codex's stderr without its tracing lines (server/codex.ts codexErrorText). */
const codexErrorText = (stderr) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/.test(l))
    .slice(-5)
    .join("\n")

const CODEX_TOOL_NAMES = { command_execution: "Bash", file_change: "Edit", web_search: "WebSearch", todo_list: "TodoWrite" }

/** A Codex item that is a tool call, as the Box Yard `tool` event Claude's would be (null: not one, or Box Yard's own). */
function codexTool(item) {
  if (item.type === "mcp_tool_call") return item.server === "boxyard" ? null : { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }
  if (item.type === "command_execution") return { name: "Bash", input: { command: String(item.command ?? "") } }
  if (item.type === "file_change") return { name: "Edit", input: { changes: (item.changes ?? []).map((c) => `${c?.kind ?? "update"} ${c?.path ?? ""}`) } }
  if (item.type === "web_search") return { name: "WebSearch", input: { query: String(item.query ?? "") } }
  return null
}

/** A finished Codex tool item's error text, or null when it worked. */
function codexToolError(item) {
  if (item.type === "mcp_tool_call" && (item.status === "failed" || item.error)) return String(item.error?.message ?? "The tool call failed.")
  if (item.type === "command_execution" && (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0))) return String(item.aggregated_output || `exit code ${item.exit_code}`)
  if (item.type === "file_change" && item.status === "failed") return "The patch failed."
  return null
}

async function runCodex({ turn, sessionId, resume, prompt }) {
  const startedAt = Date.now()
  const args = codexArgs({ effort: turn.effort, instructions: turn.systemPrompt ?? "", autoCompactTokens: Number(turn.autocompact) || null })
  const child = spawn(task.codexBin || "codex", [...(task.codexArgs ?? []), ...args], { cwd: path.join(taskDir, "work"), env: codexEnv(), stdio: ["pipe", "pipe", "pipe"] })
  activeChild = child
  const state = { turnId: turn.turnId, threadId: null, nativeTurnId: null, entries: [], terminal: null }
  writeCodexDelivery(state)
  let thread = null, nativeTurn = null, completed = null, reply = "", stderr = "", buf = "", failure = null
  let accepting = false, polling = false, timer = null, nextId = 0, closed = false
  let usageTotal = null
  let usageBase = resume ? codexContext(codexHomeInUse(), sessionId)?.totalUsage : {}
  let pending = Promise.resolve(), inFlight = Promise.resolve()
  const calls = new Map(), seen = new Set()
  const queue = (event) => { pending = pending.then(() => emit({ ...event, turnId: turn.turnId })) }
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n")
  const rpc = (method, params, timeout = 60_000) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error("Codex app-server connection closed"))
    const id = ++nextId
    const expiry = setTimeout(() => { calls.delete(id); reject(new Error(`Codex ${method} response timed out`)) }, timeout)
    calls.set(id, { resolve, reject, expiry })
    send({ id, method, params })
  })
  let endTurn
  const ended = new Promise((resolve) => { endTurn = resolve })
  let endProcess
  const exited = new Promise((resolve) => { endProcess = resolve })
  const fail = (message) => { failure ??= message; accepting = false; endTurn() }
  const normalize = (item) => ({ ...item, type: ({ commandExecution: "command_execution", fileChange: "file_change", webSearch: "web_search", mcpToolCall: "mcp_tool_call" })[item.type] ?? item.type, exit_code: item.exitCode, aggregated_output: item.aggregatedOutput })
  const onLine = (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && !msg.method) {
      const call = calls.get(msg.id)
      if (!call) return
      calls.delete(msg.id); clearTimeout(call.expiry)
      if (msg.error) call.reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rejected: true, rpcCode: msg.error.code }))
      else call.resolve(msg.result)
      return
    }
    if (msg.id !== undefined) {
      // Steering is never an approval response. Task policy is never/full-access; fail closed for new request types.
      send({ id: msg.id, error: { code: -32601, message: "Interactive requests are not supported by the Box Yard task runner" } })
      fail(`Unexpected Codex interactive request: ${msg.method}`)
      return
    }
    const p = msg.params ?? {}
    if (p.threadId && p.threadId !== thread) return
    if (msg.method === "turn/started") {
      nativeTurn = p.turn.id; state.nativeTurnId = nativeTurn; writeCodexDelivery(state)
      return
    }
    if (p.turnId && nativeTurn && p.turnId !== nativeTurn) return
    if (msg.method === "turn/completed") {
      if (p.turn?.id !== nativeTurn) return
      accepting = false; completed = p.turn
      // Capture client IDs even when an item notification was lost before completion.
      for (const item of p.turn.items ?? []) if (item.type === "userMessage") markInput(item.clientId)
      endTurn()
    } else if (msg.method === "item/started" || msg.method === "item/completed") {
      const item = p.item
      if (!item) return
      if (item.type === "userMessage") { markInput(item.clientId); return }
      const finished = msg.method === "item/completed"
      if (finished && item.type === "agentMessage" && item.text?.trim()) { reply = item.text; queue({ t: "assistant", text: reply }); return }
      const normalized = normalize(item), tool = codexTool(normalized)
      if (tool && !seen.has(item.id)) { seen.add(item.id); queue({ t: "tool", name: tool.name, input: clip(tool.input, 400) }) }
      if (finished) { const error = codexToolError(normalized); if (error) queue({ t: "tool_error", text: clip(error, 400) }) }
    } else if (msg.method === "thread/tokenUsage/updated") {
      const total = p.tokenUsage?.total
      if (total) {
        if (!usageBase) {
          const last = p.tokenUsage.last ?? {}
          usageBase = Object.fromEntries(Object.entries(total).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), Math.max(0, v - (last[k] ?? 0))]))
        }
        usageTotal = Object.fromEntries(Object.entries(total).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]))
      }
    } else if (msg.method === "error" && !p.willRetry) fail(String(p.error?.message ?? "Codex failed"))
  }
  function markInput(clientId) {
    const entry = state.entries.find((e) => e.id === clientId)
    if (entry && !entry.incorporated) { entry.incorporated = true; writeCodexDelivery(state) }
  }
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    const lines = buf.split("\n"); buf = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onLine(line)
  })
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000) })
  child.stdin.on("error", () => {})
  child.on("error", (err) => fail(`Couldn't start Codex app-server: ${err.message}`))
  child.on("close", (code, signal) => {
    closed = true; accepting = false
    for (const call of calls.values()) { clearTimeout(call.expiry); call.reject(new Error("Codex app-server connection closed")) }
    calls.clear()
    if (!completed) fail(`Codex app-server exited before turn completion (${signal || code})`)
    endProcess()
  })
  const poll = async () => {
    if (!accepting || polling) return
    polling = true
    try {
      const mail = fs.readdirSync(taskDir).filter((f) => STEER_FILE.test(f)).map((f) => ({ f, value: readJson(path.join(taskDir, f), null) }))
        .filter(({ value }) => value?.turnId === turn.turnId).sort((a, b) =>
          (Number.isSafeInteger(a.value.sequence) && Number.isSafeInteger(b.value.sequence) ? a.value.sequence - b.value.sequence : a.value.at - b.value.at) || a.f.localeCompare(b.f))
      for (const { f, value } of mail) {
        if (!accepting) break
        if (state.entries.some((e) => e.id === value.id)) continue
        const entry = { id: value.id, inputIds: value.inputIds, state: "submitted", incorporated: false }
        state.entries.push(entry); writeCodexDelivery(state)
        queue({ t: "codex_delivery", inputIds: entry.inputIds, delivery: "submitted" })
        try {
          const result = await rpc("turn/steer", { threadId: thread, expectedTurnId: nativeTurn, input: [{ type: "text", text: value.text, text_elements: [] }], clientUserMessageId: value.id })
          if (result.turnId !== nativeTurn) throw new Error("Codex accepted a different turn ID")
          entry.state = "accepted"; entry.accepted = true; writeCodexDelivery(state)
          queue({ t: "codex_delivery", inputIds: entry.inputIds, delivery: "accepted" })
        } catch (err) {
          // Only validation/precondition failures establish non-delivery. An internal server error is ambiguous.
          const rejected = err.rejected && (err.rpcCode === -32602 || /no active turn|no turn.*active|expectedTurnId.*(mismatch|does not match)|turn id mismatch/i.test(err.message))
          entry.state = rejected ? "rejected" : "uncertain"; writeCodexDelivery(state)
          // A timeout/disconnect might already have applied the input. Stop instead of accepting more work blindly.
          if (!rejected) fail(err.message)
        }
        fs.rmSync(path.join(taskDir, f), { force: true })
      }
    } finally { polling = false }
  }
  try {
    await rpc("initialize", { clientInfo: { name: "boxyard_task", version: RUNNER_VERSION }, capabilities: {} })
    send({ method: "initialized", params: {} })
    const options = { cwd: path.join(taskDir, "work"), approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: turn.systemPrompt ?? "", ...(turn.model ? { model: turn.model } : {}) }
    const response = await rpc(resume ? "thread/resume" : "thread/start", { ...options, ...(resume ? { threadId: sessionId } : {}) })
    thread = response.thread.id; state.threadId = thread; writeCodexDelivery(state)
    queue({ t: "session", sessionId: thread })
    activeInterrupt = () => nativeTurn ? rpc("turn/interrupt", { threadId: thread, turnId: nativeTurn }, 4000).catch(() => child.kill("SIGTERM")) : Promise.resolve(child.kill("SIGTERM"))
    if (stopping) await activeInterrupt()
    else {
      const response = await rpc("turn/start", { threadId: thread, input: [{ type: "text", text: prompt, text_elements: [] }], ...(turn.model ? { model: turn.model } : {}), ...(turn.effort ? { effort: turn.effort } : {}) })
      nativeTurn ??= response.turn.id; state.nativeTurnId = nativeTurn; writeCodexDelivery(state)
      accepting = !completed && !closed && !stopping
      timer = setInterval(() => { inFlight = poll().catch((err) => fail(err.message)) }, 150)
      await ended
    }
  } catch (err) { fail(err.message) }
  finally {
    accepting = false; clearInterval(timer)
    // Wait for the request that raced turn/completed before deciding whether it was accepted.
    while (polling) await sleep(10)
    await inFlight
    const ok = !failure && completed?.status === "completed"
    state.terminal = ok ? "completed" : "interrupted"
    for (const entry of state.entries) {
      if (entry.state === "accepted") entry.state = ok && entry.incorporated ? "settled" : "uncertain"
      if (entry.state === "submitted") entry.state = "uncertain"
    }
    writeCodexDelivery(state)
    activeInterrupt = null
    child.stdin.end()
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await exited; clearTimeout(killer)
    await pending
  }
  const ctx = thread ? codexContext(codexHomeInUse(), thread) : null
  if (ctx) await emit({ t: "usage", tokens: ctx.tokens, window: ctx.window, turnId: turn.turnId })
  if (ctx?.rateLimits) await emit({ t: "limits", harness: "codex", rateLimits: ctx.rateLimits, at: ctx.rateLimitsAt ?? Date.now(), turnId: turn.turnId })
  // Rollout totals are read separately for context; billing uses only this native turn's usage notifications below.
  const ok = !failure && completed?.status === "completed"
  return { steerSubmitted: state.entries.some((e) => e.state !== "rejected"), exitCode: ok ? 0 : 1, startedAt, sessionId: thread, result: { result: reply, is_error: !ok, duration_ms: Date.now() - startedAt, usage: usageTotal ? claudeUsageOf(Object.fromEntries(Object.entries(usageTotal).map(([k, v]) => [k, Math.max(0, v - (usageBase?.[k] ?? 0))]))) : null }, usage: ctx,
    errorText: [state.entries.some((e) => e.state !== "rejected") ? "Mid-turn delivery recorded; automatic session reset is disabled." : "", failure || completed?.error?.message, codexErrorText(stderr)].filter(Boolean).join("\n") }
}

// ---------------------------------------------------------------------------
// Cursor (docs/cursor.md). The same turn with `cursor-agent -p --output-format stream-json`. Its chats, settings and
// per-project state live in the task's cursor/ (CURSOR_CONFIG_DIR and CURSOR_DATA_DIR), so they move with the task;
// its login doesn't (CURSOR_API_KEY, or this computer's `cursor-agent login`). Box Yard's tools come in as a plugin
// (--plugin-dir), and the owner's own MCP servers are switched off for the task. The CLI has no system prompt flag:
// Box Yard's instructions open a session's first prompt (and come again when they change). server/cursor.ts has the
// same arguments; test/cursor-task.e2e.test.ts keeps them in step.

const cursorHome = path.join(taskDir, "cursor")
const cursorPluginDir = path.join(taskDir, "cursor-plugin", "boxyard")
/** cursor-agent names a plugin's server `plugin-<plugin folder>-<server>`. */
const CURSOR_BOXYARD_SERVER = "plugin-boxyard-boxyard"

function cursorEnv() {
  const env = {
    ...turnBaseEnv(),
    IS_SANDBOX: "1",
    PORT: String(task.port ?? 4000),
    BOXYARD_TASK_ID: task.taskId,
    BOXYARD_TASK_DIR: taskDir,
    CURSOR_CONFIG_DIR: cursorHome,
    CURSOR_DATA_DIR: cursorHome,
    // A `usage` line after each model call: the context's size as the turn goes.
    CURSOR_EMIT_MODEL_CALL_USAGE: "1",
  }
  delete env.CLAUDE_CONFIG_DIR
  delete env.CODEX_HOME
  return env
}

/**
 * The CLI to run: task.json's, else `cursor-agent` on PATH, else where Cursor's installer puts it (~/.local/bin, which
 * a box's PATH may not have).
 */
function cursorBinary() {
  const bin = task.cursorBin || "cursor-agent"
  if (bin !== "cursor-agent") return bin
  const onPath = (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)))
  const installed = path.join(os.homedir(), ".local", "bin", "cursor-agent")
  return !onPath && fs.existsSync(installed) ? installed : bin
}

/** server/cursor.ts cursorAgentArgs for a task agent: no prompts to approve anything, and Box Yard's tools as a plugin. */
function cursorArgs({ sessionId, model }) {
  const args = ["-p", "--output-format", "stream-json", "--force", "--trust", "--approve-mcps", "--sandbox", "disabled", "--plugin-dir", cursorPluginDir]
  if (model) args.push("--model", model)
  // --resume with an id it hasn't seen starts a chat under that id, so Box Yard names the session as it does Claude's.
  args.push("--resume", sessionId)
  return args
}

const cursorSlug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
const realpath = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** The MCP servers cursor-agent would load besides Box Yard's: the owner's (~/.cursor), the repo's, and plugins'. */
function cursorOtherServers(workDir) {
  const names = new Set()
  const add = (file, prefix = "") => {
    const servers = readJson(file, null)?.mcpServers
    if (servers && typeof servers === "object") for (const name of Object.keys(servers)) names.add(`${prefix}${name}`)
  }
  const home = os.homedir()
  add(path.join(home, ".cursor", "mcp.json"))
  add(path.join(workDir, ".cursor", "mcp.json"))
  // Installed plugins: ~/.cursor/plugins/<cache|local>/…/<plugin>/[<version>/]mcp.json.
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.name === "mcp.json" && e.isFile())) {
      const manifest = readJson(path.join(dir, ".cursor-plugin", "plugin.json"), null)
      for (const plugin of new Set([manifest?.name, path.basename(dir), path.basename(path.dirname(dir))].filter((v) => typeof v === "string" && v))) add(path.join(dir, "mcp.json"), `plugin-${plugin}-`)
    }
    if (depth > 0) for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth - 1)
  }
  walk(path.join(home, ".cursor", "plugins"), 4)
  names.delete(CURSOR_BOXYARD_SERVER)
  return [...names]
}

/**
 * The task's Cursor folders: Box Yard's tools as a plugin, and every other MCP server switched off for the folder the
 * CLI runs in (its project dir is named after the path: the work dir, and the git root it may resolve to).
 */
function prepareCursor(workDir) {
  fs.mkdirSync(cursorHome, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(cursorPluginDir, ".cursor-plugin"), { recursive: true })
  fs.writeFileSync(path.join(cursorPluginDir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "boxyard", version: "1.0.0", description: "Box Yard's tools" }))
  fs.writeFileSync(path.join(cursorPluginDir, "mcp.json"), JSON.stringify({ mcpServers: { boxyard: { command: process.execPath, args: [process.argv[1], "mcp", taskDir] } } }))
  const off = cursorOtherServers(workDir)
  const roots = new Set([realpath(workDir)])
  try {
    const top = execFileSync("git", ["-C", workDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    if (top) roots.add(realpath(top))
  } catch {}
  for (const root of roots) {
    const dir = path.join(cursorHome, "projects", cursorSlug(root))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "mcp-disabled.json"), JSON.stringify(off))
  }
}

/**
 * Where cursor-agent keeps chat `id` for a run in `workDir`: `chats/<md5 of the folder>/<id>`. A task folder that
 * moved (another box, another path) has its chats under the old folder's hash; this moves the chat across. Returns
 * whether the chat is there to resume.
 */
function placeCursorChat(workDir, id) {
  const root = path.join(cursorHome, "chats")
  const want = path.join(root, createHash("md5").update(realpath(workDir)).digest("hex"), id)
  if (fs.existsSync(path.join(want, "store.db"))) return true
  let dirs = []
  try {
    dirs = fs.readdirSync(root)
  } catch {}
  for (const d of dirs) {
    const from = path.join(root, d, id)
    if (from === want || !fs.existsSync(path.join(from, "store.db"))) continue
    fs.mkdirSync(path.dirname(want), { recursive: true })
    fs.rmSync(want, { recursive: true, force: true })
    fs.renameSync(from, want)
    return true
  }
  return false
}

/** The instructions' fingerprint each session last read, so they come again only when they change. */
const cursorBriefFile = path.join(cursorHome, "boxyard-instructions.json")

/** The prompt for the CLI: Box Yard's instructions first, when this session hasn't read the current ones. */
function cursorPrompt(sessionId, prompt, instructions) {
  if (!instructions?.trim()) return { text: prompt, brief: null }
  const hash = createHash("sha256").update(instructions).digest("hex").slice(0, 16)
  const seen = readJson(cursorBriefFile, {})
  if (seen?.[sessionId] === hash) return { text: prompt, brief: null }
  return { text: `<boxyard_instructions>\n${instructions.trim()}\n</boxyard_instructions>\n\n${prompt}`, brief: hash }
}

function noteCursorBrief(sessionId, hash) {
  if (!hash) return
  const seen = readJson(cursorBriefFile, {}) ?? {}
  seen[sessionId] = hash
  fs.writeFileSync(cursorBriefFile, JSON.stringify(seen))
}

/** Cursor's per-run token counts in Claude's terms (server/cursor.ts cursorUsageOf): its inputTokens leave the cache out. */
function cursorUsageOf(u) {
  if (!u || typeof u !== "object") return null
  return {
    input_tokens: Number(u.inputTokens) || 0,
    cache_creation_input_tokens: Number(u.cacheWriteTokens) || 0,
    cache_read_input_tokens: Number(u.cacheReadTokens) || 0,
    output_tokens: Number(u.outputTokens) || 0,
  }
}

/** Claude Code's names for cursor-agent's built-in tools, so the chats label them the same way. */
const CURSOR_TOOL_NAMES = {
  shellToolCall: "Bash",
  readToolCall: "Read",
  editToolCall: "Edit",
  writeToolCall: "Write",
  deleteToolCall: "Delete",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "LS",
  webSearchToolCall: "WebSearch",
  webFetchToolCall: "WebFetch",
  updateTodosToolCall: "TodoWrite",
  readTodosToolCall: "TodoRead",
  taskToolCall: "Task",
}

/**
 * A cursor-agent `tool_call` as the Box Yard `tool` event Claude's would be: null for Box Yard's own (its events say
 * more) and for the CLI's tool lookups (getMcpToolsToolCall: it reads a tool's schema before calling it).
 */
function cursorTool(call) {
  const key = Object.keys(call ?? {}).find((k) => k.endsWith("ToolCall") || k === "function")
  if (!key || key === "getMcpToolsToolCall") return null
  const body = call[key] ?? {}
  const a = body.args ?? {}
  if (key === "mcpToolCall") {
    const server = String(a.providerIdentifier ?? a.serverName ?? a.server ?? "")
    if (server === CURSOR_BOXYARD_SERVER || server === "boxyard") return null
    const tool = String(a.toolName ?? a.name ?? "tool")
    return { key, name: `mcp__${server.replace(/^plugin-[^-]+-/, "") || "mcp"}__${tool}`, input: a.args ?? a.arguments ?? {} }
  }
  if (key === "function") return { key, name: String(body.name ?? "tool"), input: body.arguments ?? {} }
  const name = CURSOR_TOOL_NAMES[key] ?? key.replace(/ToolCall$/, "")
  const input =
    key === "shellToolCall"
      ? { command: String(a.command ?? "") }
      : key === "webSearchToolCall"
        ? { query: String(a.searchTerm ?? a.query ?? "") }
        : a.path !== undefined
          ? { file_path: String(a.path), ...(a.pattern ? { pattern: a.pattern } : {}) }
          : Object.fromEntries(Object.entries(a).filter(([k]) => k !== "toolCallId"))
  return { key, name, input }
}

/** A finished cursor-agent tool call's error text, or null when it worked. */
function cursorToolError(call) {
  const key = Object.keys(call ?? {}).find((k) => k.endsWith("ToolCall") || k === "function")
  const r = key ? call[key]?.result : null
  if (!r || typeof r !== "object") return null
  if (r.error) return String(r.error.errorMessage ?? r.error.message ?? (typeof r.error === "string" ? r.error : "The tool call failed."))
  if (r.failure) {
    const f = r.failure
    return String(f.stderr || f.interleavedOutput || f.stdout || f.message || `exit code ${f.exitCode ?? "?"}`).trim()
  }
  if (r.rejected) return String(r.rejected.reason ?? "The tool call was rejected.")
  // An MCP tool's own error: content blocks of { text: { text } }.
  if (r.success?.isError === true) return (r.success.content ?? []).map((c) => c?.text?.text ?? c?.text ?? "").join("\n").trim() || "The tool call failed."
  return null
}

/** What cursor-agent printed when it failed: its own error lines, without the stack traces. */
const cursorErrorText = (stderr) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s|^\s*\^/.test(l))
    .slice(-5)
    .join("\n")

function runCursor({ turn, sessionId, resume, prompt }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const workDir = path.join(taskDir, "work")
    try {
      prepareCursor(workDir)
    } catch (err) {
      resolve({ exitCode: 1, startedAt, result: null, usage: null, sessionId: null, errorText: `Couldn't set up Cursor: ${err.message}` })
      return
    }
    // The CLI starts a new chat for an id it doesn't have, so a lost one is caught here, as Claude Code would report it.
    if (resume && !placeCursorChat(workDir, sessionId)) {
      resolve({ exitCode: 1, startedAt, result: null, usage: null, sessionId: null, errorText: `No conversation found with session ID: ${sessionId}` })
      return
    }
    const brief = cursorPrompt(sessionId, prompt, turn.systemPrompt)
    const model = turn.model || null
    const bin = cursorBinary()
    let child
    try {
      child = spawn(bin, [...(task.cursorArgs ?? []), ...cursorArgs({ sessionId, model })], { cwd: workDir, env: cursorEnv(), stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      resolve({ exitCode: 1, startedAt, result: null, usage: null, sessionId: null, errorText: `Couldn't start cursor-agent: ${err.message}` })
      return
    }
    activeChild = child
    let result = null
    let reply = ""
    let usage = null
    let window = null
    let sawInit = false
    let modelLabel = null
    let stderr = ""
    let buf = ""
    let pending = Promise.resolve()
    const queue = (fn) => (pending = pending.then(fn).catch((e) => process.stderr.write(`${e.stack}\n`)))

    const onLine = (line) => {
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        queue(() => emit({ t: "log", text: clip(line, 1000) }))
        return
      }
      if (ev.type === "system" && ev.subtype === "init") {
        sawInit = true
        if (typeof ev.model === "string" && ev.model) modelLabel = ev.model
        // The init names the model by its label ("Claude Opus 5.5 1M High"), which may state its window.
        const m = /\b(\d+(?:\.\d+)?)\s*([KM])\b/i.exec(String(ev.model ?? ""))
        const n = m ? Number(m[1]) * (m[2].toUpperCase() === "M" ? 1_000_000 : 1_000) : 0
        window = n >= 8_000 ? Math.round(n) : null
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type !== "text" || !block.text?.trim()) continue
          reply = block.text
          queue(() => emit({ t: "assistant", text: block.text }))
        }
      } else if (ev.type === "tool_call" && ev.subtype === "started") {
        const tool = cursorTool(ev.tool_call)
        if (tool) queue(() => emit({ t: "tool", name: tool.name, input: clip(tool.input, 400) }))
      } else if (ev.type === "tool_call" && ev.subtype === "completed") {
        const tool = cursorTool(ev.tool_call)
        const error = tool ? cursorToolError(ev.tool_call) : null
        if (error) queue(() => emit({ t: "tool_error", text: clip(error, 400) }))
      } else if (ev.type === "usage" && ev.usage) {
        // One model call: what it read (cached or not) and wrote is the context now.
        const u = cursorUsageOf(ev.usage)
        const tokens = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens
        if (tokens > 0 && tokens !== usage?.tokens) {
          usage = { tokens, window }
          queue(() => emit({ t: "usage", tokens, window }))
        }
      } else if (ev.type === "result") result = ev
    }

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) onLine(line)
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000)
    })
    child.on("error", (err) => {
      stderr +=
        err.code === "ENOENT"
          ? `\nCursor's CLI isn't installed here (${bin} wasn't found). Install it: curl https://cursor.com/install -fsS | bash`
          : `\n${err.message}`
    })
    child.on("close", (code, signal) => {
      if (buf.trim()) onLine(buf)
      buf = ""
      pending.then(() => {
        const killed = code === null && signal ? `cursor-agent was killed (${signal})` : ""
        const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)
        const isError = !result || result.is_error === true || result.subtype !== "success"
        // The session read the instructions once the CLI took the prompt.
        if (sawInit) noteCursorBrief(sessionId, brief.brief)
        resolve({
          exitCode,
          startedAt,
          sessionId,
          result: {
            result: reply || (typeof result?.result === "string" ? result.result : ""),
            is_error: isError,
            duration_ms: typeof result?.duration_ms === "number" ? result.duration_ms : Date.now() - startedAt,
            usage: cursorUsageOf(result?.usage),
            // The model it ran, by its label: the usage ledger's name for it when Box Yard passed no --model.
            model: modelLabel,
          },
          usage,
          errorText: [isError && typeof result?.result === "string" && result.is_error ? result.result : "", cursorErrorText(stderr), killed].filter(Boolean).join("\n"),
        })
      })
    })

    child.stdin.on("error", () => {})
    child.stdin.end(brief.text)
  })
}

// OpenCode v1.19.5: run.ts emits completed text/tool/step parts as JSON lines.
// All CLI state lives with the task; API auth is supplied in memory, never copied into that state.
function openCodeEnv() {
  const env = { ...turnBaseEnv() }
  const nativeData = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  // Ignore inherited CLI routing/config and isolate plugins/MCP, session DB, caches and logs.
  for (const k of Object.keys(env)) if (k.startsWith("OPENCODE_")) delete env[k]
  for (const k of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const dir = path.join(taskDir, "opencode", k.slice(4, -5).toLowerCase())
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    env[k] = dir
  }
  const supplied = task.env?.OPENCODE_AUTH_CONTENT
  if (supplied) env.OPENCODE_AUTH_CONTENT = supplied
  else if (task.opencodeHostLogin) {
    const auth = readJson(path.join(nativeData, "opencode", "auth.json"), {})
    if (!Object.keys(auth).length || Object.values(auth).some((v) => v?.type !== "api" || typeof v.key !== "string" || !v.key)) throw new Error("OpenCode needs provider API logins. OAuth logins are not supported; add API entries in Settings › Credentials › OpenCode API logins.")
    env.OPENCODE_AUTH_CONTENT = JSON.stringify(auth)
  } else env.OPENCODE_AUTH_CONTENT = "{}"
  if (task.env?.OPENCODE_API_KEY) env.OPENCODE_API_KEY = task.env.OPENCODE_API_KEY
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    snapshot: false,
    permission: { "*": "allow", question: "deny", task: "deny", plan_enter: "deny", plan_exit: "deny" },
    mcp: { boxyard: { type: "local", command: [process.execPath, process.argv[1], "mcp", taskDir], enabled: true } },
  })
  env.NO_COLOR = "1"
  return env
}

function openCodeArgs(model, session) {
  const args = ["run", "--format", "json", "--auto", "--pure"]
  if (model) {
    if (!/^[a-zA-Z0-9_.-]+\/[^\s/#]+(?:\/[^\s#]+)*(?:#[^\s#]+)?$/.test(model)) throw new Error("OpenCode models use provider/model or provider/model#variant. Run `opencode models` on the runner to list them.")
    const [id, variant] = model.split("#")
    args.push("--model", id)
    if (variant) args.push("--variant", variant)
  }
  if (session) args.push("--session", session)
  return args
}

function openCodeBinary() {
  if (task.opencodeBin && task.opencodeBin !== "opencode") return task.opencodeBin
  const managed = path.join(os.homedir(), ".boxyard-tools", "opencode", "node_modules", ".bin", "opencode")
  return fs.existsSync(managed) ? managed : "opencode"
}

async function runOpenCode({ turn, sessionId, resume, prompt }) {
  const startedAt = Date.now()
  const failed = (errorText) => ({ exitCode: 1, startedAt, result: { result: "", is_error: true, duration_ms: Date.now() - startedAt }, usage: null, sessionId: null, errorText })
  let env, args
  const bin = openCodeBinary()
  try {
    env = openCodeEnv()
    args = openCodeArgs(turn.model || null, resume ? sessionId : null)
  } catch (e) { return failed(e.message) }
  const pre = task.opencodeArgs ?? []
  const version = spawnSync(bin, [...pre, "--version"], { env, encoding: "utf8", timeout: 10_000 })
  if (version.error?.code === "ENOENT") return failed("OpenCode isn't installed on this runner. Install npm install -g opencode-ai@1.19.5 on this computer or SSH machine, then test it again. Managed sandboxes install it on first use.")
  if (version.status !== 0 || !/^1\.19\.5(?:\s|$)/.test(version.stdout?.trim() ?? "")) return failed("OpenCode 1.19.5 is required. Other CLI versions, including v2, have not been verified. Install npm install -g opencode-ai@1.19.5, then test again.")
  // v1 silently ignores unknown variants. Verify its own catalog before any generation request.
  if (turn.model?.includes("#")) {
    const [id, variant] = turn.model.split("#")
    const catalog = spawnSync(bin, [...pre, "models", id.split("/")[0], "--verbose", "--pure"], { cwd: path.join(taskDir, "work"), env, encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
    if (catalog.status !== 0) return failed("OpenCode couldn't verify the requested variant. Check the provider API login and `opencode models <provider> --verbose` on this runner; no generation was requested.")
    // models.ts prints an unindented id line followed by a pretty-printed JSON model object.
    const lines = catalog.stdout.split("\n")
    const at = lines.indexOf(id)
    const end = lines.findIndex((line, i) => i > at && line === "}")
    let model
    try { if (at >= 0 && end > at) model = JSON.parse(lines.slice(at + 1, end + 1).join("\n")) } catch {}
    if (!model || !Object.hasOwn(model.variants ?? {}, variant)) return failed(`OpenCode model ${id} does not list variant ${variant}. Choose one from \`opencode models ${id.split("/")[0]} --verbose\`; no generation was requested.`)
  }
  return new Promise((resolve) => {
    const child = spawn(bin, [...pre, ...args], { cwd: path.join(taskDir, "work"), env, stdio: ["pipe", "pipe", "pipe"] })
    activeChild = child
    let buf = "", stderr = "", reply = "", failure = "", nativeSession = null, usage = null
    let cost = 0, sawStep = false, finishReason = null
    const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const seen = new Set()
    let pending = Promise.resolve()
    const queue = (event) => { pending = pending.then(() => emit(event)).catch((e) => { failure = clean(e.message) }) }
    // Do not echo raw CLI stdout/stderr that may contain credential material.
    const secrets = [...Object.values(task.env ?? {}), env.OPENCODE_AUTH_CONTENT].filter((v) => typeof v === "string" && v.length > 3)
    try { for (const v of Object.values(JSON.parse(env.OPENCODE_AUTH_CONTENT || "{}"))) if (v?.key) secrets.push(v.key) } catch {}
    const clean = (text) => { let out = String(text); for (const secret of secrets) out = out.split(secret).join("[redacted]"); return out }
    const onLine = (line) => {
      let ev
      try { ev = JSON.parse(line) } catch { failure = "OpenCode emitted malformed JSON output"; return }
      if (typeof ev?.sessionID !== "string" || !/^ses_[A-Za-z0-9]+$/.test(ev.sessionID)) { failure = "OpenCode emitted an invalid session event"; return }
      if (resume && ev.sessionID !== sessionId) { failure = "OpenCode did not resume the requested session"; return }
      if (nativeSession && ev.sessionID !== nativeSession) { failure = "OpenCode emitted events for a different session"; return }
      nativeSession = ev.sessionID
      const part = ev.part
      if (part?.id && seen.has(`${ev.type}:${part.id}`)) return
      if (part?.id) seen.add(`${ev.type}:${part.id}`)
      if (ev.type === "text" && typeof part?.text === "string") {
        reply += part.text
        queue({ t: "assistant", text: clean(part.text) })
      } else if (ev.type === "tool_use" && typeof part?.tool === "string") {
        // Box Yard's worker emits its own events for these tools.
        if (!part.tool.startsWith("boxyard_")) {
          const names = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", apply_patch: "Edit", glob: "Glob", grep: "Grep", webfetch: "WebFetch" }
          queue({ t: "tool", name: names[part.tool] || part.tool, input: clip(clean(JSON.stringify(part.state?.input ?? {})), 400) })
          if (part.state?.status === "error") queue({ t: "tool_error", text: clip(clean(part.state.error || "Tool failed"), 400) })
        }
      } else if (ev.type === "error") {
        failure = clean(ev.error?.data?.message || ev.error?.message || ev.error?.name || "OpenCode reported an error")
      } else if (ev.type === "step_finish" && part?.tokens) {
        sawStep = true
        finishReason = part.reason
        const n = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
        const u = { input_tokens: n(part.tokens.input), output_tokens: n(part.tokens.output) + n(part.tokens.reasoning), cache_read_input_tokens: n(part.tokens.cache?.read), cache_creation_input_tokens: n(part.tokens.cache?.write) }
        for (const k of Object.keys(totals)) totals[k] += u[k]
        cost += n(part.cost)
        usage = { tokens: Object.values(u).reduce((a, b) => a + b, 0), window: null }
        queue({ t: "usage", ...usage })
        if (part.reason === "length") failure = "OpenCode reached the model output limit; continue this task to resume."
      }
    }
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      buf += chunk
      const lines = buf.split("\n"); buf = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) onLine(line)
    })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000) })
    child.on("error", (e) => { failure = clean(e.message) })
    child.on("close", (code, signal) => {
      if (buf.trim()) onLine(buf)
      pending.then(() => resolve({
        exitCode: code ?? 1, startedAt, sessionId: nativeSession, usage,
        result: { result: clean(reply), is_error: Boolean(failure) || !sawStep || !nativeSession || finishReason !== "stop", total_cost_usd: sawStep ? cost : null, duration_ms: Date.now() - startedAt, usage: totals },
        errorText: [failure, clean(stderr).trim(), signal ? `OpenCode was killed (${signal})` : "", sawStep && finishReason !== "stop" ? `OpenCode ended with finish reason ${String(finishReason)}; continue the task after checking the provider response.` : "", !sawStep ? "OpenCode ended without a completed step. Check the provider API login and model; run `opencode models` on this runner." : ""].filter(Boolean).join("\n"),
      }), (e) => resolve(failed(clean(e.message))))
    })
    child.stdin.on("error", () => {})
    child.stdin.end(`<boxyard_instructions>\n${turn.systemPrompt || ""}\n</boxyard_instructions>\n\n${prompt}`)
  })
}

// TurnClock: a copy of server/turnTimings.ts's TurnClock (the box never calls the server, so the turn is timed here).
// test/turn-timings.test.ts runs both on the same streams; change them together.

const TURN_TIMING_MAX_STEPS = 300

class TurnClock {
  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt
    this.readyAt = null
    this.mcpStatus = null
    this.firstTokenAt = null
    this.resultAt = null
    this.stepStart = null
    this.stepLast = null
    this.lastToolEnd = null
    this.open = new Map()
    this.ids = new Set()
    this.steps = []
    this.dropped = 0
    this.toolSpans = []
    this.result = null
    this.contextTokens = null
  }

  get ready() {
    return this.readyAt
  }

  line(msg, at = Date.now()) {
    if (!msg || typeof msg !== "object" || msg.parent_tool_use_id) return
    if (msg.type === "system" && msg.subtype === "init") {
      if (this.readyAt !== null) return
      this.readyAt = at
      if (Array.isArray(msg.mcp_servers) && msg.mcp_servers.length) {
        this.mcpStatus = msg.mcp_servers.map((s) => `${s?.name ?? "?"}: ${s?.status ?? "?"}`).join(", ")
      }
      return
    }
    if (msg.type === "stream_event") {
      if (this.firstTokenAt === null && msg.event?.type === "content_block_delta") this.firstTokenAt = at
      return
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      if (msg.message.model === "<synthetic>") return
      if (this.firstTokenAt === null) this.firstTokenAt = at
      if (typeof msg.message.id === "string") this.ids.add(msg.message.id)
      const u = msg.message.usage
      if (u) {
        const n = (clockNum(u.input_tokens) ?? 0) + (clockNum(u.cache_creation_input_tokens) ?? 0) + (clockNum(u.cache_read_input_tokens) ?? 0) + (clockNum(u.output_tokens) ?? 0)
        if (n > 0) this.contextTokens = n
      }
      if (this.stepStart === null) this.stepStart = this.lastToolEnd ?? this.readyAt ?? this.startedAt
      this.stepLast = at
      for (const b of msg.message.content) {
        if (b?.type === "tool_use" && typeof b.id === "string") this.open.set(b.id, { name: clockToolName(b.name), at })
      }
      return
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b?.type !== "tool_result") continue
        const call = this.open.get(b.tool_use_id)
        if (!call) continue
        this.closeModel()
        this.open.delete(b.tool_use_id)
        this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
        this.toolSpans.push([call.at, at])
        this.lastToolEnd = at
      }
      return
    }
    if (msg.type === "result") {
      this.resultAt = at
      this.result = msg
      this.closeModel()
    }
  }

  push(step) {
    if (this.steps.length < TURN_TIMING_MAX_STEPS) this.steps.push(step)
    else this.dropped++
  }

  closeModel() {
    if (this.stepStart === null || this.stepLast === null) return
    this.push({ k: "model", at: this.stepStart - this.startedAt, ms: Math.max(0, this.stepLast - this.stepStart) })
    this.stepStart = null
    this.stepLast = null
  }

  finish(ok, at = Date.now()) {
    this.closeModel()
    for (const call of this.open.values()) {
      this.push({ k: "tool", name: call.name, at: call.at - this.startedAt, ms: Math.max(0, at - call.at) })
      this.toolSpans.push([call.at, at])
    }
    this.open.clear()
    const r = this.result
    const u = r?.usage ?? {}
    const steps = this.steps
    return {
      startedAt: this.startedAt,
      endedAt: at,
      startupMs: this.readyAt === null ? null : this.readyAt - this.startedAt,
      mcpStatus: this.mcpStatus,
      firstTokenMs: this.firstTokenAt === null ? null : this.firstTokenAt - (this.readyAt ?? this.startedAt),
      modelMs: steps.reduce((n, s) => (s.k === "model" ? n + s.ms : n), 0),
      toolMs: clockUnionMs(this.toolSpans),
      modelCalls: this.ids.size || steps.filter((s) => s.k === "model").length,
      toolCalls: this.toolSpans.length,
      tailMs: this.resultAt === null ? null : Math.max(0, at - this.resultAt),
      wallMs: Math.max(0, at - this.startedAt),
      cliMs: clockNum(r?.duration_ms),
      apiMs: clockNum(r?.duration_api_ms),
      numTurns: clockNum(r?.num_turns),
      inputTokens: clockNum(u.input_tokens) ?? 0,
      outputTokens: clockNum(u.output_tokens) ?? 0,
      cacheReadTokens: clockNum(u.cache_read_input_tokens) ?? 0,
      cacheWriteTokens: clockNum(u.cache_creation_input_tokens) ?? 0,
      contextTokens: this.contextTokens,
      ok,
      steps,
      stepsDropped: this.dropped,
    }
  }
}

function clockNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function clockToolName(name) {
  return String(name ?? "?").replace(/^mcp__boxyard__/, "")
}

function clockUnionMs(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let end = -Infinity
  for (const [a, b] of s) {
    if (b <= end) continue
    total += b - Math.max(a, end)
    end = b
  }
  return total
}

// end TurnClock

// ---------------------------------------------------------------------------
// MCP mode: newline-delimited JSON-RPC over stdio.

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "The rule, in one or two sentences." },
    why: { type: "string", description: "What a future agent would get wrong without it." },
  },
  required: ["content", "why"],
}

const TOOLS = [
  {
    name: "ask_user",
    description:
      "Ask Cody (the human) a question when you need a decision, credentials, or information you cannot find. After calling this, end your turn; the answer arrives as your next message.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "One clear question, with the options if there are any." } },
      required: ["question"],
    },
  },
  {
    name: "list_agents",
    description: "List the other Box Yard agents (tasks), their projects and status, so you can coordinate with them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_agent",
    description:
      "Send a message to another agent by task id. Set expect_reply to true if you need an answer; then end your turn and the reply will arrive as your next message. Set fyi: true for informational notes: they appear in the recipient's log without queuing or starting a turn. Questions and requests should leave fyi off.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Task id of the other agent (from list_agents)." },
        message: { type: "string" },
        expect_reply: { type: "boolean", default: false },
        fyi: { type: "boolean", default: false, description: "Log only; no turn input. Ignored when expect_reply is true." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "message_captain",
    description:
      "Message your project's Captain (the agent that runs this project for Cody) without ending your turn: a scope or project question, a conflict with another task, or a bug you found outside your brief. " +
      "By default it returns at once and you keep working; any reply arrives as your next message. Set wait_seconds (at most 60) to wait briefly for the answer: it returns as soon as the Captain replies. " +
      "Set fyi: true for informational notes: they appear in the Captain's view without queuing or starting a turn. Questions and requests should leave fyi off. " +
      "Use ask_user instead when only Cody can decide, and message_agent to talk to another agent. Limited to 5 messages per 10 minutes.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Self-contained: what you found or need, and the options if there are any." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 60, default: 0, description: "0 (default): don't wait. Up to 60: wait that long for the reply." },
        fyi: { type: "boolean", default: false, description: "Log only; no turn input. Ignored when wait_seconds is positive." },
      },
      required: ["message"],
    },
  },
  {
    name: "suggest_note",
    description:
      "Suggest a lasting rule for the project's notes, which every future agent in this project starts with. The project's Captain curates them when your task is finished, so this is a suggestion, not a save. " +
      "Only for environment or box gotchas, Cody's decisions and preferences, and project facts that aren't in the code. Run logs, merge reports and code tours go in the PR description instead.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: "save_note",
    description: "Old name of suggest_note: suggests a project note for the Captain to curate. Use suggest_note.",
    inputSchema: NOTE_SCHEMA,
  },
  {
    name: "read_notes",
    description: "Read the project's notes: the lasting rules Cody and the project's Captain keep.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "compaction_history",
    description: "Browse this task's retained saved compaction recaps: dated topics, descriptions, total, coverage and nextBefore. No other task/project is accessible. Use read_compaction level=summary, then level=full as needed. Native provider auto-compactions are not exported as saved recaps.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      before: { type: "string", description: "nextBefore from the previous page or exclusive ISO time" },
      since: { type: "string", description: "Inclusive ISO date/time" }, until: { type: "string", description: "Inclusive ISO date/time" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    } },
  },
  {
    name: "read_compaction",
    description: "Read a compaction id from this task's compaction_history. Default summary is a bounded extractive excerpt. level=full reads the saved recap in bounded chunks; pass nextOffset verbatim until null.",
    inputSchema: { type: "object", additionalProperties: false, required: ["compaction"], properties: {
      compaction: { type: "string" }, level: { type: "string", enum: ["summary", "full"] },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 16000 },
    } },
  },
  {
    name: "create_pull_request",
    description:
      "Push the current branch and open a GitHub pull request; if one is open, update its title and body. Commit your changes first. Screenshots: publish them with publish_artifact and put their /artifacts/ links in the body; this copies them to the repo's pr-assets branch so GitHub shows them.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Markdown summary of the change and how it was tested. Images can link /artifacts/ URLs from publish_artifact." },
        draft: { type: "boolean", default: false },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "report_preview",
    description:
      "Tell Box Yard a server is listening on a port so it can give Cody a public preview URL. Start the server in the background first (nohup ... &) and bind 0.0.0.0. Use $PORT to $PORT+9.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "integer" }, label: { type: "string" } },
      required: ["port"],
    },
  },
  {
    name: "publish_artifact",
    description:
      "Publish a file you made (report, image, HTML page, PDF, zip...) so Box Yard hosts it for Cody. Max 25 MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working directory, or absolute." },
        title: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "spawn_subtasks",
    description:
      "Start sub-agents: each sub-task is a task of its own (its own session and transcript, shown nested under yours) that works on its prompt and reports back to you when it finishes. " +
      "Use it when the work splits into independent parts, or when asked to use N sub-agents (start exactly N, in one call). Returns each sub-task's id and link. " +
      "Then call wait_for_subtasks, or end your turn: their reports arrive as your next message. Sub-tasks can start their own, down to the depth limit.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          description: "The sub-tasks to start, all at once.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short, specific title." },
              prompt: { type: "string", description: "Self-contained instructions: it doesn't see your conversation. Say what its report should contain." },
              runs_on: {
                type: "string",
                enum: ["same", "box", "local", "docker", "gpu", "ssh"],
                default: "same",
                description: '"same" (default): where you run, in your slot. Or a runner: an Upstash box, this computer, the project\'s Docker container, GPU pod or SSH machines.',
              },
            },
            required: ["title", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "wait_for_subtasks",
    description:
      "Wait for your sub-tasks' reports and return them. By default it returns once every sub-task (or each one in ids) has reported or timeout_seconds pass; until: \"any\" returns at the first new report. " +
      "timeout_seconds 0 just reports where they stand. Reports it returns don't come again as your next message.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Only these sub-tasks (default: all of yours)." },
        until: { type: "string", enum: ["all", "any"], default: "all" },
        timeout_seconds: { type: "integer", minimum: 0, maximum: 1800, default: 600 },
      },
    },
  },
  {
    name: "message_parent",
    description: "Send the task that started you (your parent) an update or question mid-turn. Your final message already goes to it as your report, so use this for news it needs before then. fyi: true logs it without starting a turn.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" }, fyi: { type: "boolean", default: false } },
      required: ["message"],
    },
  },
  {
    name: "cancel_subtasks",
    description: "Stop sub-tasks you no longer need (and theirs). They rest for Cody's review and don't report. Without ids: every one still running.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "finish",
    description:
      'Say your work is finished and ready for Cody to review, with a short summary of the outcome. Use when no PR is needed or after the PR is up and nothing is left. The task rests as ready for review: only Cody marks a task done. For a scheduled run that found nothing to do and changed nothing (no commits, PR, artifact, preview or question), pass outcome "noop" so Box Yard files it as a quiet run instead of notifying Cody.',
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        outcome: { type: "string", enum: ["noop"], description: 'Only "noop": this run found nothing to do and changed nothing.' },
      },
      required: ["summary"],
    },
  },
]

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: path.join(taskDir, "work"), env: turnBaseEnv(), maxBuffer: 10 << 20, ...opts }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    )
  })
}

/** Server-polled request/reply: works on local, SSH and hosted runners without a worker->server connection. */
async function compactionHistory(tool, args) {
  const turnId = currentTurnId()
  if (!turnId) return text("No active turn for compaction history.", true)
  const id = `hist_${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const file = path.join(taskDir, `history-reply-${id}.json`)
  await emit({ t: "compaction_history", id, request: { tool, args } })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const reply = readJson(file, null)
    if (reply?.turnId === turnId) {
      try { fs.rmSync(file, { force: true }) } catch {}
      return reply.error ? text(reply.error, true) : text(JSON.stringify(reply.data))
    }
    await sleep(400)
  }
  return text("Compaction history timed out waiting for the server poll. Retry the same request; saved history is unchanged.", true)
}

async function liveDirectory() {
  if (task.redis?.url) {
    const raw = await redis(["GET", "boxyard:directory"])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).directory ?? []
}

async function liveNotes() {
  if (task.redis?.url) {
    const raw = await redis(["GET", `boxyard:notes:${task.projectId}`])
    if (raw) {
      try {
        return JSON.parse(raw)
      } catch {}
    }
  }
  return readJson(path.join(taskDir, "turn.json"), {}).notes ?? []
}

async function callTool(name, args = {}) {
  switch (name) {
    case "ask_user": {
      if (!args.question?.trim()) return text("question is required", true)
      await emit({ t: "ask_user", question: args.question.trim() })
      return text(owner("Your question was sent to Cody. End your turn now; the answer will arrive as your next message."))
    }
    case "list_agents": {
      const agents = (await liveDirectory()).filter((a) => a.id !== task.taskId)
      if (!agents.length) return text("No other agents right now.")
      return text(agents.map((a) => `- ${a.id} | ${a.title} | project: ${a.project} | ${a.status}`).join("\n"))
    }
    case "message_agent": {
      if (!args.to || !args.message) return text("to and message are required", true)
      if (args.to === task.taskId) return text("That's you.", true)
      const fyi = args.fyi === true && !args.expect_reply
      await emit({ t: "message_agent", to: String(args.to), message: String(args.message), expectReply: Boolean(args.expect_reply), fyi })
      return text(
        args.expect_reply
          ? "Message sent. End your turn now; the reply will arrive as your next message."
          : fyi ? "FYI sent to the recipient's log; it won't queue or start a turn." : "Message sent.",
      )
    }
    case "message_captain":
      return messageCaptain(args)
    case "suggest_note":
    case "save_note": {
      if (!args.content?.trim()) return text("content is required", true)
      if (!args.why?.trim()) return text("why is required: what would a future agent get wrong without this note?", true)
      await emit({ t: "note", content: args.content.trim(), why: args.why.trim() })
      return text("Suggested. The project's Captain decides whether it becomes a note when your task is finished.")
    }
    case "read_notes": {
      const notes = await liveNotes()
      if (!notes.length) return text("No notes yet.")
      return text(notes.map((n) => `- (${n.author}) ${n.content}`).join("\n"))
    }
    case "compaction_history":
    case "read_compaction":
      return compactionHistory(name, args)
    case "create_pull_request":
      return createPullRequest(args)
    case "report_preview": {
      const port = Number(args.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return text("port must be an integer 1-65535", true)
      await emit({ t: "preview", port, label: args.label ? String(args.label) : `Port ${port}` })
      return text(owner(`Preview registered for port ${port}. Box Yard will show Cody the public URL. Keep the server running.`))
    }
    case "publish_artifact": {
      const p = path.resolve(path.join(taskDir, "work"), String(args.path ?? ""))
      let stat
      try {
        stat = fs.statSync(p)
      } catch {
        return text(`File not found: ${p}`, true)
      }
      if (!stat.isFile()) return text(`${p} is not a file`, true)
      if (stat.size > 25 * 1024 * 1024) return text("File is over 25 MB; compress or split it.", true)
      // Same rules as the server's safeFilename, so the URL we hand out is the real one.
      const filename = path.basename(p).replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120) || "file"
      const id = `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`
      const url = `${task.publicUrl ? task.publicUrl.replace(/\/$/, "") : ""}/artifacts/${id}/${encodeURIComponent(filename)}`
      // sha256: create_pull_request only copies the file to GitHub while it's still what was published.
      const sha256 = createHash("sha256").update(fs.readFileSync(p)).digest("hex")
      await emit({ t: "artifact", id, path: p, title: args.title ? String(args.title) : path.basename(p), size: stat.size, sha256 })
      return text(`Published ${filename}. Box Yard will host it at ${url} (live within a few seconds). Share that link.`)
    }
    case "spawn_subtasks":
      return spawnSubtasks(args)
    case "wait_for_subtasks":
      return waitForSubtasks(args)
    case "message_parent": {
      if (!task.parentTaskId) return text("You have no parent task: you weren't started by spawn_subtasks.", true)
      if (!String(args.message ?? "").trim()) return text("message is required", true)
      const fyi = args.fyi === true
      await emit({ t: "message_parent", message: String(args.message).trim(), fyi })
      return text(fyi ? "FYI sent to your parent's log." : "Sent to your parent task; it reads it on its next turn (or in its wait).")
    }
    case "cancel_subtasks": {
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : null
      const kids = subtaskState().children.filter((c) => (ids ? ids.includes(c.id) : LIVE_SUBTASK.includes(c.status)))
      if (!kids.length) return text(ids ? "None of those are your sub-tasks." : "No sub-tasks of yours are running.")
      await emit({ t: "cancel_subtasks", ids: kids.map((c) => c.id) })
      return text(`Cancelling ${kids.length}: ${kids.map((c) => `${c.title} (${c.id})`).join(", ")}. They won't report.`)
    }
    case "finish": {
      if (task.agent === "codex") {
        const turnId = currentTurnId()
        const journal = readJson(path.join(taskDir, `codex-delivery-${turnId}.json`), null)
        const pending = fs.readdirSync(taskDir).some((f) => STEER_FILE.test(f) && readJson(path.join(taskDir, f), null)?.turnId === turnId) ||
          journal?.entries?.some((e) => e.state === "submitted" || e.state === "uncertain" || e.state === "accepted" && !e.incorporated)
        if (pending) return text("Instructions are pending delivery. Read the follow-up before finishing; acceptance alone does not confirm processing.", true)
      }
      const running = subtaskState().children.filter((c) => LIVE_SUBTASK.includes(c.status))
      if (running.length) {
        return text(
          `Not finished: ${running.length} sub-task${running.length === 1 ? " is" : "s are"} still running (${running.map((c) => `${c.title} (${c.id})`).join(", ")}). Call wait_for_subtasks for their reports, or cancel_subtasks if you don't need them.`,
          true,
        )
      }
      const summary = String(args.summary ?? "").trim() || "Finished."
      // The task rests as ready for review (idle, or PR ready): only Cody marks it done (server/tasks.ts finishTurn).
      if (args.outcome === undefined || args.outcome === null || args.outcome === "") {
        await emit({ t: "finish", summary })
        return text(owner("Ready for Cody's review. End your turn."))
      }
      if (args.outcome !== "noop") return text('outcome must be "noop" (or left out)', true)
      // Box Yard checks the noop mark against what the run did; commits are only visible from here.
      await emit({ t: "finish", summary, outcome: "noop", commits: await unpushedWork() })
      return text("Finished as a no-op run. Box Yard hides it unless the run changed something. End your turn.")
    }
    default:
      return text(`Unknown tool ${name}`, true)
  }
}

// Sub-tasks (server/subtasks.ts). The server checks the limits and creates them; it answers spawn_subtasks in
// subtasks-reply-<id>.json and keeps subtasks.json (each sub-task's status and latest report) up to date.
const LIVE_SUBTASK = ["queued", "starting", "working", "waiting"]
const SPAWN_REPLY_WAIT_MS = 60_000
const subtasksFile = path.join(taskDir, "subtasks.json")
/** Reports wait_for_subtasks already returned, by input id, so the same one never comes back twice. */
const subtasksSeenFile = path.join(taskDir, "subtasks-seen.json")
const subtaskState = () => {
  const state = readJson(subtasksFile, null)
  return state && Array.isArray(state.children) ? state : { children: [] }
}
const subtaskId = () => `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`

async function spawnSubtasks(args) {
  const list = Array.isArray(args.tasks) ? args.tasks : args.title ? [args] : []
  if (!list.length) return text("tasks is required: [{ title, prompt, runs_on? }]", true)
  const tasks = []
  for (const [i, t] of list.entries()) {
    const title = String(t?.title ?? "").trim()
    const prompt = String(t?.prompt ?? "").trim()
    if (!title || !prompt) return text(`Sub-task ${i + 1} needs a title and a prompt.`, true)
    tasks.push({ id: subtaskId(), title, prompt, runsOn: t.runs_on ? String(t.runs_on) : "same" })
  }
  const id = `sub_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  await emit({ t: "spawn_subtasks", id, tasks })
  const file = path.join(taskDir, `subtasks-reply-${id}.json`)
  const deadline = Date.now() + SPAWN_REPLY_WAIT_MS
  while (Date.now() < deadline) {
    const answer = readJson(file, null)
    if (answer && typeof answer.status === "string") {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      if (answer.status !== "ok") return text(`Not started: ${answer.text ?? "Box Yard refused them."}`, true)
      const lines = (answer.tasks ?? []).map((t) => `- [${t.title}](${t.url}) (${t.id}, runs on ${t.runsOn})`)
      return text(
        `Started ${lines.length} sub-task${lines.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n\nThey report back to you when they finish. Call wait_for_subtasks to wait for the reports, or end your turn: they arrive as your next message. Link them in your answer.`,
      )
    }
    await sleep(300)
  }
  return text(
    `Asked for ${tasks.length} sub-tasks (${tasks.map((t) => `${t.title}: ${t.id}`).join(", ")}), but Box Yard hasn't confirmed them yet. wait_for_subtasks with timeout_seconds 0 shows whether they started.`,
  )
}

async function waitForSubtasks(args) {
  const ids = Array.isArray(args.ids) && args.ids.length ? args.ids.map(String) : null
  const any = args.until === "any"
  const timeout = Math.max(0, Math.min(1800, Math.round(Number(args.timeout_seconds ?? 600)) || 0))
  const deadline = Date.now() + timeout * 1000
  const seen = new Set(readJson(subtasksSeenFile, []))
  for (;;) {
    const kids = subtaskState().children.filter((c) => !ids || ids.includes(c.id))
    if (!kids.length) return text(ids ? "None of those are your sub-tasks (yet: a just-started one shows within a few seconds)." : "You have no sub-tasks.")
    const fresh = kids.filter((c) => c.report && !c.report.delivered && !seen.has(c.report.inputId))
    const live = kids.filter((c) => LIVE_SUBTASK.includes(c.status))
    if (!live.length || (any && fresh.length) || Date.now() >= deadline) {
      if (fresh.length) {
        fs.writeFileSync(subtasksSeenFile, JSON.stringify([...seen, ...fresh.map((c) => c.report.inputId)].slice(-500)))
        await emit({ t: "subtask_reports_taken", inputIds: fresh.map((c) => c.report.inputId) })
      }
      const reports = fresh.map((c) => `## ${c.title} (${c.id}, ${c.report.status})\n${c.url}\n\n${c.report.text || "(no reply)"}`)
      const state = kids.map((c) => `- ${c.title} (${c.id}): ${c.status}${c.report ? "" : " (no report yet)"}`)
      const head = live.length
        ? `${live.length} of ${kids.length} still running${Date.now() >= deadline && timeout ? ` after ${timeout} s` : ""}. Their reports arrive as your next message if you end your turn; or call wait_for_subtasks again.`
        : `All ${kids.length} have reported.`
      return text([head, "", ...state, ...(reports.length ? ["", "New reports:", "", reports.join("\n\n")] : [])].join("\n"))
    }
    await sleep(1000)
  }
}

// message_captain limits. The server (shared/captain.ts) enforces the same numbers.
const CAPTAIN_MSG_LIMIT = 5
const CAPTAIN_MSG_WINDOW_MS = 10 * 60_000
const CAPTAIN_WAIT_MAX_SECONDS = 60
const captainSentFile = path.join(taskDir, "captain-sent.json")
/** Where the server writes the Captain's answer to a waiting message_captain (or why it wasn't delivered). */
const captainReplyFile = (id) => path.join(taskDir, `captain-reply-${id}.json`)

async function messageCaptain(args) {
  const message = String(args.message ?? "").trim()
  if (!message) return text("message is required", true)
  const wait = Math.max(0, Math.min(CAPTAIN_WAIT_MAX_SECONDS, Math.round(Number(args.wait_seconds ?? 0)) || 0))
  const now = Date.now()
  const sent = readJson(captainSentFile, []).filter((t) => typeof t === "number" && now - t < CAPTAIN_MSG_WINDOW_MS)
  if (sent.length >= CAPTAIN_MSG_LIMIT) {
    const free = Math.max(1, Math.ceil((Math.min(...sent) + CAPTAIN_MSG_WINDOW_MS - now) / 60_000))
    return text(
      owner(
        `Not sent: you already sent the Captain ${CAPTAIN_MSG_LIMIT} messages in the last 10 minutes (the limit). Try again in about ${free} min, put it in your final message, or use ask_user if you need Cody.`,
      ),
      true,
    )
  }
  fs.writeFileSync(captainSentFile, JSON.stringify([...sent, now]))
  const id = `cmsg_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  const fyi = args.fyi === true && !wait
  await emit({ t: "message_captain", id, message, wait, fyi })
  if (fyi) return text("FYI sent to your project's Captain view; it won't queue or start a turn.")
  if (!wait) return text("Sent to your project's Captain. Keep working; if it replies, the reply arrives as your next message.")

  const file = captainReplyFile(id)
  const deadline = Date.now() + wait * 1000
  while (Date.now() < deadline) {
    const answer = readJson(file, null)
    if (answer && typeof answer.status === "string") {
      try {
        fs.rmSync(file, { force: true })
      } catch {}
      if (answer.status === "reply") {
        await emit({ t: "captain_reply_taken", id, inputId: answer.inputId ?? null })
        return text(`The Captain replied:\n\n${answer.text ?? ""}`)
      }
      if (answer.status === "no_reply") {
        return text(
          `The Captain read your message and ended its turn without replying to you, so carry on (or end your turn if you're blocked; a later reply still arrives as your next message). Its turn ended with:\n\n${answer.text || "(nothing)"}`,
        )
      }
      return text(`Not delivered: ${answer.text ?? "the Captain couldn't take it"}`, true)
    }
    await sleep(400)
  }
  await emit({ t: "captain_wait_end", id })
  return text(`No reply within ${wait} s. The Captain still has your message; its reply arrives as your next message. Keep working, or end your turn if you're blocked on it.`)
}

/** Commits on any local branch that aren't on origin's base branch, or null outside a git repo. */
async function unpushedWork() {
  const base = task.baseBranch || "main"
  const res = await sh("git", ["rev-list", "--count", "--branches", "--not", `refs/remotes/origin/${base}`])
  if (res.code !== 0) return null
  const n = Number(res.stdout.trim())
  return Number.isFinite(n) ? n : null
}

/** GitHub's REST API with the task's token. `task.github.apiUrl` points it elsewhere (tests). */
function githubApi(token) {
  const base = (task.github?.apiUrl || "https://api.github.com").replace(/\/$/, "")
  return async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "box-yard",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}: ${data.message ?? "request failed"} ${JSON.stringify(data.errors ?? "")}`), { status: res.status })
    return data
  }
}

// ---------------------------------------------------------------------------
// PR screenshots. A published artifact's link (/artifacts/art_…/shot.png) is Box Yard's: GitHub can't reach it, and
// it's behind Box Yard's login. So create_pull_request copies each file a PR body links to onto the repo's
// pr-assets branch (never the base branch) and points the link there, where GitHub shows it. The name says nothing of
// Box Yard; the boxyard-assets branch earlier PRs link to is never written to again, so their pictures keep showing.

const ASSETS_BRANCH = "pr-assets"
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i
/** A relative /artifacts/ link, or one on any host (BOXYARD_PUBLIC_URL, or github.com where a relative link landed). Sentence punctuation after it isn't part of it. */
const ARTIFACT_LINK = /(?<![\w.\-/:])(?:https?:\/\/[^\s/)"'`<>\]]+)?\/artifacts\/(art_[a-z0-9]+)\/([^\s)"'`<>\]]*[^\s)"'`<>\].,;:!?])/gi
/** Code: a fenced block or an inline span. Links written there are about the link, so they stay as written. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/

/** Artifacts this task published: id to { path, size, sha256 } from the event log. */
function publishedArtifacts() {
  const out = new Map()
  let raw = ""
  try {
    raw = fs.readFileSync(eventsFile, "utf8")
  } catch {
    return out
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"artifact"')) continue
    try {
      const e = JSON.parse(line)
      if (e.t === "artifact" && e.id && e.path) out.set(e.id, e)
    } catch {}
  }
  return out
}

const assetName = (name) => {
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {}
  return decoded.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file"
}

/**
 * Commit files onto the assets branch through GitHub's git API, so the agent's clone isn't touched. The ref only
 * moves forward: when another agent got there first, it starts again from the new tip.
 */
async function pushAssets(gh, slug, files) {
  const ref = `heads/${ASSETS_BRANCH}`
  const blobs = []
  for (const f of files) {
    const blob = await gh("POST", `/repos/${slug}/git/blobs`, { content: fs.readFileSync(f.file).toString("base64"), encoding: "base64" })
    blobs.push({ path: f.repoPath, mode: "100644", type: "blob", sha: blob.sha })
  }
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    let tip = null
    try {
      tip = (await gh("GET", `/repos/${slug}/git/ref/${ref}`)).object.sha
    } catch (err) {
      if (err.status !== 404) throw err
    }
    const baseTree = tip ? (await gh("GET", `/repos/${slug}/git/commits/${tip}`)).tree.sha : null
    const tree = await gh("POST", `/repos/${slug}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: blobs })
    if (tree.sha === baseTree) return
    const commit = await gh("POST", `/repos/${slug}/git/commits`, {
      message: `Screenshots for task ${task.taskId}`,
      tree: tree.sha,
      parents: tip ? [tip] : [],
    })
    try {
      if (tip) await gh("PATCH", `/repos/${slug}/git/refs/${ref}`, { sha: commit.sha, force: false })
      else await gh("POST", `/repos/${slug}/git/refs`, { ref: `refs/${ref}`, sha: commit.sha })
      return
    } catch (err) {
      // 422: the branch moved (or was just made) under us.
      if (err.status !== 422) throw err
      lastErr = err
    }
  }
  throw lastErr
}

/** The file still holds what was published (older events have no sha256, so their size stands in). */
function unchanged(e) {
  try {
    const data = fs.readFileSync(e.path)
    return e.sha256 ? createHash("sha256").update(data).digest("hex") === e.sha256 : data.length === e.size
  } catch {
    return false
  }
}

/** The PR body with every link to an artifact this task published pointed at its copy on the assets branch, and notes on any it couldn't move. */
async function hostArtifacts(gh, slug, body) {
  // split() with a capture group: odd parts are code.
  const parts = body.split(CODE)
  const links = parts.flatMap((part, i) => (i % 2 ? [] : [...part.matchAll(ARTIFACT_LINK)]))
  if (!links.length) return { body, notes: [] }
  const known = publishedArtifacts()
  const files = new Map()
  const missing = new Set()
  for (const [, id, name] of links) {
    if (files.has(id) || missing.has(id)) continue
    const e = known.get(id)
    if (!e || !unchanged(e)) missing.add(id)
    else files.set(id, { file: e.path, repoPath: `${task.taskId}/${id}/${assetName(name)}` })
  }
  const notes = []
  if (files.size) {
    try {
      await pushAssets(gh, slug, [...files.values()])
    } catch (err) {
      notes.push(`Couldn't copy the PR's files to the ${ASSETS_BRANCH} branch (${clip(err.message, 300)}), so their Box Yard links stay, and GitHub can't show them.`)
      files.clear()
    }
  }
  if (missing.size) {
    notes.push(`GitHub can't show ${[...missing].join(", ")}: this task didn't publish it, or the file is gone or has changed since. Publish the file again with publish_artifact, use the new link, and call create_pull_request again.`)
  }
  const rewrite = (link, id) => {
    const f = files.get(id)
    if (!f) return link
    const url = `https://github.com/${slug}/blob/${ASSETS_BRANCH}/${f.repoPath.split("/").map(encodeURIComponent).join("/")}`
    // ?raw=true serves the file itself, which an image needs; other files open on GitHub's file page.
    return IMAGE_FILE.test(f.repoPath) ? `${url}?raw=true` : url
  }
  const out = parts.map((part, i) => (i % 2 ? part : part.replace(ARTIFACT_LINK, rewrite))).join("")
  if (files.size) notes.unshift(`Copied ${files.size} file${files.size === 1 ? "" : "s"} to the ${ASSETS_BRANCH} branch so GitHub shows ${files.size === 1 ? "it" : "them"}.`)
  return { body: out, notes }
}

async function createPullRequest(args) {
  const slug = task.github?.slug
  const token = task.env?.GITHUB_TOKEN
  if (!slug) return text("This project has no GitHub repo, so there is nothing to open a PR against.", true)
  if (!token) return text(owner("GITHUB_TOKEN is not set for this task; ask Cody with ask_user."), true)

  const branch = (await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  if (!branch || branch === "HEAD") return text("Not on a branch. Use git checkout -b with a name following this repository's convention; never add a boxyard prefix.", true)
  if (branch === task.baseBranch) return text(`You're on ${task.baseBranch}. Create a new branch following this repository's naming convention and commit there; never add a boxyard prefix.`, true)
  const dirty = (await sh("git", ["status", "--porcelain"])).stdout.trim()
  if (dirty) return text(`You have uncommitted changes:\n${clip(dirty, 1500)}\nCommit them first.`, true)

  const push = await sh("git", ["push", "-u", "origin", branch])
  if (push.code !== 0) return text(`git push failed:\n${clip(push.stderr || push.stdout, 2000)}`, true)

  const gh = githubApi(token)
  try {
    const { body, notes } = await hostArtifacts(gh, slug, String(args.body ?? ""))
    const fields = { title: String(args.title), body }
    const owner = slug.split("/")[0]
    const open = await gh("GET", `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
    let pr = Array.isArray(open) ? open[0] : null
    let created = false
    if (pr) {
      // Calling it again updates the PR: the new title and body replace the old ones.
      pr = await gh("PATCH", `/repos/${slug}/pulls/${pr.number}`, fields)
    } else {
      pr = await gh("POST", `/repos/${slug}/pulls`, { ...fields, head: branch, base: task.baseBranch, draft: Boolean(args.draft) })
      created = true
    }
    // The commit just pushed, so Box Yard hooks fire once per head commit (task.pr_ready).
    const headSha = (await sh("git", ["rev-parse", "HEAD"])).stdout.trim()
    await emit({ t: "pr", url: pr.html_url, number: pr.number, branch, ...(/^[0-9a-f]{40}$/.test(headSha) ? { headSha } : {}) })
    return text([`${created ? "Opened" : "Updated (pushed to, with this title and body)"} PR #${pr.number}: ${pr.html_url}`, ...notes].join("\n"))
  } catch (err) {
    return text(String(err.message), true)
  }
}

function serveMcp() {
  let buf = ""
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8")
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
        continue
      }
      handle(req).then(
        (result) => req.id !== undefined && result !== undefined && send({ jsonrpc: "2.0", id: req.id, result }),
        (err) => req.id !== undefined && send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: String(err?.message ?? err) } }),
      )
    }
  })
  process.stdin.on("end", () => process.exit(0))

  // When this MCP process was spawned and its handshake ran, for the turn's timings (turnTimingOf).
  const handshake = { pid: process.pid, spawnedAt: Math.round(performance.timeOrigin), initializeAt: null, readyAt: null }
  const noteHandshake = () => {
    try {
      fs.writeFileSync(path.join(taskDir, "mcp-handshake.json"), JSON.stringify(handshake))
    } catch {}
  }

  async function handle(req) {
    switch (req.method) {
      case "initialize":
        handshake.initializeAt ??= Date.now()
        return {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "boxyard", version: RUNNER_VERSION },
        }
      case "ping":
        return {}
      case "tools/list":
        if (handshake.readyAt === null) {
          handshake.readyAt = Date.now()
          noteHandshake()
        }
        return { tools: namedTools(TOOLS.filter((t) => t.name !== "message_parent" || task.parentTaskId)) }
      case "tools/call":
        return callTool(req.params?.name, req.params?.arguments ?? {})
      default:
        if (req.id === undefined) return undefined // notification
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 })
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace cleanup. Runs between turns to free disk on resting tasks. It must
// never destroy source: inside a git repo it only deletes directories git
// reports as ignored *and* untracked, and only when their name is on the list.
// Outside any repo it can't tell source from output, so it only deletes the
// few names that are always generated (a committed `build/` or `dist/` is real
// source in plenty of repos; a `node_modules/` never is).

const CLEAN_IN_REPO = new Set([
  "node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", "target", ".venv", "__pycache__",
  // Scratch space and perf/test captures (e.g. shots/perf/*.jsonl, Playwright reports, traces).
  "tmp", ".tmp", "shots", "perf", "traces", "playwright-report", "test-results",
])
/**
 * `clean <taskDir> builds`, for folders on Cody's own computers: only dependency and build output. Scratch dirs and
 * captures (tmp, shots, perf, traces, reports) stay, since he may open them there.
 */
const CLEAN_BUILDS = new Set(["node_modules", ".next", ".turbo", ".cache", ".parcel-cache", ".vite", "dist", "build", "coverage", "target", ".venv", "__pycache__"])
const CLEAN_OUTSIDE_REPO = new Set(["node_modules", "__pycache__"])
const CLEAN_MAX_DEPTH = 6

function gitOut(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

async function cleanRepo(repo, removed) {
  // --directory collapses a fully untracked dir into one "dir/" entry, so a
  // dir that holds any tracked file is never listed as a whole.
  const out = await gitOut(repo, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
  if (out === null) return // git missing or broken repo: leave it alone
  for (const entry of out.split("\0")) {
    if (!entry.endsWith("/")) continue
    const rel = entry.slice(0, -1)
    if (!(cleanWhat === "builds" ? CLEAN_BUILDS : CLEAN_IN_REPO).has(path.basename(rel))) continue
    // Belt and braces: re-check that git tracks nothing under it.
    const tracked = await gitOut(repo, ["ls-files", "-z", "--", rel])
    if (tracked !== "") continue
    const abs = path.join(repo, rel)
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue
    fs.rmSync(abs, { recursive: true, force: true })
    removed.push(abs)
  }
}

async function cleanDir(dir, depth, removed) {
  if (fs.existsSync(path.join(dir, ".git"))) return cleanRepo(dir, removed)
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue // skips symlinks too
    const abs = path.join(dir, e.name)
    if (CLEAN_OUTSIDE_REPO.has(e.name)) {
      fs.rmSync(abs, { recursive: true, force: true })
      removed.push(abs)
    } else if (depth < CLEAN_MAX_DEPTH) {
      await cleanDir(abs, depth + 1, removed)
    }
  }
}

// A process using the folder (a dev server left up after the turn, an editor, a shell Cody opened there) would
// break if its node_modules or dist vanished, so cleanup leaves a folder with one alone.
const LIVE_MARK = "live: "

/** Read processes from /proc (Linux). BOXYARD_LIVE_VIA=lsof takes the macOS path (ps and lsof) instead, for tests. */
const procfs = () => process.env.BOXYARD_LIVE_VIA !== "lsof" && fs.existsSync("/proc/self/stat")

function realpathOr(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Every process as pid -> { ppid, args }, from /proc (Linux) or ps (macOS and the rest). */
function processTable() {
  const table = new Map()
  if (procfs()) {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8")
        // "pid (comm) state ppid ...": comm may hold spaces and parens, so read after the last ")".
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
        const args = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean)
        table.set(Number(name), { ppid, args })
      } catch {
        // Gone already, or not ours to read.
      }
    }
    return table
  }
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 })
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), args: [m[3]] })
  }
  return table
}

/** pid -> paths it has open (cwd included): /proc/<pid>/cwd and fd/* on Linux, lsof elsewhere. */
function openPaths(pids) {
  const open = new Map()
  if (procfs()) {
    for (const pid of pids) {
      const paths = []
      try {
        paths.push(fs.readlinkSync(`/proc/${pid}/cwd`))
      } catch {}
      try {
        for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
          try {
            paths.push(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))
          } catch {}
        }
      } catch {}
      open.set(pid, paths)
    }
    return open
  }
  // -F pn: a "p<pid>" line, then an "n<path>" line per open file (the cwd too). lsof exits 1 when some files can't be
  // read, with the rest still listed.
  const lsof = spawnSync("lsof", ["-n", "-P", "-w", "-F", "pn"], { encoding: "utf8", maxBuffer: 512 << 20 })
  let pid = 0
  for (const line of (lsof.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
      if (!open.has(pid)) open.set(pid, [])
    } else if (line.startsWith("n") && pid) open.get(pid).push(line.slice(1))
  }
  return open
}

/**
 * Processes whose cwd, an open file or an argument is inside `dir`. This process and its ancestors (the shell that
 * ran it names the folder in its command) don't count.
 */
function liveProcesses(dir) {
  const roots = [...new Set([path.resolve(dir), realpathOr(dir)])]
  const inside = (p) => roots.some((r) => p === r || p.startsWith(`${r}/`))
  // On macOS ps gives the whole command as one string: a root followed by "/", a space or its end.
  const named = (arg) => inside(arg) || roots.some((r) => arg.includes(` ${r}/`) || arg.includes(` ${r} `) || arg.endsWith(` ${r}`) || arg.startsWith(`${r}/`) || arg.startsWith(`${r} `))
  const table = processTable()
  const self = new Set()
  for (let pid = process.pid; pid > 0 && !self.has(pid); pid = table.get(pid)?.ppid ?? 0) self.add(pid)
  const others = [...table.keys()].filter((pid) => !self.has(pid))
  const open = openPaths(others)
  const live = []
  for (const pid of others) {
    const args = table.get(pid).args
    if (args.some(named) || (open.get(pid) ?? []).some(inside)) live.push({ pid, command: args.join(" ").slice(0, 160) })
  }
  return live
}

function printLive(live) {
  for (const p of live) console.log(`${LIVE_MARK}${p.pid} ${p.command}`)
}

async function cleanWorkspace() {
  const work = path.join(taskDir, "work")
  if (!fs.existsSync(work)) return
  const live = liveProcesses(work)
  if (live.length) return printLive(live)
  const removed = []
  await cleanDir(work, 0, removed)
  for (const p of removed) console.log(path.relative(work, p))
  if (removed.length) {
    // The next turn's prompt says what went (workspaceNote), so the agent reinstalls before it runs anything.
    const file = path.join(taskDir, "cleaned.json")
    const dirs = new Set(readJson(file, { dirs: [] }).dirs)
    for (const p of removed) dirs.add(path.relative(work, p))
    fs.writeFileSync(file, JSON.stringify({ dirs: [...dirs] }))
  }
}

// ---------------------------------------------------------------------------
// Dependency cache (opt-in: turn.json `deps`, from Settings › Dependency cache or
// the project's override). One store per box, next to the task folders so hard
// links work (/tmp is another filesystem there, and reflinks cost full quota):
//
//   <deps.dir>/npm/<key>/node_modules   read-only files, hard-linked into tasks
//   <deps.dir>/npm/<key>/meta.json      size, last use, a sentinel file
//
// The key is the lockfile plus what makes an install differ (Node ABI, platform,
// libc). Before a turn, a task with a package-lock.json and no node_modules gets
// the tree for its key in well under a second. After a turn, a node_modules that
// matches its lockfile (npm's own node_modules/.package-lock.json) is saved.
// Files are chmod a-w, so a task writing into one fails loudly instead of
// changing every task's copy; npm itself replaces files, it never writes in place.

const DEPS_VERSION = 1
/** Top-level node_modules entries tools write per task (vite, vitest, prisma's generated client); never shared. */
const DEPS_NPM_SKIP = new Set([".cache", ".vite", ".vitest", ".prisma", ".tmp", ".boxyard-deps.json"])

function depsKeyNpm(lockText) {
  const glibc = process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl"
  const parts = [`v${DEPS_VERSION}`, lockText, process.versions.modules, process.platform, process.arch, process.platform === "linux" ? glibc : ""]
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)
}

/** Why a work/ dir's npm tree can't use the cache, or null. A root lockfile whose packages all live under ./node_modules. */
function npmUnsupported(lock) {
  const pkgs = lock?.packages
  if (!pkgs || typeof pkgs !== "object") return "lockfile has no packages map (lockfileVersion < 2)"
  for (const k of Object.keys(pkgs)) if (k.includes("node_modules/") && !k.startsWith("node_modules/")) return `nested node_modules (${k})`
  return null
}

/** Whether node_modules holds exactly what package-lock.json asks for, going by npm's hidden lockfile. */
function npmTreeMatches(lock, hidden) {
  const want = lock.packages
  const have = hidden?.packages
  if (!have) return false
  for (const [k, v] of Object.entries(want)) {
    if (k === "") continue
    const h = have[k]
    if (!h) {
      if (v.optional) continue // not installed on this platform
      return false
    }
    if ((h.version ?? h.resolved) !== (v.version ?? v.resolved)) return false
  }
  return Object.keys(have).every((k) => k in want)
}

/** Node ABIs node-gyp built addons for (build/config.gypi), so a tree built by another Node isn't keyed as ours. */
function gypAbis(nm) {
  const abis = new Set()
  const look = (dir) => {
    const gypi = path.join(dir, "build", "config.gypi")
    if (!fs.existsSync(gypi)) return
    const m = fs.readFileSync(gypi, "utf8").match(/"node_module_version":\s*(\d+)/)
    abis.add(m ? m[1] : "?")
  }
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const abs = path.join(nm, e.name)
    if (e.name.startsWith("@")) for (const s of fs.readdirSync(abs, { withFileTypes: true })) s.isDirectory() && look(path.join(abs, s.name))
    else look(abs)
  }
  return abis
}

/** Copy a tree as hard links (dirs are new, files shared). `readOnly` chmods each file a-w. Returns files and bytes. */
function linkTree(src, dst, { skip = new Set(), readOnly = false } = {}) {
  const stats = { files: 0, bytes: 0, sentinel: null }
  const walk = (from, to, top) => {
    fs.mkdirSync(to)
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (top && skip.has(e.name)) continue
      const a = path.join(from, e.name)
      const b = path.join(to, e.name)
      if (e.isDirectory()) walk(a, b, false)
      else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), b)
      else if (e.isFile()) {
        const st = fs.statSync(a)
        if (readOnly && st.mode & 0o222) fs.chmodSync(a, st.mode & ~0o222)
        fs.linkSync(a, b)
        stats.files++
        stats.bytes += st.size
        stats.sentinel ??= path.relative(dst, b)
      }
    }
  }
  walk(src, dst, true)
  return stats
}

function readLock(work) {
  const text = fs.readFileSync(path.join(work, "package-lock.json"), "utf8")
  return { text, lock: JSON.parse(text) }
}

function touchMeta(entry, patch = {}) {
  const file = path.join(entry, "meta.json")
  const meta = { ...readJson(file, {}), ...patch, lastUsed: Date.now() }
  fs.writeFileSync(file, JSON.stringify(meta))
  return meta
}

/** Before a turn: hard-link the cached node_modules into work/ when it's missing. */
function depsRestore(deps, work) {
  if (!deps?.npm || !deps.dir) return null
  if (!fs.existsSync(path.join(work, "package-lock.json")) || fs.lstatSync(path.join(work, "node_modules"), { throwIfNoEntry: false })) return null
  const started = Date.now()
  const { text, lock } = readLock(work)
  if (npmUnsupported(lock)) return null
  const key = depsKeyNpm(text)
  const entry = path.join(deps.dir, "npm", key)
  if (!fs.existsSync(path.join(entry, "node_modules"))) return { ecosystem: "npm", action: "miss", key }
  const dst = path.join(work, "node_modules")
  try {
    const { files } = linkTree(path.join(entry, "node_modules"), dst)
    fs.writeFileSync(path.join(dst, ".boxyard-deps.json"), JSON.stringify({ ecosystem: "npm", key }))
    touchMeta(entry)
    return { ecosystem: "npm", action: "restored", key, files, ms: Date.now() - started }
  } catch (err) {
    fs.rmSync(dst, { recursive: true, force: true })
    return { ecosystem: "npm", action: "failed", key, error: clip(String(err?.message ?? err), 300) }
  }
}

/** After a turn: save a node_modules that matches its lockfile, then keep the store under deps.maxMb. */
function depsSave(deps, work) {
  if (!deps?.npm || !deps.dir) return null
  const nm = path.join(work, "node_modules")
  if (!fs.existsSync(path.join(work, "package-lock.json")) || !fs.lstatSync(nm, { throwIfNoEntry: false })?.isDirectory()) return null
  const { text, lock } = readLock(work)
  const skipped = (reason) => ({ ecosystem: "npm", action: "skipped", reason })
  const unsupported = npmUnsupported(lock)
  if (unsupported) return skipped(unsupported)
  if (!npmTreeMatches(lock, readJson(path.join(nm, ".package-lock.json"), null))) return skipped("node_modules doesn't match package-lock.json")
  const abis = [...gypAbis(nm)].filter((a) => a !== process.versions.modules)
  if (abis.length) return skipped(`native addons built for another Node (ABI ${abis.join(", ")})`)
  const key = depsKeyNpm(text)
  const store = path.join(deps.dir, "npm")
  const entry = path.join(store, key)
  if (fs.existsSync(path.join(entry, "node_modules"))) {
    touchMeta(entry)
    return { ecosystem: "npm", action: "present", key }
  }
  const started = Date.now()
  fs.mkdirSync(store, { recursive: true })
  const tmp = path.join(store, `.${key}.${process.pid}.tmp`)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp)
    const stats = linkTree(nm, path.join(tmp, "node_modules"), { skip: DEPS_NPM_SKIP, readOnly: true })
    fs.writeFileSync(path.join(tmp, "meta.json"), JSON.stringify({ ecosystem: "npm", key, node: process.version, createdAt: Date.now(), lastUsed: Date.now(), files: stats.files, bytes: stats.bytes, sentinel: stats.sentinel }))
    fs.renameSync(tmp, entry) // another task saving the same key first: keep theirs
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!fs.existsSync(path.join(entry, "node_modules"))) return { ecosystem: "npm", action: "failed", key, error: clip(String(err?.message ?? err), 300) }
  }
  fs.writeFileSync(path.join(nm, ".boxyard-deps.json"), JSON.stringify({ ecosystem: "npm", key }))
  const evicted = depsPrune(deps, key)
  return { ecosystem: "npm", action: "saved", key, ms: Date.now() - started, ...(evicted.length ? { evicted } : {}) }
}

/**
 * Evict least recently used entries until the store fits deps.maxMb. An entry a task still links (its sentinel file
 * has more than one link) frees nothing, so it stays.
 */
function depsPrune(deps, keep) {
  const store = path.join(deps.dir, "npm")
  const entries = fs
    .readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ dir: path.join(store, e.name), meta: readJson(path.join(store, e.name, "meta.json"), {}) }))
  let total = entries.reduce((n, e) => n + (e.meta.bytes ?? 0), 0)
  const budget = (deps.maxMb ?? 2048) * 1024 * 1024
  const evicted = []
  for (const e of entries.sort((a, b) => (a.meta.lastUsed ?? 0) - (b.meta.lastUsed ?? 0))) {
    if (total <= budget) break
    if (e.meta.key === keep) continue
    const sentinel = e.meta.sentinel && fs.statSync(path.join(e.dir, "node_modules", e.meta.sentinel), { throwIfNoEntry: false })
    if (sentinel && sentinel.nlink > 1) continue
    fs.rmSync(e.dir, { recursive: true, force: true })
    total -= e.meta.bytes ?? 0
    evicted.push(path.basename(e.dir))
  }
  return evicted
}

/** What Box Yard did to work/ while the task rested, for the start of the next prompt. */
function workspaceNote(restored) {
  const file = path.join(taskDir, "cleaned.json")
  const cleaned = readJson(file, { dirs: [] }).dirs.filter((d) => !(restored && d === "node_modules"))
  fs.rmSync(file, { force: true })
  const lines = []
  if (restored) lines.push(`Box Yard restored node_modules from this box's dependency cache (it matches package-lock.json), so there's no need to run npm ci or npm install unless you change dependencies.`)
  if (cleaned.length) lines.push(`While this task was idle, Box Yard removed build output to free disk: ${cleaned.map((d) => `work/${d}`).join(", ")}. Reinstall or rebuild before you run tests or the app.`)
  return lines.length ? `[Box Yard] ${lines.join(" ")}` : ""
}

/** A cache step never fails a turn: errors come back as a "failed" result. */
function depsStep(fn, deps, work) {
  try {
    return fn(deps, work)
  } catch (err) {
    return { ecosystem: "npm", action: "failed", error: clip(String(err?.message ?? err), 300) }
  }
}

// ---------------------------------------------------------------------------

if (mode === "turn" && !leadOwnGroup()) {
  // The turn runs on in the copy that leads its own group; that one writes turn.pid.
  process.exit(0)
} else if (mode === "turn") {
  // No terminal to hang up, but a stray SIGHUP mustn't end a turn either (nohup's ignore doesn't outlive a re-exec).
  process.on("SIGHUP", () => {})
  runTurn().then(
    () => {
      cleanupSigning()
      process.exit(0)
    },
    async (err) => {
      cleanupSigning()
      dropTaskJson()
      try {
        await emit({ t: "turn_end", exitCode: 1, ok: false, error: `runner crashed: ${err?.stack ?? err}` })
      } catch {}
      process.exit(1)
    },
  )
} else if (mode === "mcp") {
  serveMcp()
} else if (mode === "deps") {
  const deps = readJson(path.join(taskDir, "turn.json"), {}).deps
  const fn = process.argv[4] === "save" ? depsSave : depsRestore
  console.log(JSON.stringify(depsStep(fn, deps, path.join(taskDir, "work"))))
} else if (mode === "live") {
  const work = path.join(taskDir, "work")
  if (fs.existsSync(work)) printLive(liveProcesses(work))
  process.exit(0)
} else if (mode === "clean") {
  cleanWorkspace().then(
    () => process.exit(0),
    (err) => {
      console.error(`clean failed: ${err?.stack ?? err}`)
      process.exit(1)
    },
  )
} else {
  console.error(`unknown mode ${mode}`)
  process.exit(2)
}
