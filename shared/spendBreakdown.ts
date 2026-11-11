// A task's or a Captain's LLM spend, run by run: what the $ in their headers opens (web/src/components/SpendBreakdown.tsx),
// from GET /api/tasks/:id/usage and GET /api/projects/:id/captain/usage. Built by server/spendBreakdown.ts from the
// claude_usage rows, priced as the Usage page prices them, so its total is what the Usage page charges the same runs.
import type { AgentCli } from "./agentCli.js"

/**
 * How a run's cost is known: the agent CLI reported it for the model the run used ("reported"), Box Yard worked it out
 * from the run's tokens ("estimated": a resumed session's first run, or a dip in the CLI's running total), or the CLI
 * reported tokens but no cost ("unknown": Codex and Cursor don't report one). An unknown cost counts as $0 in totals.
 */
export type SpendCost = "reported" | "estimated" | "unknown"

/** Spend and tokens over some runs. */
export interface SpendTotals {
  /** Reported plus estimated cost; runs with an unknown cost add nothing. */
  costUsd: number
  /** The part of costUsd Box Yard estimated from tokens. */
  estimatedUsd: number
  /** Runs that reported tokens but no cost, left out of costUsd. */
  unpricedRuns: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  runs: number
}

/** One model on one harness: the runs that ran on it. */
export interface SpendModel extends SpendTotals {
  model: string
  harness: AgentCli
}

/** One CLI run: a turn, a compaction, a /context check or a side thread's turn. */
export interface SpendRun {
  id: string
  /** The task it was for (a Captain's runs have none). */
  taskId: string | null
  startedAt: number
  durationMs: number
  /** claude_usage.run_kind: "turn", "compact", "context" or "thread". */
  kind: string
  /** The task's turn number (task_turns.turn_index), when it was a task turn. */
  turn: number | null
  model: string
  harness: AgentCli
  cost: SpendCost
  costUsd: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/** A subtask's own runs (not its own subtasks'), for its parent's breakdown. */
export interface SpendSubtask extends SpendTotals {
  taskId: string
  title: string
}

export interface SpendBreakdown {
  scope: "task" | "captain"
  /** Its own runs: the task's (not its subtasks'), or the Captain's (its chat, compactions and side threads). */
  total: SpendTotals
  /** total by model and harness, the most costly first; they add up to total. */
  byModel: SpendModel[]
  /** Its own runs, newest first: at most SPEND_RUN_LIMIT of them (total.runs counts them all). */
  runs: SpendRun[]
  /**
   * Runs whose booked cost was a dip in the CLI's running session total (the whole session's total booked as one run),
   * charged their tokens at their session's own rate instead, as the Usage page does. They count as estimated.
   */
  repriced: { runs: number; bookedUsd: number; chargedUsd: number }
  /** A task's subtasks, every level below it, apart from its own spend: null for a Captain, or a task with none. */
  subtasks: { total: SpendTotals; byModel: SpendModel[]; tasks: SpendSubtask[] } | null
}

export const SPEND_RUN_LIMIT = 200

export const emptySpend = (): SpendTotals => ({ costUsd: 0, estimatedUsd: 0, unpricedRuns: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, runs: 0 })

/** `into` plus `t`, in place. */
export function addSpend<T extends SpendTotals>(into: T, t: SpendTotals): T {
  into.costUsd += t.costUsd
  into.estimatedUsd += t.estimatedUsd
  into.unpricedRuns += t.unpricedRuns
  into.inputTokens += t.inputTokens
  into.cacheWriteTokens += t.cacheWriteTokens
  into.cacheReadTokens += t.cacheReadTokens
  into.outputTokens += t.outputTokens
  into.runs += t.runs
  return into
}

export const spendTokens = (t: Pick<SpendTotals, "inputTokens" | "cacheWriteTokens" | "cacheReadTokens" | "outputTokens">) =>
  t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens
