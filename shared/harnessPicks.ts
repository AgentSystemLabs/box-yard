// Reusable harness → model → effort choices for typed tags and button drill-downs. The harness's value stays
// its CLI; the token carries the optional choices. Cursor's full live model id already includes its effort.
import { CODEX_MODELS, type AgentCli, type CursorModel } from "./agentCli.js"
import { BUILTIN_MODELS, EFFORT_LABEL, type ClaudeModel } from "./models.js"
import type { HarnessDefaults } from "./harnessDefaults.js"
import type { RunTarget } from "./runTargets.js"
import type { Effort } from "./types.js"

export interface HarnessPickSources {
  defaults: HarnessDefaults
  claude?: readonly ClaudeModel[]
  cursor: readonly CursorModel[]
}

/** Keep ordinary model ids readable; escape punctuation that otherwise separates a token or an effort. */
export const modelToken = (id: string) => encodeURIComponent(id).replace(/%5B/gi, "[").replace(/%5D/gi, "]").toLowerCase()

export function harnessModelTargets(harnesses: RunTarget[], sources: HarnessPickSources): RunTarget[] {
  return harnesses.flatMap((h): RunTarget[] => {
    const cli = h.value as AgentCli
    const saved = sources.defaults[cli]
    const effortWords = saved.effort === "orchestrator" ? "Automatic effort" : saved.effort ? `${EFFORT_LABEL[saved.effort]} effort` : null
    const defaultDetail = [saved.model || "CLI default", effortWords].filter(Boolean).join(" · ")
    const root = { ...h, defaultLabel: "Settings default", detail: defaultDetail }
    const models = cli === "codex" ? CODEX_MODELS : cli === "cursor" ? sources.cursor.map((m) => ({ ...m, efforts: [] as Effort[] })) : sources.claude ?? BUILTIN_MODELS
    return [root, ...models.flatMap((m): RunTarget[] => {
      const token = `${h.token}:${modelToken(m.id)}`
      const model: RunTarget = {
        ...h, token, under: h.token, model: m.id, label: `${h.label} · ${m.label}`, menuLabel: m.label,
        defaultLabel: "Default effort",
        detail: cli === "cursor" ? "Effort is included in the model ID" : m.efforts.length ? effortWords ?? "Settings effort" : "No effort level",
      }
      return [model, ...m.efforts.map((effort): RunTarget => ({
        ...model, token: `${token}:${effort}`, under: token, effort,
        label: `${h.label} · ${m.label} · ${EFFORT_LABEL[effort]}`,
        menuLabel: EFFORT_LABEL[effort],
        detail: `${EFFORT_LABEL[effort]} effort`, defaultLabel: undefined,
      }))]
    })]
  })
}
