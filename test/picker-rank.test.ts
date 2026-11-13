import { describe, expect, it } from "vitest"
import { matchText, rankPickerOptions, scorePickerFields, scoreText } from "../shared/pickerRank.js"
import { advancesInto, buildHarnessTargets, drillsInto, filterRunTargets, insertRunTarget } from "../shared/runTargets.js"
import { harnessModelTargets } from "../shared/harnessPicks.js"

describe("pickerRank", () => {
  it("ranks exact over prefix over word over substring over fuzzy", () => {
    expect(matchText("DeepSeek", "deepseek")!.tier).toBe("exact")
    expect(matchText("DeepSeek V3", "deep")!.tier).toBe("prefix")
    expect(matchText("Open DeepSeek", "deep")!.tier).toBe("word")
    expect(matchText("undeepsea", "deep")!.tier).toBe("substring")
    expect(matchText("deepseek-v3", "dpsk")!.tier).toBe("fuzzy")
  })

  it("scores token fields above details so an id beats a long blurb", () => {
    const issue = scorePickerFields(
      [
        { text: "123", kind: "token", fuzzy: false },
        { text: "Fix the deepseek login fluke", kind: "detail" },
      ],
      "123",
    )!
    const named = scorePickerFields([{ text: "deepseek-login", kind: "token" }], "123")
    expect(named).toBeNull()
    expect(issue).toBeGreaterThan(800)
    // A blurb's better hit (a prefix) still loses to an id's weaker one (a word start): details count for half.
    const id = scorePickerFields([{ text: "#123", kind: "token", fuzzy: false }], "123")!
    const blurb = scorePickerFields([{ text: "123 tests fail when the deepseek login token expires", kind: "detail" }], "123")!
    expect(id).toBeGreaterThan(blurb)
  })

  it("rankPickerOptions keeps input order on a tie and drops non-matches", () => {
    const items = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
      { id: "c", label: "Alpine" },
    ]
    expect(rankPickerOptions(items, "al", (i) => [{ text: i.label, kind: "label" }]).map((i) => i.id)).toEqual(["a", "c"])
    expect(rankPickerOptions(items, "", (i) => [{ text: i.label, kind: "label" }])).toHaveLength(3)
  })
})

describe("harness keyboard advance", () => {
  const roots = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
  const targets = harnessModelTargets(roots, {
    defaults: {
      claude: { model: "sonnet", effort: "medium" },
      codex: { model: "gpt-6.1-terra", effort: "ultra" },
      cursor: { model: "auto", effort: null },
    },
    cursor: [
      { id: "auto", label: "Auto" },
      { id: "deepseek-v3", label: "DeepSeek V3" },
    ],
  })

  it("Tab/Space advance on an exact harness; Enter still picks Settings default", () => {
    const cursor = targets.find((t) => t.token === "cursor")!
    expect(drillsInto(cursor, targets, "cursor")).toBe(false)
    expect(advancesInto(cursor, targets, "cursor")).toBe(true)
    expect(advancesInto(cursor, targets, "cursor:")).toBe(false)
    expect(insertRunTarget("build !cursor", { start: 6, end: 13 }, "cursor", "!", true)).toEqual({
      value: "build !cursor:",
      caret: 14,
    })
  })

  it("filters nested models by label so deep finds DeepSeek after !cursor:", () => {
    expect(filterRunTargets(targets, "cursor:deep").map((t) => t.token)).toEqual(["cursor:deepseek-v3"])
    expect(scoreText("DeepSeek V3", "deep")).not.toBeNull()
  })
})
