// Builds the Usage modal's ledger (shared/usageLedger.ts) from rows Store.usageLedger reads. Pure, so the rules are
// tested without a database:
//
// - LLM: each claude_usage row lands on the day it started, under its role, project, task, model and login. A row
//   runCost booked from a dip in the CLI's running session total (the whole session's total as one run's cost) is
//   charged its tokens at its session's own $/token instead (`isDipBooking`), and counted as an estimate.
// - Compute: what ran where comes from the box's metered intervals (Upstash, Daytona, Docker, this computer, SSH
//   machines) and, for RunPod and Vast.ai pods, which Box Yard doesn't meter, from the box history: a pod's "created"
//   event names its $/hr, and it bills until its "deleted" or "lost" event. Each stretch is split between the task
//   turns that ran on that box then (task_turns.box_id), equally between turns that overlap; time no turn ran is the
//   box's idle time. Docker, this computer and SSH machines are Cody's own hardware, so they cost $0.
import type { ComputeProvider, UsageComputeRow, UsageLedger, UsageLlmRow, UsageRole } from "../shared/usageLedger.js"
import { gpuBoxProvider, anyGpuBoxProject } from "../shared/gpu.js"
import { isDockerBox, dockerBoxProject } from "../shared/docker.js"
import { isMachineBox } from "../shared/machines.js"

/** A claude_usage row in the range, with what the dip check needs. */
export interface LedgerClaudeRow {
  source: string
  runKind: string
  projectId: string | null
  taskId: string | null
  sessionId: string | null
  model: string | null
  loginId: string | null
  startedAt: number
  costUsd: number
  /** The CLI's running session total this row was booked from (0: it reported none). */
  reportedUsd: number
  /** The session's previous report before this row (runCost's `prev`), or null. */
  prevReportedUsd: number | null
  /** runCost priced it from tokens (a resumed session's first report). */
  costEstimated: boolean
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

/** A metered box interval, its whole cost already priced (cost is linear in time, so a part costs its share). */
export interface LedgerInterval {
  boxId: string
  provider: string
  startedAt: number
  endedAt: number
  costUsd: number
  /** "actual": the provider's own figure; anything else is priced by Box Yard. */
  source: string
}

/** A RunPod or Vast.ai pod's life from the box history, at the $/hr its "created" event names. */
export interface LedgerPod {
  boxId: string
  provider: "runpod" | "vast"
  startedAt: number
  endedAt: number
  usdPerHour: number
}

/** A task turn and the box it ran on (null: not recorded, from before task_turns.box_id). */
export interface LedgerTurn {
  taskId: string
  projectId: string | null
  boxId: string | null
  startedAt: number
  endedAt: number
}

export interface LedgerInput {
  from: number
  to: number
  days: number[]
  claude: LedgerClaudeRow[]
  /** $/token for each session that has a dip booking, from its other runs (`sessionRates`). */
  sessionRates: Map<string, number>
  intervals: LedgerInterval[]
  pods: LedgerPod[]
  turns: LedgerTurn[]
  names: Pick<UsageLedger, "projects" | "tasks" | "boxes" | "logins">
  rates: UsageLedger["rates"]
}

/**
 * runCost booked this row from a small dip in the session's running total: it had an earlier report, the new one is
 * lower but not a real reset (at least half of it), and the whole report was booked as the run's cost. Compaction rows
 * carry no tokens but real cost, so they are judged by their reports, never by a token ratio. A row the server already
 * priced from its tokens (`cost_estimated`, as the booking does for a dip once it knows to) is left as it is.
 */
export function isDipBooking(r: Pick<LedgerClaudeRow, "reportedUsd" | "prevReportedUsd" | "costUsd"> & { costEstimated?: boolean }): boolean {
  const prev = r.prevReportedUsd
  return !r.costEstimated && prev !== null && prev > 0 && r.reportedUsd > 0 && r.reportedUsd < prev && r.reportedUsd >= prev / 2 && Math.abs(r.costUsd - r.reportedUsd) < 1e-9
}

const tokensOf = (r: LedgerClaudeRow) => r.inputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens + r.outputTokens

/** Each session's $/token from its runs that weren't dip bookings and had tokens. */
export function sessionRates(rows: LedgerClaudeRow[]): Map<string, number> {
  const sums = new Map<string, { usd: number; tokens: number }>()
  for (const r of rows) {
    if (!r.sessionId || isDipBooking(r) || tokensOf(r) <= 0) continue
    const s = sums.get(r.sessionId) ?? sums.set(r.sessionId, { usd: 0, tokens: 0 }).get(r.sessionId)!
    s.usd += r.costUsd
    s.tokens += tokensOf(r)
  }
  return new Map([...sums].map(([id, s]) => [id, s.usd / s.tokens]))
}

export function usageRole(r: Pick<LedgerClaudeRow, "source" | "runKind" | "projectId">): UsageRole {
  if (r.runKind === "thread") return "thread"
  if (r.source === "task") return "agent"
  if (r.source === "captain" || r.projectId) return "captain"
  return "coordinator"
}

/** Where a box ran, from its id (GPU, Docker and SSH boxes are named for it) and the provider that made it. */
export function computeProvider(boxId: string, provider: string): ComputeProvider {
  const gpu = gpuBoxProvider(boxId)
  if (gpu) return gpu
  if (isDockerBox(boxId) || provider === "docker") return "docker"
  if (isMachineBox(boxId) || provider === "ssh") return "ssh"
  if (provider === "upstash") return "upstash"
  return "local"
}

/** The project a box is named after (GPU pods, Docker containers), else null: Upstash boxes and folders are shared. */
export function boxProject(boxId: string): string | null {
  if (gpuBoxProvider(boxId)) return anyGpuBoxProject(boxId)
  if (isDockerBox(boxId)) return dockerBoxProject(boxId)
  return null
}

/** The day `t` falls in: the last day start at or before it (clamped to the range). */
function dayIndex(days: number[], t: number) {
  let lo = 0
  let hi = days.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (days[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function buildUsageLedger(input: LedgerInput): UsageLedger {
  const { from, to, days } = input
  const llm = new Map<string, UsageLlmRow>()
  const repriced = { runs: 0, bookedUsd: 0, chargedUsd: 0 }
  for (const r of input.claude) {
    if (r.startedAt < from || r.startedAt >= to) continue
    const tokens = tokensOf(r)
    let costUsd = r.costUsd
    let estimatedUsd = r.costEstimated ? r.costUsd : 0
    if (isDipBooking(r)) {
      costUsd = tokens * (input.sessionRates.get(r.sessionId ?? "") ?? 0)
      estimatedUsd = costUsd
      repriced.runs += 1
      repriced.bookedUsd += r.costUsd
      repriced.chargedUsd += costUsd
    }
    const day = dayIndex(days, r.startedAt)
    const role = usageRole(r)
    const model = r.model || "unknown"
    const key = [day, role, r.projectId, r.taskId, model, r.loginId].join("\u0000")
    const row =
      llm.get(key) ??
      llm
        .set(key, { day, role, projectId: r.projectId, taskId: r.taskId, model, loginId: r.loginId, costUsd: 0, estimatedUsd: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 })
        .get(key)!
    row.costUsd += costUsd
    row.estimatedUsd += estimatedUsd
    row.input += r.inputTokens
    row.cacheWrite += r.cacheCreationInputTokens
    row.cacheRead += r.cacheReadInputTokens
    row.output += r.outputTokens
    row.turns += tokens > 0 || r.costUsd > 0 ? 1 : 0
  }

  return { from, to, days, llm: [...llm.values()], compute: attributeCompute(input), repriced, ...input.names, rates: input.rates }
}

interface Piece {
  boxId: string
  provider: ComputeProvider
  startedAt: number
  endedAt: number
  costUsd: number
  estimated: boolean
}

/** Every box stretch in the range, split by the turns that ran on its box and by day. */
export function attributeCompute(input: Pick<LedgerInput, "from" | "to" | "days" | "intervals" | "pods" | "turns">): UsageComputeRow[] {
  const { from, to, days } = input
  const pieces: Piece[] = []
  const clip = (p: Piece) => {
    const s = Math.max(from, p.startedAt)
    const e = Math.min(to, p.endedAt)
    if (e <= s || p.endedAt <= p.startedAt) return
    const share = (e - s) / (p.endedAt - p.startedAt)
    pieces.push({ ...p, startedAt: s, endedAt: e, costUsd: p.costUsd * share })
  }
  for (const iv of input.intervals) {
    const provider = computeProvider(iv.boxId, iv.provider)
    const paid = provider === "upstash" || provider === "daytona"
    clip({ boxId: iv.boxId, provider, startedAt: iv.startedAt, endedAt: iv.endedAt, costUsd: paid ? iv.costUsd : 0, estimated: paid && iv.source !== "actual" })
  }
  for (const p of input.pods) clip({ boxId: p.boxId, provider: p.provider, startedAt: p.startedAt, endedAt: p.endedAt, costUsd: (p.usdPerHour * (p.endedAt - p.startedAt)) / 3_600_000, estimated: true })

  // The turns each box ran: recorded on it, or (unrecorded) a turn of the project a GPU or Docker box is named after.
  const byBox = new Map<string, LedgerTurn[]>()
  const unplaced = new Map<string, LedgerTurn[]>()
  for (const t of input.turns) {
    if (t.endedAt <= t.startedAt) continue
    const list = t.boxId ? byBox : unplaced
    const key = t.boxId ?? t.projectId ?? ""
    ;(list.get(key) ?? list.set(key, []).get(key)!).push(t)
  }
  const turnsOn = (boxId: string) => {
    const project = boxProject(boxId)
    return [...(byBox.get(boxId) ?? []), ...(project ? (unplaced.get(project) ?? []) : [])].sort((a, b) => a.startedAt - b.startedAt)
  }

  const rows = new Map<string, UsageComputeRow>()
  const add = (p: Piece, s: number, e: number, task: { taskId: string | null; projectId: string | null }, weight: number) => {
    // Split at day starts, so each day gets its own part.
    for (let a = s; a < e; ) {
      const day = dayIndex(days, a)
      const next = day + 1 < days.length ? Math.min(e, days[day + 1]!) : e
      const b = next > a ? next : e
      const share = ((b - a) / (p.endedAt - p.startedAt)) * weight
      const key = [day, p.provider, p.boxId, task.projectId, task.taskId].join("\u0000")
      const row = rows.get(key) ?? rows.set(key, { day, provider: p.provider, boxId: p.boxId, projectId: task.projectId, taskId: task.taskId, costUsd: 0, hours: 0, estimated: false }).get(key)!
      row.costUsd += p.costUsd * share
      row.hours += ((b - a) * weight) / 3_600_000
      if (p.estimated) row.estimated = true
      a = b
    }
  }

  const byBoxPieces = new Map<string, Piece[]>()
  for (const p of pieces) (byBoxPieces.get(p.boxId) ?? byBoxPieces.set(p.boxId, []).get(p.boxId)!).push(p)
  for (const [boxId, list] of byBoxPieces) {
    const turns = turnsOn(boxId)
    const idle = { taskId: null, projectId: boxProject(boxId) }
    list.sort((a, b) => a.startedAt - b.startedAt)
    // Sweep: turns that started before the piece ends, dropping those that ended before the earliest piece start still to come.
    let next = 0
    let open: LedgerTurn[] = []
    for (const p of list) {
      while (next < turns.length && turns[next]!.startedAt < p.endedAt) open.push(turns[next++]!)
      open = open.filter((t) => t.endedAt > p.startedAt)
      const here = open.filter((t) => t.startedAt < p.endedAt)
      if (!here.length) {
        add(p, p.startedAt, p.endedAt, idle, 1)
        continue
      }
      // Cut the piece wherever a turn starts or ends; each part goes to the turns running then, equally.
      const cuts = [...new Set([p.startedAt, p.endedAt, ...here.flatMap((t) => [t.startedAt, t.endedAt]).filter((c) => c > p.startedAt && c < p.endedAt)])].sort((a, b) => a - b)
      for (let i = 0; i + 1 < cuts.length; i++) {
        const s = cuts[i]!
        const e = cuts[i + 1]!
        const running = here.filter((t) => t.startedAt <= s && t.endedAt >= e)
        if (!running.length) add(p, s, e, idle, 1)
        else for (const t of running) add(p, s, e, { taskId: t.taskId, projectId: t.projectId }, 1 / running.length)
      }
    }
  }
  return [...rows.values()]
}
