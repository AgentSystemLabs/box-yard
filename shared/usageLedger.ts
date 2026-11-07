// The Usage modal's data (GET /api/usage/daily, server/usageLedger.ts builds it): every day's LLM spend and tokens per
// role, project, task, model and login, and every day's compute per provider, box, project and task. The server sends
// it flat; `aggregateUsage` filters it and folds it into the charts' stacked series and the breakdown table, so a
// drill-down needs no new request. Every view of it sums to the same total: the series, the days and the table rows.
import { BUILTIN_MODELS, findModel } from "./models.js"

export const USAGE_RANGES = [7, 30, 60, 90] as const
export type UsageRangeDays = (typeof USAGE_RANGES)[number]

/** Today's local midnight and the n-1 before it, oldest first (DST days are 23 or 25 hours, as the calendar has them). */
export function localDayStarts(n: number, now: number): number[] {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (n - 1))
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(d)
    day.setDate(d.getDate() + i)
    return day.getTime()
  })
}

/** Who ran the LLM call: a task's agent (scheduled runs included), a Captain, the Coordinator, or a side question. */
export const USAGE_ROLES = ["agent", "captain", "coordinator", "thread"] as const
export type UsageRole = (typeof USAGE_ROLES)[number]
export const USAGE_ROLE_LABEL: Record<UsageRole, string> = { agent: "Task agents", captain: "Captains", coordinator: "Coordinator", thread: "Side questions" }

/** Where a task's turns ran. Docker, this computer and SSH machines are Cody's own hardware: they cost $0 here. */
export const COMPUTE_PROVIDERS = ["upstash", "daytona", "runpod", "vast", "docker", "local", "ssh"] as const
export type ComputeProvider = (typeof COMPUTE_PROVIDERS)[number]
export const COMPUTE_PROVIDER_LABEL: Record<ComputeProvider, string> = {
  upstash: "Upstash box",
  daytona: "Daytona sandbox",
  runpod: "RunPod GPU",
  vast: "Vast.ai GPU",
  docker: "Docker",
  local: "This computer",
  ssh: "SSH machine",
}
/** Providers Box Yard prices; the rest run on Cody's own hardware. */
export const PAID_PROVIDERS: readonly ComputeProvider[] = ["upstash", "daytona", "runpod", "vast"]

export const TOKEN_KINDS = ["input", "cacheWrite", "cacheRead", "output"] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]
export const TOKEN_KIND_LABEL: Record<TokenKind, string> = { input: "Input", cacheWrite: "Cache write", cacheRead: "Cache read", output: "Output" }

/** One day's LLM usage for one role, project, task, model and login. */
export interface UsageLlmRow {
  /** Index into UsageLedger.days. */
  day: number
  role: UsageRole
  projectId: string | null
  taskId: string | null
  model: string
  loginId: string | null
  costUsd: number
  /** The part of costUsd that is an estimate (repriced runs, see UsageLedger.repriced, and runs the CLI didn't price). */
  estimatedUsd: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  /** Runs that did work (a /context probe or a failed start logs a row with no tokens and no cost). */
  turns: number
}

/** One day of one box's compute, or the part of it one task's turns ran in (taskId null: time no turn ran). */
export interface UsageComputeRow {
  day: number
  provider: ComputeProvider
  boxId: string
  projectId: string | null
  taskId: string | null
  costUsd: number
  /** Box-hours of uptime. */
  hours: number
  /** Priced from size × time at list or Settings rates, not a provider's own bill. */
  estimated: boolean
}

export interface UsageLedger {
  from: number
  to: number
  /** Start of each day (local midnights, as the client sent them). */
  days: number[]
  llm: UsageLlmRow[]
  compute: UsageComputeRow[]
  projects: Record<string, string>
  tasks: Record<string, { title: string; projectId: string | null }>
  boxes: Record<string, { label: string; size: string | null }>
  logins: Record<string, string>
  /**
   * Runs whose cost the server's booking got wrong (server/store.ts runCost: a dip in the CLI's running session total
   * booked the whole total as one run's cost). They are charged their tokens at their session's own $/token instead.
   */
  repriced: { runs: number; bookedUsd: number; chargedUsd: number }
  /** The rates compute is priced at, for the "how is this estimated" note. */
  rates: { upstashCpuHourUsd: Record<string, number>; daytona: { vcpuHour: number; memoryGibHour: number } }
}

/** Drill-down: every set field narrows the ledger. NONE stands for "no project" / "no task". */
export interface UsageFilter {
  projectId?: string
  taskId?: string
  model?: string
  provider?: ComputeProvider
  role?: UsageRole
  /** Only LLM spend or only compute. */
  kind?: "llm" | "compute"
}
export const NONE = "~none"

const matchId = (want: string | undefined, id: string | null) => want === undefined || (want === NONE ? id === null : want === id)

export function llmMatches(r: UsageLlmRow, f: UsageFilter) {
  if (f.kind === "compute" || f.provider) return false
  if (f.role && f.role !== r.role) return false
  if (f.model && f.model !== r.model) return false
  return matchId(f.projectId, r.projectId) && matchId(f.taskId, r.taskId)
}

/** Compute has no model or role; a task's box time counts as its agent's ("agent"). */
export function computeMatches(r: UsageComputeRow, f: UsageFilter) {
  if (f.kind === "llm" || f.model) return false
  if (f.role && (f.role !== "agent" || !r.taskId)) return false
  if (f.provider && f.provider !== r.provider) return false
  return matchId(f.projectId, r.projectId) && matchId(f.taskId, r.taskId)
}

/** "Opus 5.5" for claude-opus-5-5 (and its dated ids), else the id as the CLI reported it. */
export const modelLabel = (id: string) => (id === "unknown" ? "Unknown model" : (findModel(BUILTIN_MODELS, id)?.label ?? id))

/** A stacked series: one model, the other models together, or one compute provider. */
export interface UsageSeries {
  key: string
  label: string
  kind: "llm" | "compute"
  /** Index into USAGE_COLORS; -1: the neutral "other" gray. */
  color: number
  /** Tapping it narrows to it. Null: the folded "Other models", which has no single filter. */
  filter: UsageFilter | null
  totalUsd: number
  daily: number[]
  estimated: boolean
}

/**
 * Categorical colours, validated as a stacked set on the app's dark surface (dataviz validate_palette.js: CVD ΔE ≥ 8,
 * normal-vision ΔE ≥ 15 between neighbours): three model slots, then Upstash, Daytona, RunPod, Vast.ai.
 */
export const USAGE_COLORS = ["#3987e5", "#d95926", "#9085e9", "#199e70", "#c98500", "#d55181", "#008300"] as const
export const OTHER_COLOR = "#71717a"
export const TOKEN_COLORS: Record<TokenKind, string> = { input: "#3987e5", cacheWrite: "#d95926", cacheRead: "#199e70", output: "#9085e9" }
const MODEL_SLOTS = 3
const PROVIDER_COLOR: Partial<Record<ComputeProvider, number>> = { upstash: 3, daytona: 4, runpod: 5, vast: 6 }

/**
 * Which models get their own colour: the dearest three over the whole loaded range, unfiltered, so a filter never
 * repaints a model. The rest fold into "Other models".
 */
export function modelSlots(ledger: UsageLedger): Map<string, number> {
  const cost = new Map<string, number>()
  for (const r of ledger.llm) cost.set(r.model, (cost.get(r.model) ?? 0) + r.costUsd)
  const top = [...cost.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MODEL_SLOTS)
  return new Map(top.map(([m], i) => [m, i]))
}

export type UsageGroup = "project" | "task" | "model" | "provider" | "role" | "login" | "box"
export const USAGE_GROUP_LABEL: Record<UsageGroup, string> = { project: "Project", task: "Task", model: "Model", provider: "Provider", role: "Role", login: "Login", box: "Box" }

export interface UsageTableRow {
  key: string
  label: string
  detail: string | null
  /** Narrows to this row; null when it has none (a deleted task's rows). */
  filter: UsageFilter | null
  llmUsd: number
  computeUsd: number
  costUsd: number
  tokens: number
  turns: number
  computeHours: number
  /** Some of its cost is an estimate. */
  estimated: boolean
}

export interface TokenTotals {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  total: number
}

export interface UsageView {
  days: number[]
  totals: {
    costUsd: number
    llmUsd: number
    computeUsd: number
    /** The estimated part of costUsd: compute priced from size × time, and repriced or unpriced LLM runs. */
    estimatedUsd: number
    tokens: TokenTotals
    turns: number
    computeHours: number
  }
  /** Stacked cost, bottom first: models by colour slot, other models, then compute providers. */
  cost: UsageSeries[]
  costByDay: number[]
  tokens: { kind: TokenKind; label: string; total: number; daily: number[] }[]
  tokensByDay: number[]
  rows: UsageTableRow[]
}

const zeroTokens = (): TokenTotals => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 })

/** The ledger narrowed by `filter`, as the modal's numbers, charts and `group` table. */
export function aggregateUsage(ledger: UsageLedger, filter: UsageFilter, group: UsageGroup, slots = modelSlots(ledger)): UsageView {
  const n = ledger.days.length
  const zeros = () => new Array<number>(n).fill(0)
  const totals = { costUsd: 0, llmUsd: 0, computeUsd: 0, estimatedUsd: 0, tokens: zeroTokens(), turns: 0, computeHours: 0 }
  const series = new Map<string, UsageSeries>()
  const seriesFor = (key: string, init: () => Omit<UsageSeries, "key" | "totalUsd" | "daily" | "estimated">) =>
    series.get(key) ?? series.set(key, { key, ...init(), totalUsd: 0, daily: zeros(), estimated: false }).get(key)!
  const tokenDaily: Record<TokenKind, number[]> = { input: zeros(), cacheWrite: zeros(), cacheRead: zeros(), output: zeros() }
  const table = new Map<string, UsageTableRow>()
  const rowFor = (g: { key: string; label: string; detail: string | null; filter: UsageFilter | null }) =>
    table.get(g.key) ?? table.set(g.key, { ...g, llmUsd: 0, computeUsd: 0, costUsd: 0, tokens: 0, turns: 0, computeHours: 0, estimated: false }).get(g.key)!
  // Thousands of rows share a few dozen series and table rows: each is looked up by the one field its key comes from
  // (groupId), so a row builds no key, group or closure. Every sum still adds in the ledger's order.
  const modelSeries = new Map<string, UsageSeries>()
  const providerSeries = new Map<ComputeProvider, UsageSeries | null>()
  const llmRows = new Map<string | null, UsageTableRow>()
  const computeRows = new Map<string | null, UsageTableRow | null>()
  const { input, cacheWrite, cacheRead, output } = tokenDaily

  for (const r of ledger.llm) {
    if (!llmMatches(r, filter)) continue
    const tokens = r.input + r.cacheWrite + r.cacheRead + r.output
    totals.costUsd += r.costUsd
    totals.llmUsd += r.costUsd
    totals.estimatedUsd += r.estimatedUsd
    totals.turns += r.turns
    totals.tokens.input += r.input
    input[r.day]! += r.input
    totals.tokens.cacheWrite += r.cacheWrite
    cacheWrite[r.day]! += r.cacheWrite
    totals.tokens.cacheRead += r.cacheRead
    cacheRead[r.day]! += r.cacheRead
    totals.tokens.output += r.output
    output[r.day]! += r.output
    totals.tokens.total += tokens
    let s = modelSeries.get(r.model)
    if (!s) {
      const slot = slots.get(r.model)
      s =
        slot === undefined
          ? seriesFor("other-models", () => ({ label: "Other models", kind: "llm", color: -1, filter: null }))
          : seriesFor(`model:${r.model}`, () => ({ label: modelLabel(r.model), kind: "llm", color: slot, filter: { model: r.model } }))
      modelSeries.set(r.model, s)
    }
    s.totalUsd += r.costUsd
    s.daily[r.day]! += r.costUsd
    if (r.estimatedUsd > 0) s.estimated = true
    const id = llmGroupId(r, group)
    let row = llmRows.get(id)
    if (!row) llmRows.set(id, (row = rowFor(llmGroup(ledger, r, group))))
    row.llmUsd += r.costUsd
    row.costUsd += r.costUsd
    row.tokens += tokens
    row.turns += r.turns
    if (r.estimatedUsd > 0) row.estimated = true
  }

  for (const r of ledger.compute) {
    if (!computeMatches(r, filter)) continue
    totals.costUsd += r.costUsd
    totals.computeUsd += r.costUsd
    totals.computeHours += r.hours
    if (r.estimated) totals.estimatedUsd += r.costUsd
    let s = providerSeries.get(r.provider)
    if (s === undefined) {
      const color = PROVIDER_COLOR[r.provider]
      // $0 providers (Cody's own hardware) have nothing to stack; the table still lists their hours.
      s = color === undefined ? null : seriesFor(`provider:${r.provider}`, () => ({ label: COMPUTE_PROVIDER_LABEL[r.provider], kind: "compute", color, filter: { provider: r.provider } }))
      providerSeries.set(r.provider, s)
    }
    if (s) {
      s.totalUsd += r.costUsd
      s.daily[r.day]! += r.costUsd
      if (r.estimated && r.costUsd > 0) s.estimated = true
    }
    const id = computeGroupId(r, group)
    let row = computeRows.get(id)
    if (row === undefined) {
      const g = computeGroup(ledger, r, group)
      computeRows.set(id, (row = g && rowFor(g)))
    }
    if (!row) continue
    row.computeUsd += r.costUsd
    row.costUsd += r.costUsd
    row.computeHours += r.hours
    if (r.estimated && r.costUsd > 0) row.estimated = true
  }

  const order = (s: UsageSeries) => (s.kind === "llm" ? (s.color < 0 ? MODEL_SLOTS : s.color) : 10 + s.color)
  const cost = [...series.values()].filter((s) => s.totalUsd > 0).sort((a, b) => order(a) - order(b))
  const costByDay = zeros()
  for (const s of cost) s.daily.forEach((v, i) => (costByDay[i]! += v))
  const tokens = TOKEN_KINDS.map((kind) => ({ kind, label: TOKEN_KIND_LABEL[kind], total: totals.tokens[kind], daily: tokenDaily[kind] }))
  const tokensByDay = zeros().map((_, i) => TOKEN_KINDS.reduce((sum, k) => sum + tokenDaily[k][i]!, 0))
  const rows = [...table.values()].filter((r) => r.costUsd > 0 || r.tokens > 0 || r.computeHours > 0).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.label.localeCompare(b.label))
  return { days: ledger.days, totals, cost, costByDay, tokens, tokensByDay, rows }
}

/** The field llmGroup's key comes from, in this table. */
function llmGroupId(r: UsageLlmRow, group: UsageGroup): string | null {
  switch (group) {
    case "project":
      return r.projectId
    case "task":
      return r.taskId
    case "model":
      return r.model
    case "role":
      return r.role
    case "login":
      return r.loginId
    case "provider":
    case "box":
      return null
  }
}

/** The field computeGroup's key comes from, in this table. */
function computeGroupId(r: UsageComputeRow, group: UsageGroup): string | null {
  switch (group) {
    case "project":
      return r.projectId
    case "task":
    case "role":
      return r.taskId
    case "provider":
      return r.provider
    case "box":
      return r.boxId
    case "model":
    case "login":
      return null
  }
}

type Group = { key: string; label: string; detail: string | null; filter: UsageFilter | null }

const projectName = (l: UsageLedger, id: string | null) => (id ? (l.projects[id] ?? "Deleted project") : null)

function taskGroup(l: UsageLedger, taskId: string | null, projectId: string | null, none: string): Group {
  if (!taskId) return { key: `task:${NONE}`, label: none, detail: null, filter: { taskId: NONE } }
  const t = l.tasks[taskId]
  return { key: `task:${taskId}`, label: t?.title ?? "Deleted task", detail: projectName(l, t?.projectId ?? projectId), filter: { taskId } }
}

function llmGroup(l: UsageLedger, r: UsageLlmRow, group: UsageGroup): Group {
  switch (group) {
    case "project":
      return r.projectId
        ? { key: `project:${r.projectId}`, label: projectName(l, r.projectId)!, detail: null, filter: { projectId: r.projectId } }
        : { key: `project:${NONE}`, label: "No project", detail: "The Coordinator, and boxes no task was using", filter: { projectId: NONE } }
    case "task":
      return taskGroup(l, r.taskId, r.projectId, "Not a task: Coordinator, Captains, side questions")
    case "model":
      return { key: `model:${r.model}`, label: modelLabel(r.model), detail: r.model === modelLabel(r.model) ? null : r.model, filter: { model: r.model } }
    case "role":
      return { key: `role:${r.role}`, label: USAGE_ROLE_LABEL[r.role], detail: null, filter: { role: r.role } }
    case "login":
      return r.loginId
        ? { key: `login:${r.loginId}`, label: l.logins[r.loginId] ?? "Removed login", detail: null, filter: null }
        : { key: "login:usual", label: "Usual login", detail: "Not from the rotation", filter: null }
    case "provider":
    case "box":
      return { key: "llm", label: "LLM (Claude, Codex, Cursor)", detail: "Model calls", filter: { kind: "llm" } }
  }
}

/** Null: compute has no row in this table (by model or login, the table is LLM spend only). */
function computeGroup(l: UsageLedger, r: UsageComputeRow, group: UsageGroup): Group | null {
  switch (group) {
    case "project":
      return r.projectId
        ? { key: `project:${r.projectId}`, label: projectName(l, r.projectId)!, detail: null, filter: { projectId: r.projectId } }
        : { key: `project:${NONE}`, label: "No project", detail: "The Coordinator, and boxes no task was using", filter: { projectId: NONE } }
    case "task":
      return r.taskId ? taskGroup(l, r.taskId, r.projectId, "") : { key: "task:idle", label: "Idle box time", detail: "Boxes up while no turn ran on them", filter: { taskId: NONE, kind: "compute" } }
    case "provider":
      return { key: `provider:${r.provider}`, label: COMPUTE_PROVIDER_LABEL[r.provider], detail: PAID_PROVIDERS.includes(r.provider) ? null : "Your own hardware: $0", filter: { provider: r.provider } }
    case "box": {
      const b = l.boxes[r.boxId]
      return { key: `box:${r.boxId}`, label: b?.label ?? r.boxId, detail: [COMPUTE_PROVIDER_LABEL[r.provider], b?.size].filter(Boolean).join(" · "), filter: { provider: r.provider } }
    }
    case "role":
      return r.taskId ? { key: "role:agent", label: USAGE_ROLE_LABEL.agent, detail: null, filter: { role: "agent" } } : { key: "role:idle", label: "Idle box time", detail: "No role: no turn ran", filter: { taskId: NONE, kind: "compute" } }
    case "model":
    case "login":
      return { key: "compute", label: "Compute (boxes)", detail: "Not a model call", filter: { kind: "compute" } }
  }
}

/** The next table after drilling into a row, so each tap goes one level finer. */
export function nextGroup(group: UsageGroup, filter: UsageFilter): UsageGroup {
  if (group === "project") return "task"
  if (group === "task") return filter.kind === "compute" || filter.provider ? "box" : "model"
  if (group === "role") return filter.role === "agent" ? "project" : "model"
  if (group === "provider") return "box"
  if (group === "model") return "project"
  return group
}

/** "Opus 5.5 · RunPod GPU": what a filter narrows to, for its chip. */
export function filterLabel(l: UsageLedger, key: keyof UsageFilter, value: string): string {
  switch (key) {
    case "projectId":
      return value === NONE ? "No project" : (l.projects[value] ?? "Deleted project")
    case "taskId":
      return value === NONE ? "No task" : (l.tasks[value]?.title ?? "Deleted task")
    case "model":
      return modelLabel(value)
    case "provider":
      return COMPUTE_PROVIDER_LABEL[value as ComputeProvider] ?? value
    case "role":
      return USAGE_ROLE_LABEL[value as UsageRole] ?? value
    case "kind":
      return value === "llm" ? "LLM only" : "Compute only"
  }
}
