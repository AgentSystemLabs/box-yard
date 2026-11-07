// A Captain's read-only clone of its project's repo, data/captains/<projectId>/repo, so it answers code questions
// itself instead of creating a task (which may wait for a slot) just to read the code.
//
// It's made on first use (the repo_clone tool), as a partial clone (blob:none) of the base branch alone. Each later
// use fetches and resets it to origin/<base>, at most once a minute (throttleMs) and with a timeout; when the fetch
// fails, the last copy stays and the Captain is told how old it is. The Captain reads it with Read, Grep and Glob only
// (CAPTAIN_TOOLS, Captain.readRules): none of its tools edits, commits or runs anything, and its deny rules refuse
// edits in the clone too (cloneDenyRules). Box Yard's own git below is the only thing that writes it.
//
// It authenticates like a local-runner task's clone (TaskManager.localGitAuth): the project's token reaches git through
// Box Yard's credential helper and $GITHUB_TOKEN, never the URL, the clone's config, its state file or a log. Git runs
// with no hooks and without git-lfs downloads, so cloning runs nothing of the project's.
//
// CaptainManager.sweepRepos takes clones out of disk cleanup: a deleted project's, one unused for keepMs, and on a low
// disk (Settings › Low-disk cleanup) one unused for lowDiskKeepMs. The next repo_clone makes it again.
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { agentEnv } from "./providers/local.js"
import { redactValues } from "./redact.js"
import { cloneUrl } from "./store.js"
import type { Project } from "../shared/types.js"

/** The clone's folder in the Captain's own folder. */
export const CLONE_DIR = "repo"
/** Where a clone is made before it moves into place, so a half-made one is never read. */
const CLONING_DIR = "repo.cloning"
/** What Box Yard knows about the clone, kept in its .git so it goes with it. */
const STATE_FILE = "boxyard-clone.json"

export interface RepoTuning {
  /** A fetch at most this often. */
  throttleMs: number
  /** A fetch (and the reset after it) gives up after this long. */
  fetchTimeoutMs: number
  /** The first clone gives up after this long. */
  cloneTimeoutMs: number
  /** repo_clone waits this long for a clone still being made, then says to call again (the clone goes on). */
  waitMs: number
  /** Disk cleanup removes a clone unused for this long. */
  keepMs: number
  /** On a low disk, one unused for this long. */
  lowDiskKeepMs: number
}

export const DEFAULT_REPO_TUNING: RepoTuning = {
  throttleMs: 60_000,
  fetchTimeoutMs: 60_000,
  cloneTimeoutMs: 15 * 60_000,
  waitMs: 50_000,
  keepMs: 14 * 24 * 60 * 60_000,
  lowDiskKeepMs: 60 * 60_000,
}

/** How Box Yard's git reaches a project's repo on this computer: env (GITHUB_TOKEN, an identity's git config) and `-c` settings. */
export interface GitAuth {
  env: Record<string, string>
  config: string[]
}

interface CloneState {
  url: string
  base: string
  /** The last fetch and reset that worked (the clone itself, first). */
  syncedAt: number
  /** The last fetch tried, worked or not: the throttle counts from it. */
  attemptAt: number
  /** Why the last fetch failed, or null. */
  error: string | null
  /** The last repo_clone: disk cleanup counts from it. */
  usedAt: number
  commit: string | null
  committedAt: number | null
  subject: string | null
}

/** What repo_clone hands the Captain. */
export type RepoView =
  | { kind: "none"; message: string }
  | { kind: "cloning"; message: string }
  | { kind: "failed"; message: string }
  | {
      kind: "ready"
      path: string
      repo: string
      branch: string
      commit: string | null
      committedAt: number | null
      subject: string | null
      syncedAt: number
      /** The fetch failed (now, or the last try within the throttle): this is the last copy. */
      error: string | null
    }

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  if (ms < 60_000) return "just now"
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `${h} h ago`
  return `${Math.round(ms / 86_400_000)} days ago`
}

/** The deny rules that keep every editing tool out of the clone, whatever tools a chat has (Claude Code permission rules). */
export function cloneDenyRules(dir: string): string[] {
  return [`Edit(/${dir}/**)`, `Write(/${dir}/**)`]
}

/** The tool result: where it is, what it holds, how fresh, and that it's read-only. */
export function repoViewResult(view: RepoView, now: number): Record<string, unknown> {
  if (view.kind !== "ready") return { status: view.kind, message: view.message }
  const commit = view.commit ? `${view.commit}${view.subject ? ` "${view.subject}"` : ""}${view.committedAt ? `, committed ${new Date(view.committedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}` : null
  return {
    status: view.error ? "stale" : "fresh",
    path: view.path,
    repo: view.repo,
    branch: view.branch,
    commit,
    synced: ago(now - view.syncedAt),
    ...(view.error
      ? { stale: `Fetching origin/${view.branch} failed (${view.error}), so this is the last copy, synced ${ago(now - view.syncedAt)}. Say how old it is when you answer from it.` }
      : {}),
    read_only: "Read, Grep and Glob work here. Nothing can edit, commit, push or run it: create a task for work that needs that.",
  }
}

/** One git run's outcome. */
interface GitRun {
  ok: boolean
  out: string
  err: string
}

export class CaptainRepo {
  readonly dir: string
  private readonly cloning: string
  /** The sync in flight (a clone, or a fetch and reset), so concurrent calls share it. */
  private running: Promise<void> | null = null
  private runningSince = 0
  private child: ChildProcess | null = null
  /** The last clone that failed, while there's no clone: retried after the throttle. */
  private cloneFailure: { at: number; error: string } | null = null
  private removed = false

  constructor(
    private readonly opts: {
      /** The Captain's folder, data/captains/<projectId>. */
      home: string
      project: () => Project | null
      auth: () => GitAuth | null
      tuning: RepoTuning
      now?: () => number
    },
  ) {
    this.dir = path.join(opts.home, CLONE_DIR)
    this.cloning = path.join(opts.home, CLONING_DIR)
  }

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  get busy() {
    return this.running !== null
  }

  /**
   * Get the clone ready to read: make it if there's none (or it's of another repo or branch), else fetch and reset it
   * unless that was tried in the last throttleMs. Waits up to waitMs for a clone being made; a fetch it always waits for
   * (it has its own timeout).
   */
  async open(): Promise<RepoView> {
    const project = this.opts.project()
    if (!project?.repo) return { kind: "none", message: "This project has no repository, so there's no code to read." }
    this.removed = false
    const url = cloneUrl(project.repo)
    const base = project.baseBranch
    const state = this.state()
    const usable = state && state.url === url && state.base === base
    const due = !usable || this.now() - state.attemptAt >= this.opts.tuning.throttleMs
    const failed = this.cloneFailure
    if (!usable && failed && this.now() - failed.at < this.opts.tuning.throttleMs && !this.running) {
      return { kind: "failed", message: `Cloning ${project.repo} failed ${ago(this.now() - failed.at)}: ${failed.error}` }
    }
    if (due && !this.running) {
      this.runningSince = this.now()
      this.running = (usable ? this.fetch(base) : this.clone(url, base)).finally(() => {
        this.running = null
        this.child = null
      })
    }
    if (this.running) {
      if (usable) await this.running
      else {
        let timer: NodeJS.Timeout | undefined
        const done = await Promise.race([this.running.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.opts.tuning.waitMs)))])
        clearTimeout(timer)
        if (!done)
          return { kind: "cloning", message: `Still cloning ${project.repo} (started ${ago(this.now() - this.runningSince)}). It goes on: call repo_clone again in a minute.` }
      }
    }
    const now = this.state()
    if (!now || now.url !== url || now.base !== base) {
      const why = this.cloneFailure?.error ?? "no clone was made"
      return { kind: "failed", message: `Cloning ${project.repo} failed: ${why}` }
    }
    this.writeState({ ...now, usedAt: this.now() })
    return { kind: "ready", path: this.dir, repo: project.repo, branch: base, commit: now.commit, committedAt: now.committedAt, subject: now.subject, syncedAt: now.syncedAt, error: now.error }
  }

  /** The clone as the Captain's [Project now] line says it, without any git: null when there's none. */
  brief(): { syncedAt: number; commit: string | null; error: string | null } | null {
    const project = this.opts.project()
    const s = this.state()
    if (!project?.repo || !s || s.url !== cloneUrl(project.repo) || s.base !== project.baseBranch) return null
    return { syncedAt: s.syncedAt, commit: s.commit, error: s.error }
  }

  /** When repo_clone last used it (or it was made), or null with no clone. */
  usedAt(): number | null {
    const s = this.state()
    if (s) return s.usedAt
    try {
      return fs.statSync(this.dir).mtimeMs
    } catch {
      return null
    }
  }

  /** Box Yard is stopping: end a git still working on the clone (a half-made one is left for disk cleanup). */
  stop() {
    this.removed = true
    this.child?.kill("SIGKILL")
  }

  /** Remove the clone (and a half-made one), stopping a git still working on it. */
  async remove(): Promise<void> {
    this.removed = true
    this.child?.kill("SIGKILL")
    await this.running?.catch(() => {})
    for (const d of [this.dir, this.cloning]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    this.cloneFailure = null
  }

  private statePath() {
    return path.join(this.dir, ".git", STATE_FILE)
  }

  private state(): CloneState | null {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(), "utf8")) as CloneState
    } catch {
      return null
    }
  }

  private writeState(s: CloneState) {
    try {
      fs.writeFileSync(this.statePath(), JSON.stringify(s))
    } catch {}
  }

  private async clone(url: string, base: string) {
    const at = this.now()
    for (const d of [this.dir, this.cloning]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    fs.mkdirSync(this.opts.home, { recursive: true })
    const r = await this.git(["clone", "--quiet", "--filter=blob:none", "--single-branch", "--branch", base, "--no-tags", "--", url, this.cloning], this.opts.home, this.opts.tuning.cloneTimeoutMs)
    if (!r.ok || this.removed) {
      fs.rmSync(this.cloning, { recursive: true, force: true, maxRetries: 3 })
      this.cloneFailure = this.removed ? null : { at, error: r.err }
      return
    }
    fs.renameSync(this.cloning, this.dir)
    this.cloneFailure = null
    this.writeState({ url, base, syncedAt: at, attemptAt: at, error: null, usedAt: at, ...(await this.head()) })
  }

  private async fetch(base: string) {
    const prev = this.state()!
    const at = this.now()
    const ref = `refs/remotes/origin/${base}`
    let r = await this.git(["fetch", "--quiet", "--prune", "--no-tags", "origin", `+refs/heads/${base}:${ref}`], this.dir, this.opts.tuning.fetchTimeoutMs)
    // A partial clone fetches the new commit's files as it resets to it.
    if (r.ok) r = await this.git(["reset", "--quiet", "--hard", ref], this.dir, this.opts.tuning.fetchTimeoutMs)
    if (r.ok) await this.git(["clean", "-ffdq"], this.dir, this.opts.tuning.fetchTimeoutMs)
    if (this.removed) return
    this.writeState(r.ok ? { ...prev, syncedAt: at, attemptAt: at, error: null, ...(await this.head()) } : { ...prev, attemptAt: at, error: r.err })
  }

  private async head(): Promise<Pick<CloneState, "commit" | "committedAt" | "subject">> {
    const r = await this.git(["log", "-1", "--format=%h%x00%ct%x00%s"], this.dir, 10_000)
    const [commit, ct, subject] = r.ok ? r.out.trim().split("\0") : []
    return { commit: commit || null, committedAt: ct ? Number(ct) * 1000 : null, subject: subject?.slice(0, 200) || null }
  }

  /** Run git with the project's auth, no hooks and no git-lfs downloads; `err` is a short line with any secret taken out. */
  private git(args: string[], cwd: string, timeoutMs: number): Promise<GitRun> {
    const auth = this.opts.auth()
    const secrets = Object.entries(auth?.env ?? {}).flatMap(([k, v]) => (/TOKEN|SECRET|PASSWORD/.test(k) ? [v] : []))
    const env: NodeJS.ProcessEnv = {
      ...agentEnv(process.env),
      ...auth?.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    }
    const pre = [...(auth?.config ?? []), "core.hooksPath=/dev/null"].flatMap((c) => ["-c", c])
    return new Promise((resolve) => {
      let out = ""
      let err = ""
      let timedOut = false
      let child: ChildProcess
      try {
        child = spawn("git", [...pre, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
      } catch (e) {
        resolve({ ok: false, out: "", err: `couldn't run git: ${(e as Error).message}` })
        return
      }
      this.child = child
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)
      child.stdout!.on("data", (d) => (out += d))
      child.stderr!.on("data", (d) => (err = (err + d).slice(-4000)))
      const done = (code: number | null, why?: string) => {
        clearTimeout(timer)
        const line = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : why || err.trim().split("\n").filter(Boolean).at(-1) || `git exited with ${code}`
        resolve({ ok: !timedOut && code === 0, out, err: redactValues(line, secrets).slice(0, 300) })
      }
      child.on("error", (e) => done(null, `couldn't run git: ${e.message}`))
      child.on("close", (code) => done(code))
    })
  }
}

/** A clone disk cleanup may remove, and why. */
export interface RepoSweepEntry {
  projectId: string
  /** The project still exists. */
  live: boolean
  busy: boolean
  /** Last used (or made), or null when there's no clone. */
  usedAt: number | null
  /** A half-made clone with no clone running: one a stop cut off. */
  leftover: boolean
}

/** Which Captains' clones to remove now: a deleted project's, a leftover half-made one, one unused for keepMs (lowDiskKeepMs on a low disk). */
export function reposToRemove(entries: RepoSweepEntry[], opts: { now: number; lowDisk: boolean; tuning: Pick<RepoTuning, "keepMs" | "lowDiskKeepMs"> }): { projectId: string; why: string }[] {
  const out: { projectId: string; why: string }[] = []
  for (const e of entries) {
    if (e.busy) continue
    if (!e.live) out.push({ projectId: e.projectId, why: "its project was deleted" })
    else if (e.usedAt !== null && opts.now - e.usedAt >= opts.tuning.keepMs) out.push({ projectId: e.projectId, why: `unused for ${ago(opts.now - e.usedAt).replace(" ago", "")}` })
    else if (e.usedAt !== null && opts.lowDisk && opts.now - e.usedAt >= opts.tuning.lowDiskKeepMs) out.push({ projectId: e.projectId, why: "this computer is low on disk" })
    else if (e.leftover) out.push({ projectId: e.projectId, why: "a clone was cut off before it finished" })
  }
  return out
}

/** The Captains' folders under data/captains that hold a clone or a half-made one. */
export function captainsWithClones(captainsRoot: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(captainsRoot)
  } catch {
    return []
  }
  return names.filter((n) => fs.existsSync(path.join(captainsRoot, n, CLONE_DIR)) || fs.existsSync(path.join(captainsRoot, n, CLONING_DIR)))
}

/** A half-made clone is in this Captain's folder. */
export function hasLeftoverClone(home: string): boolean {
  return fs.existsSync(path.join(home, CLONING_DIR))
}
