import { describe, expect, it } from "vitest"
import { BUILTIN_MODELS, claudeIdLabel, mergeCliModels } from "../shared/models.js"
import { modelEffortLine, modelName, taskModelLine } from "../shared/modelName.js"
import type { Task, TaskModel } from "../shared/types.js"

// What the task details, turn timings and a PR's agents call a model (shared/modelName.ts).

/** The list as the installed CLI says it: its aliases run on these now. */
const cliList = mergeCliModels(BUILTIN_MODELS, [
  { value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true },
  { value: "best", resolvedModel: "claude-fable-5-2", supportsEffort: true },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", supportsEffort: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-6", supportsEffort: true },
])

describe("a model's name", () => {
  it("is the picker's label for a Claude id, with or without a date or a window", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5")
    expect(modelName("claude-fable-5-2", "claude")).toBe("Fable 5.2")
    expect(modelName("claude-sonnet-5-5")).toBe("Sonnet 5.5")
    expect(modelName("claude-haiku-5-5")).toBe("Haiku 5.5")
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5")
    expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 [1m]")
    expect(modelName("claude-opus-4-6[1m]")).toBe("Opus 4.6 [1m]")
  })

  it("reads a Claude id the list doesn't have yet from its parts", () => {
    expect(modelName("claude-opus-5-6")).toBe("Opus 5.6")
    expect(modelName("claude-sonnet-6-20270101")).toBe("Sonnet 6")
    expect(modelName("claude-fable-6-1[1M]")).toBe("Fable 6.1 [1m]")
    expect(claudeIdLabel("claude-3-5-sonnet")).toBeNull()
    expect(claudeIdLabel("opus")).toBeNull()
    expect(claudeIdLabel("claude-opus-5-5-high")).toBeNull()
  })

  it("names an alias by the model the installed CLI says it runs, else as it is", () => {
    expect(modelName("opus", "claude", { claude: cliList })).toBe("Opus 5.5")
    expect(modelName("best", "claude", { claude: cliList })).toBe("Fable 5.2")
    expect(modelName("opus[1m]", "claude", { claude: cliList })).toBe("Opus 5.5 [1m]")
    // A model the built-in list doesn't have yet.
    expect(modelName("sonnet", "claude", { claude: cliList })).toBe("Sonnet 6")
    // The built-in list can't tell what an alias runs on this account.
    expect(modelName("opus")).toBe("opus")
    expect(modelName("best")).toBe("best")
  })

  it("names Codex and Cursor models by their lists, and shows anything else as it is", () => {
    expect(modelName("gpt-6.1-sol", "codex")).toBe("GPT-6.1 Sol")
    expect(modelName("gpt-5.6-terra", "codex")).toBe("GPT-5.6 Terra")
    expect(modelName("gpt-7-nova", "codex")).toBe("gpt-7-nova")
    expect(modelName("claude-opus-5-5-high", "cursor")).toBe("Claude Opus 5.5 1M High")
    expect(modelName("my-model", "cursor", { cursor: [{ id: "my-model", label: "My Model" }] })).toBe("My Model")
    // Cursor's init names the model by its label already.
    expect(modelName("Claude Opus 5.5 1M High", "cursor")).toBe("Claude Opus 5.5 1M High")
    expect(modelName("anthropic/claude-opus-5-5#high", "opencode")).toBe("anthropic/claude-opus-5-5#high")
    // Without a harness (a turn timing), every list is asked.
    expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol")
    expect(modelName("claude-opus-5-5-high")).toBe("Claude Opus 5.5 1M High")
    expect(modelName("  claude-opus-5-5 ")).toBe("Opus 5.5")
  })

  it("goes with its effort on one line", () => {
    expect(modelEffortLine("claude-opus-5-5", "xhigh")).toBe("Opus 5.5 · xhigh effort")
    expect(modelEffortLine("claude-fable-5-2", null)).toBe("Fable 5.2")
    expect(modelEffortLine(null, "high")).toBe("high effort")
    expect(modelEffortLine(null, null)).toBeNull()
  })
})

describe("the task details' Model line", () => {
  const task = (over: Partial<Task> & { turnModel?: TaskModel | null }) => ({ agentCli: "claude" as const, model: null, effort: null, ...over })

  it("names the model the latest turn's CLI ran, and says what the turn asked for", () => {
    const line = taskModelLine(task({ effort: "xhigh", turnModel: { model: "claude-opus-5-5", effort: "xhigh", from: "ran", asked: "opus" } }))
    expect(line).toEqual({ text: "Opus 5.5 · xhigh effort", title: "The model its latest turn ran on, as the CLI said: claude-opus-5-5 (it asked for opus)" })
  })

  it("names what the turn asked for when the CLI didn't say, an alias by the CLI list", () => {
    const tm: TaskModel = { model: "opus", effort: "high", from: "asked", asked: "opus" }
    expect(taskModelLine(task({ turnModel: tm }), { claude: cliList })).toEqual({ text: "Opus 5.5 · high effort", title: "The model its latest turn asked for: opus" })
    expect(taskModelLine(task({ turnModel: tm }))?.text).toBe("opus · high effort")
  })

  it("before the first turn, names what it will run on", () => {
    expect(taskModelLine(task({ turnModel: { model: "claude-sonnet-5-5", effort: "low", from: "next", asked: "claude-sonnet-5-5" } }))).toEqual({
      text: "Sonnet 5.5 · low effort",
      title: "The model its first turn will run on: claude-sonnet-5-5",
    })
  })

  it("names a Codex or Cursor task's model by its harness's list", () => {
    expect(taskModelLine(task({ agentCli: "codex", turnModel: { model: "gpt-6.1-sol", effort: "xhigh", from: "ran", asked: null } }))?.text).toBe("GPT-6.1 Sol · xhigh effort")
    expect(taskModelLine(task({ agentCli: "cursor", turnModel: { model: "Composer 2.5", effort: null, from: "ran", asked: "composer-2.5" } }))?.text).toBe("Composer 2.5")
  })

  it("falls back to the task's own pins, and shows nothing when none is known", () => {
    expect(taskModelLine(task({ model: "claude-haiku-5-5", effort: "low" }))?.text).toBe("Haiku 5.5 · low effort")
    expect(taskModelLine(task({ turnModel: null }))).toBeNull()
  })
})
