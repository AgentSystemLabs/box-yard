// Builds a task's or a Captain's cost breakdown (shared/spendBreakdown.ts) from the claude_usage rows Store.taskSpend and
// Store.captainSpend read. Pure, so the rules are tested without a database:
//
// - Each row is one CLI run's own share (claude_usage.cost_usd and its tokens: the step from the session's previous
//   report), never the CLI's running session totals (total_cost_usd, modelUsage), so runs add up to the total.
// - A row booked from a dip in the session's running total is charged its tokens at its session's own $/token, as the
//   Usage page's ledger does (server/usageLedger.ts isDipBooking), so both charge the same runs the same.
// - Each run is under the model it ran on (claude_usage.model: for a task turn, the model its turn started on), not
//   the task's model now, and the harness that ran it. Rows from before claude_usage.harness take the task's harness,
//   or for a Captain the model's name (an OpenAI model ran on Codex).
// - A row with neither tokens nor cost (a run that failed before it did anything) isn't a run.
import { DEFAULT_AGENT_CLI, isAgentCli, isOpenAiModel, type AgentCli } from "../shared/agentCli.js"
import { addSpend, emptySpend, SPEND_RUN_LIMIT, spendTokens, type SpendBreakdown, type SpendCost, type SpendModel, type SpendRun, type SpendSubtask, type SpendTotals } from "../shared/spendBreakdown.js"
import { isDipBooking, type LedgerClaudeRow } from "./usageLedger.js"

/** A claude_usage row as Store reads it for a breakdown: the ledger's columns and the run's own. */
export interface SpendRow extends LedgerClaudeRow {
  id: string
  harness: string | null
  turnId: string | null
  durationMs: number
}

export interface SpendTask {
  id: string
  title: string
  agentCli: string | null
}

export interface SpendInput {
  scope: "task" | "captain"
  rows: SpendRow[]
  /** $/token for each session that has a dip booking (usageLedger.ts sessionRates). */
  sessionRates: Map<string, number>
  /** A task's breakdown: the task first, then its subtasks at every level. */
  tasks?: SpendTask[]
  /** The task's turns: id → turn number. */
  turnIndex?: Map<string, number>
}

const tokensOf = (r: LedgerClaudeRow) => r.inputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens + r.outputTokens

/** What a run is charged and how that's known (SpendCost), or null when it isn't a run. */
export function priceRun(r: LedgerClaudeRow, sessionRates: Map<string, number>): { cost: SpendCost; costUsd: number; repriced: boolean } | null {
  const tokens = tokensOf(r)
  if (isDipBooking(r)) return { cost: "estimated", costUsd: tokens * (sessionRates.get(r.sessionId ?? "") ?? 0), repriced: true }
  if (r.costEstimated) return { cost: "estimated", costUsd: r.costUsd, repriced: false }
  if (r.reportedUsd > 0 || r.costUsd > 0) return { cost: "reported", costUsd: r.costUsd, repriced: false }
  if (tokens > 0) return { cost: "unknown", costUsd: 0, repriced: false }
  return null
}

/** The CLI that ran it: as logged, else (older rows) the task's harness, or for a Captain run its model's. */
export function runHarness(r: Pick<SpendRow, "harness" | "source" | "taskId" | "model">, taskCli: ReadonlyMap<string, AgentCli>): AgentCli {
  if (isAgentCli(r.harness)) return r.harness
  if (r.source === "task") return (r.taskId && taskCli.get(r.taskId)) || DEFAULT_AGENT_CLI
  return isOpenAiModel(r.model) ? "codex" : DEFAULT_AGENT_CLI
}

const byCost = (a: SpendTotals, b: SpendTotals) => b.costUsd - a.costUsd || spendTokens(b) - spendTokens(a)

function modelRow(rows: Map<string, SpendModel>, model: string, harness: AgentCli): SpendModel {
  const key = `${harness}\u0000${model}`
  return rows.get(key) ?? rows.set(key, { model, harness, ...emptySpend() }).get(key)!
}

export function buildSpend(input: SpendInput): SpendBreakdown {
  const tasks = input.tasks ?? []
  const own = input.scope === "task" ? (tasks[0]?.id ?? null) : null
  const taskCli = new Map(tasks.map((t) => [t.id, isAgentCli(t.agentCli) ? t.agentCli : DEFAULT_AGENT_CLI]))
  const total = emptySpend()
  const byModel = new Map<string, SpendModel>()
  const runs: SpendRun[] = []
  const repriced = { runs: 0, bookedUsd: 0, chargedUsd: 0 }
  const sub = { total: emptySpend(), byModel: new Map<string, SpendModel>() }
  const subtasks = new Map<string, SpendSubtask>(tasks.slice(1).map((t) => [t.id, { taskId: t.id, title: t.title, ...emptySpend() }]))

  for (const r of input.rows) {
    const price = priceRun(r, input.sessionRates)
    if (!price) continue
    const harness = runHarness(r, taskCli)
    const model = r.model || "unknown"
    const one: SpendTotals = {
      costUsd: price.costUsd,
      estimatedUsd: price.cost === "estimated" ? price.costUsd : 0,
      unpricedRuns: price.cost === "unknown" ? 1 : 0,
      inputTokens: r.inputTokens,
      cacheWriteTokens: r.cacheCreationInputTokens,
      cacheReadTokens: r.cacheReadInputTokens,
      outputTokens: r.outputTokens,
      runs: 1,
    }
    const subtask = r.taskId && r.taskId !== own ? subtasks.get(r.taskId) : undefined
    if (subtask) {
      addSpend(subtask, one)
      addSpend(sub.total, one)
      addSpend(modelRow(sub.byModel, model, harness), one)
      continue
    }
    if (input.scope === "task" && r.taskId !== own) continue
    addSpend(total, one)
    addSpend(modelRow(byModel, model, harness), one)
    if (price.repriced) {
      repriced.runs += 1
      repriced.bookedUsd += r.costUsd
      repriced.chargedUsd += price.costUsd
    }
    runs.push({
      id: r.id,
      taskId: r.taskId,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      kind: r.runKind,
      turn: r.turnId ? (input.turnIndex?.get(r.turnId) ?? null) : null,
      model,
      harness,
      cost: price.cost,
      costUsd: price.costUsd,
      inputTokens: r.inputTokens,
      cacheWriteTokens: r.cacheCreationInputTokens,
      cacheReadTokens: r.cacheReadInputTokens,
      outputTokens: r.outputTokens,
    })
  }

  runs.sort((a, b) => b.startedAt - a.startedAt)
  return {
    scope: input.scope,
    total,
    byModel: [...byModel.values()].sort(byCost),
    runs: runs.slice(0, SPEND_RUN_LIMIT),
    repriced,
    subtasks: subtasks.size ? { total: sub.total, byModel: [...sub.byModel.values()].sort(byCost), tasks: [...subtasks.values()].sort(byCost) } : null,
  }
}
