import type { AgentCli } from "./agentCli.js"
import type { Effort } from "./types.js"

/** An explicit continuation affects this task only. Omission retains its harness and pinned choices. */
export interface TaskContinuation {
  /** Resolve the project's current default (then Settings) once, or choose a harness explicitly. */
  agent?: AgentCli | "default"
  /** null clears a pin; a harness change clears all old model/effort/routing pins. */
  model?: string | null
  effort?: Effort | null
  message?: string
}

/** Durable until a new CLI process starts, including across failed workspace restores/server restarts. */
export interface HarnessHandoff {
  from: AgentCli
  to: AgentCli
  needsWorkspace: boolean
}

export const harnessHandoffKey = (taskId: string) => `harness_handoff:${taskId}`
