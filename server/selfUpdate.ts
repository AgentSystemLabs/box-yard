// The app's Update button, on the server's side (docs/npx.md › Updates). The npx launcher (launcher/supervisor.mjs)
// starts this server with an IPC channel and does the work: it checks main's newest commit, builds it beside the
// running version, and restarts into it. This side relays the owner's clicks to it, shows its progress on the stream
// ("update" events), and holds the restart until no Coordinator, Captain or side-thread reply is running, since those
// run inside the server and a restart would cut them off (task agents run detached and carry on).
import { UNMANAGED_UPDATE, type UpdateStatus } from "../shared/selfUpdate.js"

export const UPDATE_MESSAGE = "box-yard:update"
export const STATUS_MESSAGE = "box-yard:update-status"
/** How often a built update looks again for a quiet moment to restart in. */
export const QUIET_POLL_MS = 3_000
/** The longest a built update waits for replies to finish before it restarts anyway (their sessions carry on). */
export const QUIET_MAX_WAIT_MS = 10 * 60_000

/** The launcher's end of the IPC channel: Node's `process`, when it has one. */
export interface UpdateChannel {
  send(message: unknown): unknown
  on(event: "message", listener: (message: unknown) => void): unknown
  connected?: boolean
}

export type UpdateAction = "hello" | "check" | "start" | "apply"

export interface SelfUpdateDeps {
  /** Null when this server wasn't started by the launcher (./yard, Docker, tests): nothing to update. */
  channel: UpdateChannel | null
  /** What's mid-reply right now ("the Coordinator", "a Captain"); empty when a restart would cut nothing off. */
  busy: () => string[]
  broadcast: (status: UpdateStatus) => void
  now?: () => number
  pollMs?: number
  maxWaitMs?: number
}

export class UpdateNotManagedError extends Error {
  readonly status = 409
  constructor() {
    super("This Box Yard wasn't started with npx, so it can't update itself. In a git checkout: git pull, then ./yard local.")
  }
}

export class SelfUpdate {
  private launcher: Omit<UpdateStatus, "managed" | "waitingFor"> | null = null
  private waitingFor: string[] = []
  private readySince: number | null = null
  private applied: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly d: SelfUpdateDeps) {
    this.now = d.now ?? Date.now
    if (!d.channel) return
    d.channel.on("message", (msg) => this.onMessage(msg))
    this.send("hello")
  }

  get managed() {
    return this.d.channel !== null
  }

  status(): UpdateStatus {
    if (!this.d.channel) return UNMANAGED_UPDATE
    return { ...UNMANAGED_UPDATE, ...(this.launcher ?? {}), managed: true, waitingFor: this.waitingFor }
  }

  /** Look at main for a newer commit now. */
  check() {
    this.need()
    this.send("check")
  }

  /** The owner pressed Update: build the newest main in the background. It restarts into it once replies finish. */
  start() {
    this.need()
    this.send("start")
  }

  /** Restart into the built update now, even mid-reply. */
  restartNow() {
    this.need()
    if (this.launcher?.phase !== "ready") return
    this.apply()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private need() {
    if (!this.d.channel) throw new UpdateNotManagedError()
  }

  private send(action: UpdateAction) {
    if (this.d.channel?.connected === false) return
    try {
      this.d.channel?.send({ type: UPDATE_MESSAGE, action })
    } catch (err) {
      console.error("[box-yard] couldn't reach the launcher:", (err as Error).message)
    }
  }

  private onMessage(msg: unknown) {
    const m = msg as { type?: unknown; status?: unknown }
    if (m?.type !== STATUS_MESSAGE || !m.status || typeof m.status !== "object") return
    this.launcher = m.status as UpdateStatus
    if (this.launcher.phase === "ready") this.waitForQuiet()
    else {
      this.stop()
      this.readySince = null
      this.waitingFor = []
      // A failed or rolled-back update can be built again and applied again.
      if (this.launcher.phase !== "restarting") this.applied = null
    }
    this.d.broadcast(this.status())
  }

  /** Built: restart as soon as nothing is mid-reply, or after QUIET_MAX_WAIT_MS. */
  private waitForQuiet() {
    this.readySince ??= this.now()
    if (this.timer) return
    const tick = () => {
      if (this.launcher?.phase !== "ready") return this.stop()
      const busy = this.d.busy()
      const waited = this.now() - (this.readySince ?? this.now())
      if (busy.length === 0 || waited >= (this.d.maxWaitMs ?? QUIET_MAX_WAIT_MS)) return this.apply()
      if (busy.join() !== this.waitingFor.join()) {
        this.waitingFor = busy
        this.d.broadcast(this.status())
      }
    }
    this.timer = setInterval(tick, this.d.pollMs ?? QUIET_POLL_MS)
    this.timer.unref?.()
    tick()
  }

  private apply() {
    const ready = this.launcher?.ready ?? null
    this.stop()
    // Once per build: the launcher answers "restarting", then this server stops.
    if (!ready || this.applied === ready) return
    this.applied = ready
    this.waitingFor = []
    this.send("apply")
  }
}

/** The launcher's channel, when this process has one and was started by it. */
export function launcherChannel(env: NodeJS.ProcessEnv = process.env, proc: NodeJS.Process = process): UpdateChannel | null {
  if (env.BOXYARD_LAUNCHER !== "1" || typeof proc.send !== "function") return null
  return proc as unknown as UpdateChannel
}
