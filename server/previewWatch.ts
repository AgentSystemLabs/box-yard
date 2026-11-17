// Whether a task's previews still have a server behind them. A preview goes into the task's header when the agent
// reports it (report_preview) and stays while something answers on its port on the task's runner. A closed port is
// looked at again PREVIEW_CONFIRM_MS later, so a server restarting isn't taken for one stopped, and a port reported
// moments ago gets PREVIEW_GRACE_MS to start listening; closed both times, the preview leaves the task, live. It comes
// back when its port answers again on the same runner, as it does when the agent reports it again.
//
// A look is one short command on the runner (PORT_PROBE), and only a task with a preview (or one dropped on its runner)
// is ever looked at:
// - when a turn ends (its runner is up then);
// - every PREVIEW_CHECK_MS while a turn runs;
// - every PREVIEW_CHECK_MS while the task's page is open (the web asks: POST /api/tasks/:id/previews/check), only on a
//   runner that's up without waking it, never a sleeping box.

import type { PreviewLink } from "../shared/types.js"
import { q } from "./providers/types.js"

/** The least time between routine looks at one task's previews (while it works, or while its page is open). */
export const PREVIEW_CHECK_MS = 60_000
/** A closed port is looked at again this much later; closed both times, its preview goes. */
export const PREVIEW_CONFIRM_MS = 10_000
/** A port reported this recently may still be starting: closed, it's looked at again rather than counted as down. */
export const PREVIEW_GRACE_MS = 30_000

/** Why a look runs: a turn ended, a turn is running, the task's page is open, or the second look at a closed port. */
export type PreviewCheck = "turn_end" | "working" | "viewer" | "confirm"

export interface PreviewWatchDeps {
  /** The task's runner and previews now, or null when the task is gone. */
  task(taskId: string): { boxId: string | null; previews: PreviewLink[] } | null
  /** Which of `ports` something listens on, on the runner; null when it couldn't say (it's unreachable, say). */
  probe(boxId: string, ports: number[]): Promise<Set<number> | null>
  /** Whether a routine look may run on this runner: it's up without being woken or started for it. */
  awake(boxId: string): boolean
  /** A dropped preview coming back, with its URL got afresh (a signed one may have lapsed). Throws when it can't be had. */
  relink(boxId: string, link: PreviewLink): Promise<PreviewLink>
  /** Store the task's previews and tell the UI: `down` left them, `back` came back. */
  update(taskId: string, previews: PreviewLink[], change: { down: PreviewLink[]; back: PreviewLink[] }): void
  now?(): number
  /** The second look's delay; tests shorten it. */
  confirmMs?: number
}

interface Watched {
  boxId: string
  /** When the last look started (routine looks wait PREVIEW_CHECK_MS after it). */
  lastAt: number
  /** Ports found closed once, waiting for their second look. */
  missed: Set<number>
  /** Previews dropped as down on this runner, looked for again at every look. */
  dropped: Map<number, PreviewLink>
  /** When each port was last reported, for PREVIEW_GRACE_MS. */
  reportedAt: Map<number, number>
  busy: boolean
  /** A turn's end or a second look that came while a look ran: it runs right after. */
  again: PreviewCheck | null
  confirm: ReturnType<typeof setTimeout> | null
}

export class PreviewWatch {
  private readonly watched = new Map<string, Watched>()
  private stopped = false

  constructor(private readonly d: PreviewWatchDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  /** Whether the task has previews dropped on its runner, which a look could bring back. */
  hasDropped(taskId: string) {
    return (this.watched.get(taskId)?.dropped.size ?? 0) > 0
  }

  /** The agent (or a get_preview_url) reported this port: it's live whatever a look said, and gets its grace to start. */
  reported(taskId: string, boxId: string, port: number) {
    if (this.stopped) return
    const w = this.state(taskId, boxId)
    w.missed.delete(port)
    w.dropped.delete(port)
    w.reportedAt.set(port, this.now())
  }

  forget(taskId: string) {
    const w = this.watched.get(taskId)
    if (w?.confirm) clearTimeout(w.confirm)
    this.watched.delete(taskId)
  }

  stop() {
    this.stopped = true
    for (const id of [...this.watched.keys()]) this.forget(id)
  }

  /** Look at the task's previews now, if `why` allows a look now. Never throws. */
  async check(taskId: string, why: PreviewCheck): Promise<void> {
    if (this.stopped) return
    const t = this.d.task(taskId)
    if (!t?.boxId) return this.forget(taskId)
    let w = this.watched.get(taskId)
    if (w && w.boxId !== t.boxId) {
      // It moved: what was dropped was on the runner it left.
      this.forget(taskId)
      w = undefined
    }
    const ports = [...new Set([...t.previews.map((p) => p.port), ...(w?.dropped.keys() ?? [])])]
    if (!ports.length) return this.forget(taskId)
    const routine = why === "working" || why === "viewer"
    if (routine && w && this.now() - w.lastAt < PREVIEW_CHECK_MS) return
    if (routine && !this.d.awake(t.boxId)) return
    w ??= this.state(taskId, t.boxId)
    if (w.busy) {
      if (!routine) w.again = why
      return
    }
    w.busy = true
    w.lastAt = this.now()
    try {
      const up = await this.d.probe(t.boxId, ports).catch(() => null)
      if (up && !this.stopped) await this.settle(taskId, w, ports, up)
    } catch (err) {
      console.warn(`[box-yard] preview check for ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      w.busy = false
    }
    const again = w.again
    w.again = null
    if (again && this.watched.get(taskId) === w) await this.check(taskId, again)
  }

  private state(taskId: string, boxId: string): Watched {
    let w = this.watched.get(taskId)
    if (w && w.boxId !== boxId) {
      this.forget(taskId)
      w = undefined
    }
    if (!w) {
      w = { boxId, lastAt: 0, missed: new Set(), dropped: new Map(), reportedAt: new Map(), busy: false, again: null, confirm: null }
      this.watched.set(taskId, w)
    }
    return w
  }

  private async settle(taskId: string, w: Watched, probed: number[], up: Set<number>) {
    const answering: PreviewLink[] = []
    for (const [port, link] of w.dropped) {
      if (!up.has(port)) continue
      const fresh = await this.d.relink(w.boxId, link).catch(() => null)
      if (fresh) answering.push(fresh)
    }
    const t = this.d.task(taskId)
    if (this.stopped || !t || t.boxId !== w.boxId || this.watched.get(taskId) !== w) return
    const now = this.now()
    const down: PreviewLink[] = []
    const back: PreviewLink[] = []
    let starting = false
    const previews: PreviewLink[] = []
    for (const p of t.previews) {
      // Reported while the look ran: the next look decides.
      if (!probed.includes(p.port)) {
        previews.push(p)
        continue
      }
      const reportedAt = w.reportedAt.get(p.port)
      if (up.has(p.port)) {
        w.missed.delete(p.port)
        w.reportedAt.delete(p.port)
        previews.push(p)
      } else if (reportedAt !== undefined && now - reportedAt < PREVIEW_GRACE_MS) {
        starting = true
        previews.push(p)
      } else if (w.missed.has(p.port)) {
        w.missed.delete(p.port)
        w.reportedAt.delete(p.port)
        w.dropped.set(p.port, p)
        down.push(p)
      } else {
        w.missed.add(p.port)
        previews.push(p)
      }
    }
    for (const link of answering) {
      // Reported again while the look ran (reported() took it off the dropped list): that link stands.
      if (!w.dropped.has(link.port)) continue
      w.dropped.delete(link.port)
      if (previews.some((p) => p.port === link.port)) continue
      previews.push(link)
      back.push(link)
    }
    for (const port of w.missed) if (!previews.some((p) => p.port === port)) w.missed.delete(port)
    if (down.length || back.length) {
      previews.sort((a, b) => a.port - b.port)
      this.d.update(taskId, previews, { down, back })
    }
    if (w.missed.size || starting) this.confirmLater(taskId, w)
    else if (!previews.length && !w.dropped.size) this.forget(taskId)
  }

  private confirmLater(taskId: string, w: Watched) {
    if (w.confirm || this.stopped) return
    w.confirm = setTimeout(() => {
      w.confirm = null
      void this.check(taskId, "confirm")
    }, this.d.confirmMs ?? PREVIEW_CONFIRM_MS)
    w.confirm.unref?.()
  }
}

/**
 * Prints the JSON list of the ports (its arguments) something accepts a connection on: on loopback (IPv4 and IPv6, as
 * a dev server bound to "localhost" may be on either) or on one of the machine's own IPv4 addresses (one bound to a
 * single interface). Plain Node, as every runner has the Node that runs box-runner.mjs.
 */
const PORT_PROBE = `const net = require("node:net"), os = require("node:os")
const hosts = ["127.0.0.1", "::1"]
for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!a.internal && (a.family === "IPv4" || a.family === 4)) hosts.push(a.address)
const open = (port, host) => new Promise((done) => {
  const s = net.connect({ port, host })
  const end = (ok) => { s.destroy(); done(ok) }
  s.setTimeout(2000, () => end(false))
  s.once("connect", () => end(true))
  s.once("error", () => end(false))
})
const listening = async (port) => { for (const h of hosts) if (await open(port, h)) return true; return false }
Promise.all(process.argv.slice(1).map(Number).map(async (p) => ((await listening(p)) ? p : null))).then((up) => console.log(JSON.stringify(up.filter((p) => p !== null))))`

/** The command that probes `ports` on a runner, with the runner's Node. */
export function portProbeCommand(nodeBin: string, ports: number[]): string {
  const valid = ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  return `${q(nodeBin)} -e ${q(PORT_PROBE)} ${valid.join(" ")}`
}

/** The ports a probe found listening, or null when it didn't run or said nothing readable. */
export function parsePortProbe(exitCode: number, stdout: string): Set<number> | null {
  if (exitCode !== 0) return null
  const last = stdout.trim().split("\n").at(-1) ?? ""
  try {
    const ports = JSON.parse(last) as unknown
    if (!Array.isArray(ports) || !ports.every((p) => Number.isInteger(p))) return null
    return new Set(ports as number[])
  } catch {
    return null
  }
}
