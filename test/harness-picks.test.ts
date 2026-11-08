import { describe, expect, it } from "vitest"
import { harnessModelTargets, modelToken, type HarnessPickSources } from "../shared/harnessPicks.js"
import { harnessDefaults } from "../shared/harnessDefaults.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { buildHarnessTargets, filterRunTargets, mentionAt, pickedRunTarget, pickOf, runTargetPickOf, turnPicks } from "../shared/runTargets.js"
import { resolveHarnessPick, harnessNote, type RunTargetDeps } from "../server/runTargets.js"

const roots = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
const sources: HarnessPickSources = {
  defaults: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "gpt-6.1-terra", effort: "xhigh" },
    opencode: { model: "example/model#high", effort: null },
  cursor: { model: "auto", effort: null },
  },
  cursor: [{ id: "future-model-max", label: "Future model Max" }, { id: "vendor/new:model", label: "Custom live model" }],
}
const targets = harnessModelTargets(roots, sources)
const tokens = (q: string) => filterRunTargets(targets, q).map((t) => t.token)
const deps: RunTargetDeps = {
  runnerProblem: async () => null,
  machines: () => ({ machines: [], settings: { localLabel: null } }) as ReturnType<RunTargetDeps["machines"]>,
  harnessModels: async () => sources,
}

describe("harness model and effort choices", () => {
  it("uses the existing per-harness Settings fields and preserves CLI defaults and automatic effort", () => {
    expect(harnessDefaults({ agentModel: "sonnet", agentEffort: "orchestrator", agentCodexModel: "", agentCodexEffort: "ultra", agentCursorModel: "gpt-6.1-sol-high" })).toEqual({
      claude: { model: "sonnet", effort: "orchestrator" },
      codex: { model: "", effort: "ultra" },
      opencode: { model: "example/model#high", effort: null },
  cursor: { model: "gpt-6.1-sol-high", effort: null },
    })
  })

  it("shows the same built-in defaults while Settings loads", () => {
    expect(harnessDefaults()).toEqual(harnessDefaults(DEFAULT_SETTINGS))
  })

  it("offers just harnesses first, then a Settings default before models, then a default before supported efforts", () => {
    expect(tokens("")).toEqual(["claude", "codex", "cursor"])
    expect(tokens("codex")[0]).toBe("codex")
    expect(targets.find((t) => t.token === "codex")).toMatchObject({ detail: "gpt-6.1-terra · Extra high effort", defaultLabel: "Settings default" })
    expect(tokens("codex")).toContain("codex:gpt-6.1-sol")
    expect(tokens("codex")).not.toContain("codex:gpt-6.1-sol:high")
    expect(tokens("codex:gpt-6.1-sol")).toEqual(["codex:gpt-6.1-sol", ...["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => `codex:gpt-6.1-sol:${e}`)])
    expect(tokens("claude:claude-opus-4-6")).not.toContain("claude:claude-opus-4-6:xhigh")
    expect(tokens("claude:claude-opus-4-5")).toEqual(["claude:claude-opus-4-5"])
  })

  it("keeps full Cursor live ids and never adds a separate effort to them", () => {
    expect(tokens("cursor")).toEqual(["cursor", "cursor:future-model-max", `cursor:${modelToken("vendor/new:model")}`])
    const pick = pickedRunTarget("build !cursor:future-model-max please", targets, "!")!
    expect(pickOf(pick)).toMatchObject({ value: "cursor", model: "future-model-max" })
    expect(pick.effort).toBeUndefined()
    expect(harnessNote(pickOf(pick), "Sam", false)).toContain("effort included in its model ID")
  })

  it("recognizes complete aliases, mid-token caret edits and punctuation without partially selecting an invalid override", () => {
    const text = "use !claude:sonnet[1m]:high."
    expect(mentionAt(text, text.length - 1, "!")?.query).toBe("claude:sonnet[1m]:high")
    expect(pickedRunTarget(text, targets, "!")).toMatchObject({ model: "sonnet[1m]", effort: "high" })
    expect(pickedRunTarget("!codex:unknown:high", targets, "!")).toBeNull()
    expect(pickedRunTarget("[!codex]", targets, "!")?.token).toBe("codex")
    expect(pickedRunTarget(`!cursor:${modelToken("vendor/new:model")}`, targets, "!")?.model).toBe("vendor/new:model")
  })

  it("preserves choices in stored meta and only enforces a consensus when model and effort agree", () => {
    const high = pickOf(targets.find((t) => t.token === "codex:gpt-6.1-sol:high")!)
    const max = pickOf(targets.find((t) => t.token === "codex:gpt-6.1-sol:max")!)
    expect(runTargetPickOf({ agent: high }, "agent")).toEqual(high)
    expect(turnPicks([{ agent: high }, { agent: high }]).agent).toEqual(high)
    expect(turnPicks([{ agent: high }, { agent: max }]).agent).toBeNull()
    expect(turnPicks([{ agent: high }, { agent: pickOf(roots[1]!) }]).agent).toBeNull()
  })

  it("validates complete choices on send and retains the harness's availability checks", async () => {
    expect(await resolveHarnessPick(deps, "codex", null, null)).toEqual(pickOf(roots[1]!))
    const pick = await resolveHarnessPick(deps, "codex:gpt-6.1-sol:ultra", null, null)
    expect(pick).toMatchObject({ value: "codex", model: "gpt-6.1-sol", effort: "ultra" })
    await expect(resolveHarnessPick(deps, "claude:claude-opus-4-5:high", null, null)).rejects.toThrow(/isn't a model and effort/)
    await expect(resolveHarnessPick({ ...deps, harnessProblem: async () => "not signed in" }, "codex:gpt-6.1-sol:high", null, null)).rejects.toThrow(/not signed in/)
    expect(harnessNote(pick, "Sam", true)).toContain('Model "gpt-6.1-sol", effort "ultra"')
    expect(harnessNote(pick, "Sam", true)).not.toContain("Cody")
  })
})
