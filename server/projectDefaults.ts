// A project's live defaults for new tasks: where they run, on which harness, with which model and effort, and where
// each one comes from (TaskManager.projectDefaults reads them fresh). A Captain sees them on every turn's
// [Project now], the Coordinator next to a project its message names, and list_projects shows Runs on. The task
// tools' replies say when a call's own runs_on or agent leaves them (overridesDefault), so a rule remembered from an
// old summary can't quietly beat the project's settings.

import { cliForModel, type AgentCli } from "../shared/agentCli.js"
import type { Runner } from "../shared/runner.js"
import type { Effort } from "../shared/types.js"
import type { RouteLayer } from "./routing.js"

/** Where a default comes from, as the line says it. */
export type DefaultSource = "project" | "Settings" | "routing" | "built-in"

export interface ProjectDefaults {
  /** The project's own Runs on (Project.runner): new tasks run there unless a call passes runs_on. */
  runner: Runner
  /** On SSH machines, the label or machine name its tasks pick from; null: any machine. */
  machineLabel: string | null
  /** The harness new tasks start on: the project's Agent, else Settings › Box agents. */
  agent: AgentCli
  agentFrom: "project" | "Settings"
  /** null: the CLI's own default model. */
  model: string | null
  modelFrom: DefaultSource
  /** null: the harness takes no effort (Cursor carries it in its model id, OpenCode in its variant). */
  effort: Effort | null
  effortFrom: DefaultSource
  /** Settings › Box agents › Effort leaves it to the caller ("Let the Coordinator decide"). */
  effortYours: boolean
}

/** A routing layer as a source: the routing config's projects, defaults and fallback entries are all "routing". */
export const layerSource = (layer: RouteLayer): DefaultSource => (layer === "settings" ? "Settings" : layer === "builtin" ? "built-in" : "routing")

/** The project's Runs on as a runs_on value: "local", "box", "label:gpu" for SSH machines with a label. */
export const runsOnLabel = (d: Pick<ProjectDefaults, "runner" | "machineLabel">): string => (d.runner === "ssh" && d.machineLabel ? `label:${d.machineLabel}` : d.runner)

/**
 * The one line a Captain's [Project now] ends with (and the Coordinator's block for a project its message names):
 * last, so it sits right before the turn's messages and beats a saved summary written before it.
 */
export function projectDefaultsLine(d: ProjectDefaults): string {
  const model = d.model ? `model ${d.model} (${d.modelFrom})` : "model: the CLI's default"
  const effort = d.effortYours ? "effort: yours to pass (Settings)" : d.effort ? `effort ${d.effort} (${d.effortFrom})` : null
  const parts = [`runs_on ${runsOnLabel(d)} (project)`, `agent ${d.agent} (${d.agentFrom})`, model, effort].filter(Boolean)
  return `Defaults now (live; they beat any saved summary): ${parts.join(" · ")}. Omit runs_on and agent to follow them; pass one only when this turn's message asks for it.`
}

/** list_projects' boxSettings.runsOn, in the same "(this project)" form as the other box settings. */
export function runsOnSetting(d: Pick<ProjectDefaults, "runner" | "machineLabel">): string {
  return `${runsOnLabel(d)} (this project): new tasks run there unless runs_on says otherwise`
}

export interface AskedPlacement {
  /** The runs_on (or machine_label) the call passed, as written; undefined: it passed neither. */
  runsOn?: string
  /** Where that resolved to (resolveRunsOn); null: the project's. */
  runner?: Runner | null
  machineLabel?: string | null
  /** The agent the call passed, and its model (a model can name another harness). */
  agent?: AgentCli | null
  model?: string | null
}

/**
 * What a task tool's reply says when the call's own runs_on or agent leaves the project's defaults, e.g. "runs_on box
 * overrides project default local"; null when it follows them. Cody's "@"/"!" picks aren't checked here: the reply's
 * runs_on_pick and agent_pick report those.
 */
export function overridesDefault(d: ProjectDefaults, asked: AskedPlacement): string | null {
  const out: string[] = []
  const runner = asked.runner ?? null
  if (asked.runsOn !== undefined && runner) {
    const label = runsOnLabel({ runner, machineLabel: asked.machineLabel ?? null })
    const otherLabel = runner === "ssh" && d.runner === "ssh" && (asked.machineLabel ?? null) !== d.machineLabel
    if (runner !== d.runner || otherLabel) {
      const shown = asked.runsOn.startsWith(label) ? asked.runsOn : `${asked.runsOn} (${label})`
      out.push(`runs_on ${shown} overrides project default ${runsOnLabel(d)}`)
    }
  }
  const cli = asked.agent ?? cliForModel(asked.model)
  if (cli && cli !== d.agent) {
    const shown = asked.agent ? `agent ${cli}` : `model ${asked.model} (agent ${cli})`
    out.push(`${shown} overrides project default agent ${d.agent}${d.agentFrom === "Settings" ? " (Settings)" : ""}`)
  }
  return out.length ? out.join("; ") : null
}
