// The in-app Update button's state (server/selfUpdate.ts, launcher/supervisor.mjs, docs/npx.md › Updates).
// Only a Box Yard started by the npx launcher can update itself; a git checkout (./yard) says `managed: false`.

/** Where an update is: idle, the install steps (launcher/install.mjs STEPS), built and waiting, restarting, or failed. */
export type UpdatePhase = "idle" | "download" | "dependencies" | "build" | "finish" | "ready" | "restarting" | "failed"

export const UPDATE_INSTALL_PHASES: readonly UpdatePhase[] = ["download", "dependencies", "build", "finish"]

export interface UpdateResult {
  from: string | null
  to: string
  ok: boolean
  at: number
  error?: string
}

export interface UpdateStatus {
  /** Started by the launcher, so it can update itself. */
  managed: boolean
  /** The commit this server runs. */
  current: string | null
  /** The newest commit on main, from the last check; null before one worked. */
  latest: string | null
  checkedAt: number | null
  checking: boolean
  /** Why the last check didn't work (offline, GitHub down). */
  checkError: string | null
  phase: UpdatePhase
  /** The commit an update built, waiting for the restart. */
  ready: string | null
  /** What went wrong, one line; `detail` has the output. */
  error: string | null
  detail: string | null
  /** Commits that were installed but didn't start, so they went back. */
  failed: string[]
  /** The last update, from either end. */
  last: UpdateResult | null
  /** While `ready`: what the restart waits for ("the Coordinator", "a Captain"), so it doesn't cut a reply off. */
  waitingFor: string[]
  /** The repo's GitHub page, for "What's new"; null when updates come from elsewhere. */
  repoPage: string | null
}

export const UNMANAGED_UPDATE: UpdateStatus = {
  managed: false,
  current: null,
  latest: null,
  checkedAt: null,
  checking: false,
  checkError: null,
  phase: "idle",
  ready: null,
  error: null,
  detail: null,
  failed: [],
  last: null,
  waitingFor: [],
  repoPage: null,
}

/** Whether main has a commit this server doesn't run, and no update is under way or failed for it. */
export function updateAvailable(s: UpdateStatus): boolean {
  return s.managed && s.phase === "idle" && Boolean(s.latest && s.current && s.latest !== s.current)
}

/** "abc1234" */
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "unknown")

/** What each install step is called in the app. */
export const UPDATE_PHASE_LABEL: Record<UpdatePhase, string> = {
  idle: "",
  download: "Downloading the newest version",
  dependencies: "Installing its dependencies",
  build: "Building it",
  finish: "Finishing up",
  ready: "Ready",
  restarting: "Restarting",
  failed: "Failed",
}
