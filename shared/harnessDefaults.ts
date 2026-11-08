import { DEFAULT_CODEX_EFFORT, DEFAULT_CODEX_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENCODE_MODEL, type AgentCli } from "./agentCli.js"
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type Settings } from "./types.js"

export type HarnessDefaults = Record<AgentCli, { model: string; effort: AgentEffort | null }>
type HarnessSettings = Pick<Settings, "agentModel" | "agentEffort" | "agentCodexModel" | "agentCodexEffort" | "agentCursorModel" | "agentOpencodeModel">

/** Saved per-harness defaults, also usable before Settings has loaded. Empty models keep the CLI's own default. */
export function harnessDefaults(settings?: Partial<HarnessSettings>): HarnessDefaults {
  return {
    claude: { model: settings?.agentModel ?? DEFAULT_MODEL, effort: settings?.agentEffort ?? DEFAULT_EFFORT },
    codex: { model: settings?.agentCodexModel ?? DEFAULT_CODEX_MODEL, effort: settings?.agentCodexEffort ?? DEFAULT_CODEX_EFFORT },
    opencode: { model: settings?.agentOpencodeModel ?? DEFAULT_OPENCODE_MODEL, effort: null },
    cursor: { model: settings?.agentCursorModel ?? DEFAULT_CURSOR_MODEL, effort: null },
  }
}
