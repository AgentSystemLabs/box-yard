import { describe, expect, it } from "vitest"
import { overridesDefault, projectDefaultsLine, runsOnSetting, type ProjectDefaults } from "../server/projectDefaults.js"
import { RESET_LEAD, SUMMARY_PROMPT, afterCompactBlock, compactCommand, recapBlock, resetPrompt, summaryPrompt } from "../server/compactions.js"

// A reset Captain once followed "new tasks use runs_on: box" from its own saved summary over its project's Runs on
// (local). The live defaults now come with every turn, restored summaries say they're saved history, summaries don't
// turn settings into rules, and the task tools say when a call overrides the defaults.

const LOCAL: ProjectDefaults = {
  runner: "local",
  machineLabel: null,
  agent: "claude",
  agentFrom: "Settings",
  model: "claude-opus-5-5",
  modelFrom: "Settings",
  effort: "high",
  effortFrom: "built-in",
  effortYours: false,
}

describe("the live defaults line", () => {
  it("says where new tasks run, on which harness, model and effort, with each one's source, in one line", () => {
    const line = projectDefaultsLine(LOCAL)
    expect(line).toBe(
      "Defaults now (live; they beat any saved summary): runs_on local (project) · agent claude (Settings) · model claude-opus-5-5 (Settings) · effort high (built-in). " +
        "Omit runs_on and agent to follow them; pass one only when this turn's message asks for it.",
    )
    expect(line).not.toContain("\n")
  })

  it("names SSH labels, a CLI's own model, effort left to the caller and harnesses without effort", () => {
    expect(projectDefaultsLine({ ...LOCAL, runner: "ssh", machineLabel: "gpu", agent: "codex", agentFrom: "project" })).toContain("runs_on label:gpu (project) · agent codex (project)")
    expect(projectDefaultsLine({ ...LOCAL, model: null })).toContain("model: the CLI's default")
    expect(projectDefaultsLine({ ...LOCAL, effortYours: true })).toContain("effort: yours to pass (Settings)")
    const cursor = projectDefaultsLine({ ...LOCAL, agent: "cursor", effort: null })
    expect(cursor).toContain("model claude-opus-5-5 (Settings).")
    expect(cursor).not.toContain("effort")
  })

  it("is list_projects' boxSettings.runsOn, in the other box settings' form", () => {
    expect(runsOnSetting(LOCAL)).toBe("local (this project): new tasks run there unless runs_on says otherwise")
    expect(runsOnSetting({ runner: "ssh", machineLabel: "laptops" })).toMatch(/^label:laptops \(this project\)/)
  })
})

describe("overridesDefault", () => {
  it("says when a call's runs_on leaves the project's Runs on", () => {
    expect(overridesDefault(LOCAL, { runsOn: "box", runner: "box" })).toBe("runs_on box overrides project default local")
    expect(overridesDefault(LOCAL, { runsOn: "box:large", runner: "box" })).toBe("runs_on box:large overrides project default local")
    expect(overridesDefault(LOCAL, { runsOn: "daytona:cpu-large", runner: "gpu" })).toBe("runs_on daytona:cpu-large (gpu) overrides project default local")
    // "local" that Settings › Machines sends to SSH machines leaves this computer too.
    expect(overridesDefault(LOCAL, { runsOn: "local", runner: "ssh", machineLabel: "mac" })).toBe("runs_on local (label:mac) overrides project default local")
    const ssh = { ...LOCAL, runner: "ssh" as const, machineLabel: "gpu" }
    expect(overridesDefault(ssh, { runsOn: "label:cpu", runner: "ssh", machineLabel: "cpu" })).toBe("runs_on label:cpu overrides project default label:gpu")
  })

  it("is null when the call follows the defaults or passes nothing", () => {
    expect(overridesDefault(LOCAL, {})).toBeNull()
    expect(overridesDefault(LOCAL, { runsOn: undefined, runner: null })).toBeNull()
    expect(overridesDefault(LOCAL, { runsOn: "local", runner: "local" })).toBeNull()
    expect(overridesDefault(LOCAL, { runsOn: "this_computer", runner: "local" })).toBeNull()
    expect(overridesDefault(LOCAL, { agent: "claude", model: "claude-sonnet-5-5" })).toBeNull()
    expect(overridesDefault({ ...LOCAL, runner: "ssh", machineLabel: "gpu" }, { runsOn: "label:gpu", runner: "ssh", machineLabel: "gpu" })).toBeNull()
  })

  it("says when the agent, or a model of another harness, leaves the project's agent", () => {
    expect(overridesDefault(LOCAL, { agent: "codex" })).toBe("agent codex overrides project default agent claude (Settings)")
    expect(overridesDefault({ ...LOCAL, agentFrom: "project" }, { agent: "codex" })).toBe("agent codex overrides project default agent claude")
    expect(overridesDefault(LOCAL, { model: "gpt-6.1-sol" })).toBe("model gpt-6.1-sol (agent codex) overrides project default agent claude (Settings)")
    expect(overridesDefault(LOCAL, { runsOn: "box", runner: "box", agent: "codex" })).toBe("runs_on box overrides project default local; agent codex overrides project default agent claude (Settings)")
  })
})

describe("restored summaries are saved history", () => {
  const md = "---\ntimestamp: 2026-11-09T10:00:00.000Z\n---\n\n## Decisions and preferences\n- New tasks use runs_on: box."

  it("labels a reset session's summary as possibly stale, below live config and the owner's message", () => {
    const block = recapBlock("f.md", md, [], RESET_LEAD, "Sam")
    expect(block.split("\n")[0]).toBe(
      "[Box Yard: Your session was reset. This is the last summary you wrote (2026-11-09T10:00:00.000Z, saved as f.md). Saved history, possibly stale: live project config and Sam's current message override it. " +
        'Task states under "Live now" are current and beat the summary. For anything older, use compaction_history or search_history.]',
    )
    expect(afterCompactBlock("f.md", md, [], "Cody")).toContain("Saved history, possibly stale: live project config and Cody's current message override it.")
    // With no name configured, the neutral fallback.
    expect(afterCompactBlock("f.md", md, [])).toContain("live project config and the owner's current message override it")
  })

  it("puts the live state and the turn's messages after the history, behind an end marker", () => {
    const prompt = resetPrompt(recapBlock("f.md", md, [], RESET_LEAD), "Earlier Captain conversation", "[user] run it on a box", "[Project now: demo]\nDefaults now …\n\n[From Cody]\nship it")
    const order = ["Your session was reset", "Earlier Captain conversation (your session was reset; saved history):\n[user] run it on a box", "[End of saved history. Everything below is live", "[Project now: demo]", "[From Cody]\nship it"]
    const at = order.map((s) => prompt.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(prompt.endsWith("ship it")).toBe(true)
    // No summary on record: the recap still comes first, labelled.
    expect(resetPrompt(null, "Earlier conversation", "[user] hi", "[Yard now] idle")).toMatch(/^Earlier conversation \(your session was reset; saved history\):\n\[user\] hi\n\n---\n\[End of saved history/)
  })

  it("asks summaries to record runner, harness and model choices as settings, not rules", () => {
    expect(SUMMARY_PROMPT).toContain("are live settings Box Yard shows you, not standing rules")
    expect(SUMMARY_PROMPT).toContain("never as an instruction to pass runs_on, agent, model or effort")
    const carried = summaryPrompt(SUMMARY_PROMPT, { previous: { at: Date.parse("2026-11-09T10:00:00Z"), markdown: md } })
    expect(carried).toContain("rewrite one that tells you where tasks run or which agent, model or effort to use as what the setting was then")
    expect(compactCommand()).toContain("Write where tasks run and which agent, model or effort they use as what the settings were, not as rules.")
  })
})
