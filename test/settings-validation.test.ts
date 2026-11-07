import { describe, expect, it } from "vitest"
import { NUMBER_RULES, USD_RULE, numberProblem, numberText, problemSections, refusedByBrowser, settingsProblems, typedNumber } from "../web/src/lib/settingsValidation"
import { DEFAULT_SETTINGS, settingsPatch } from "../server/settings.js"
import type { Settings } from "../shared/types"

// The Settings dialog checks a draft before Save with the server's limits, so a value the server would refuse gets
// its message next to its field. These keep the two in step: whatever the dialog lets through, the server takes.

const serverTakes = (patch: Partial<Settings>) => settingsPatch.safeParse(patch).success
const dialogTakes = (patch: Partial<Settings>) => Object.keys(settingsProblems(patch)).length === 0

describe("settings validation matches the server", () => {
  it("has a rule for every number setting", () => {
    const shape = settingsPatch.shape as Record<string, { unwrap(): { def: { type: string } } }>
    const numbers = Object.keys(shape).filter((k) => shape[k]!.unwrap().def.type === "number")
    expect(Object.keys(NUMBER_RULES).sort()).toEqual(numbers.sort())
  })

  it("agrees on every number setting's edges", () => {
    for (const [key, rule] of Object.entries(NUMBER_RULES)) {
      const values = [rule!.min, rule!.max, rule!.min - 1, rule!.max + 1, rule!.min + 0.5, NaN]
      for (const value of values) {
        const patch = { [key]: value } as Partial<Settings>
        expect([key, value, dialogTakes(patch)]).toEqual([key, value, serverTakes(patch)])
      }
    }
  })

  it("agrees on names, model IDs and auto-compact thresholds", () => {
    const cases: Partial<Settings>[] = [
      ...["Cody", "  Sam  ", "", "   ", "a".repeat(40), "a".repeat(41), "Co<dy", "Co`dy"].map((ownerName) => ({ ownerName })),
      ...["claude-opus-5-5", "opus[1m]", "us.anthropic.claude:0", "", "claude opus", "a".repeat(101)].flatMap((m) => [
        { agentModel: m },
        { orchestratorRelay: { ...DEFAULT_SETTINGS.orchestratorRelay, model: m } },
        { quickQuestionModel: m },
      ]),
      // Quick questions run on Claude: "" is "Same as its chat", and a Codex model is refused.
      ...["claude-haiku-5-5", "haiku", "gpt-6.1-sol", "   "].map((quickQuestionModel) => ({ quickQuestionModel })),
      ...[9, 10, 95, 96, NaN].map((value) => ({ orchestratorAutoCompact: { enabled: true, unit: "percent" as const, value } })),
      ...[99_999, 100_000, 1_000_000, 1_000_001].map((value) => ({ agentAutoCompact: { enabled: false, unit: "tokens" as const, value } })),
      ...[-1, 0, 12.5, 1_000_001, NaN].flatMap((v) => [
        { budget: { dailyUsd: v, monthlyUsd: 0 } },
        { costRates: { ...DEFAULT_SETTINGS.costRates, boxActiveCpuHourlyUsd: { ...DEFAULT_SETTINGS.costRates.boxActiveCpuHourlyUsd, large: v } } },
        { costRates: { ...DEFAULT_SETTINGS.costRates, boxStorageGbMonthUsd: v } },
      ]),
    ]
    for (const patch of cases) expect([patch, dialogTakes(patch)]).toEqual([patch, serverTakes(patch)])
  })

  it("passes the defaults", () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual({})
  })
})

describe("settings problems", () => {
  it("say what fits, in words, by field", () => {
    expect(
      settingsProblems({
        maxBoxes: 500,
        diskCloneFactor: 0.5,
        notesMaxCount: NaN,
        ownerName: " ",
        captainModel: "claude opus",
        orchestratorAutoCompact: { enabled: true, unit: "percent", value: 99 },
        budget: { dailyUsd: -5, monthlyUsd: 0 },
        costRates: { ...DEFAULT_SETTINGS.costRates, boxKeepAliveMonthlyUsd: { small: 8, medium: -1, large: 32 } },
      }),
    ).toEqual({
      maxBoxes: "Enter a whole number from 1 to 100.",
      diskCloneFactor: "Enter a number from 1 to 20.",
      notesMaxCount: "Enter a whole number from 1 to 200.",
      ownerName: "Enter a name.",
      captainModel: "Use letters, digits and . _ : / - [ ] only, no spaces.",
      orchestratorAutoCompact: "Enter a percent from 10 to 95.",
      "budget.dailyUsd": "Enter an amount from 0 to 1,000,000.",
      // Three sizes share a row, so the message says which.
      "costRates.boxKeepAliveMonthlyUsd.medium": "Medium: Enter an amount from 0 to 1,000,000.",
    })
  })

  it("only check what Save sends", () => {
    expect(settingsProblems({})).toEqual({})
    expect(settingsProblems({ maxBoxes: 3 })).toEqual({})
    expect(numberProblem(1_000_000, USD_RULE)).toBeNull()
  })

  it("map to the sections that hold them, for the nav", () => {
    expect([...problemSections({ maxBoxes: "x", "budget.dailyUsd": "x", "orchestratorRelay.model": "x", ownerName: "x" })].sort()).toEqual(["agents", "costs", "limits", "orchestrator"])
  })
})

describe("number fields", () => {
  it("keep an emptied field empty (NaN) instead of saving 0", () => {
    expect(typedNumber("")).toBeNaN()
    expect(typedNumber("  ")).toBeNaN()
    expect(typedNumber("0")).toBe(0)
    expect(typedNumber("2.5")).toBe(2.5)
    expect(typedNumber("2.7", true)).toBe(2)
    expect(numberText(NaN)).toBe("")
    expect(numberText(0)).toBe(0)
  })

  it("let the browser refuse only what the server would: a number between the spinner's steps is fine", () => {
    const validity = (flags: Partial<ValidityState>) => ({ badInput: false, customError: false, patternMismatch: false, rangeOverflow: false, rangeUnderflow: false, stepMismatch: false, tooLong: false, tooShort: false, typeMismatch: false, valid: false, valueMissing: false, ...flags }) as ValidityState
    expect(refusedByBrowser(validity({ stepMismatch: true }))).toBe(false)
    expect(refusedByBrowser(validity({ rangeOverflow: true }))).toBe(true)
    expect(refusedByBrowser(validity({ valueMissing: true }))).toBe(true)
    expect(refusedByBrowser(validity({ badInput: true, stepMismatch: true }))).toBe(true)
  })
})
