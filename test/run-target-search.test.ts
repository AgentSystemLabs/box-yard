import { describe, expect, it } from "vitest"
import { matchRanges, searchRunTargets, searchWords, wordTier } from "../shared/runTargetSearch.js"
import { harnessModelTargets, type HarnessPickSources } from "../shared/harnessPicks.js"
import { buildHarnessTargets, buildRunTargets, filterRunTargets } from "../shared/runTargets.js"

const sources: HarnessPickSources = {
  defaults: {
    claude: { model: "sonnet", effort: "medium" },
    codex: { model: "gpt-6.1-terra", effort: "xhigh" },
    opencode: { model: "", effort: null },
    cursor: { model: "auto", effort: null },
  },
  cursor: [{ id: "auto", label: "Auto" }, { id: "gpt-6.1-sol-high", label: "GPT 6.1 Sol High" }],
}
const harnesses = harnessModelTargets(buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null, opencode: null } }), sources)
const places = buildRunTargets({
  problems: { local: null, box: null, docker: null, gpu: null },
  machines: [{ name: "example-mini", labels: ["fast"] }],
  localLabel: null,
  gpu: { default: "runpod", problems: { runpod: null, vast: null, daytona: null }, types: { runpod: ["A40"], vast: ["RTX 4090"], daytona: ["H100"] } },
})
const find = (q: string, under?: string) => searchRunTargets(harnesses, q, under ? harnesses.find((t) => t.token === under) : undefined).map((t) => t.token)
const where = (q: string, under?: string) => searchRunTargets(places, q, under ? places.find((t) => t.token === under) : undefined).map((t) => t.token)

describe("wordTier", () => {
  it("ranks a first word over a later word over a prefix over a later word's start over the inside of a word", () => {
    expect(wordTier("Fable 5.1", "fable")).toBe(4)
    expect(wordTier("fable", "fable")).toBe(4)
    expect(wordTier("Extra high", "high")).toBe(3.5)
    expect(wordTier("fable[1m]", "1m")).toBe(3.5)
    expect(wordTier("Fable 5.1", "fa")).toBe(3)
    expect(wordTier("Extra high", "hi")).toBe(2)
    expect(wordTier("xhigh", "high")).toBe(1)
    expect(wordTier("Small", "l")).toBe(0)
    expect(wordTier("Fable 5.1", "opus")).toBe(0)
  })

  it("takes a fuzzy subsequence only when asked", () => {
    expect(wordTier("gpt-6.1-sol", "gpt6")).toBe(0)
    expect(wordTier("gpt-6.1-sol", "gpt6", true)).toBe(0.5)
  })
})

describe("matchRanges", () => {
  const marked = (text: string, query: string) => matchRanges(text, searchWords(query)).map(([from, to]) => text.slice(from, to))

  it("splits a search into lowercase words", () => {
    expect(searchWords("  Fable   HIGH ")).toEqual(["fable", "high"])
    expect(searchWords("   ")).toEqual([])
  })

  it("marks each word where it starts a word, in the text's order", () => {
    expect(marked("Fable 5.1", "fa")).toEqual(["Fa"])
    expect(marked("Extra high", "high")).toEqual(["high"])
    expect(marked("GPT 6.1 Sol High", "high sol")).toEqual(["Sol", "High"])
    expect(marked("claude-fable-5-1", "fable 5")).toEqual(["fable", "5"])
    expect(marked("Fable 5.1", "opus")).toEqual([])
    expect(marked("Fable 5.1", "")).toEqual([])
  })

  it("marks the inside of a word only when the word starts none, and never for one letter", () => {
    expect(marked("xhigh", "high")).toEqual(["high"])
    expect(marked("High and xhigh", "high")).toEqual(["High"])
    expect(marked("Small", "l")).toEqual([])
    expect(marked("Large", "l")).toEqual(["L"])
  })

  it("joins hits that touch or overlap, so nothing is marked twice", () => {
    expect(matchRanges("fable", ["fa", "fable", "fab"])).toEqual([[0, 5]])
    expect(matchRanges("aaaa", ["aa"])).toEqual([[0, 2]])
    expect(matchRanges("box box", ["box", "box"])).toEqual([[0, 3], [4, 7]])
  })
})

describe("searchRunTargets: harness, model and effort in words", () => {
  it("finds a model and its effort from two words, the latest model first", () => {
    expect(find("fable high")).toEqual(["claude:claude-fable-5-1:high", "claude:fable:high", "claude:fable[1m]:high", "claude:claude-fable-5:high"])
    expect(find("fa hi")[0]).toBe("claude:claude-fable-5-1:high")
    expect(find("high fable")[0]).toBe("claude:claude-fable-5-1:high")
    expect(find("FABLE  HIGH ")[0]).toBe("claude:claude-fable-5-1:high")
  })

  it("lists each matching model once, in the catalog's order, with no effort rows until one is named", () => {
    expect(find("fa")).toEqual(["claude:claude-fable-5-1", "claude:fable", "claude:fable[1m]", "claude:claude-fable-5"])
    expect(find("fable")).toEqual(find("fa"))
    expect(find("opus").slice(0, 2)).toEqual(["claude:claude-opus-5-5", "claude:opus"])
  })

  it("tells High from Extra high, and Medium from Max", () => {
    expect(find("fable 5.1 high")).toEqual(["claude:claude-fable-5-1:high", "claude:claude-fable-5-1:xhigh"])
    expect(find("fable 5.1 xhigh")).toEqual(["claude:claude-fable-5-1:xhigh"])
    expect(find("fable 5.1 extra")).toEqual(["claude:claude-fable-5-1:xhigh"])
    expect(find("fable 5.1 m")).toEqual(["claude:claude-fable-5-1:medium", "claude:claude-fable-5-1:max"])
    expect(find("sonnet max")[0]).toBe("claude:claude-sonnet-5-5:max")
  })

  it("puts a name typed in full before the longer names that start the same", () => {
    expect(find("opus 4")[0]).toBe("claude:claude-opus-4-0")
    expect(find("fable 5")[0]).toBe("claude:claude-fable-5")
    expect(find("opus 4.6")).toEqual(["claude:claude-opus-4-6", "claude:claude-opus-4-6[1m]"])
  })

  it("a harness's name finds the harness, not every model whose id starts with it", () => {
    expect(find("claude")).toEqual(["claude"])
    expect(find("codex")).toEqual(["codex"])
    expect(find("code")).toEqual(["claude", "codex", "opencode"])
  })

  it("narrows by harness, and finds other harnesses' models from the top", () => {
    expect(find("codex sol high").slice(0, 2)).toEqual(["codex:gpt-6.1-sol:high", "codex:gpt-6-sol:high"])
    expect(find("cursor sol")).toEqual(["cursor:gpt-6.1-sol-high"])
    expect(find("sol")).toEqual(expect.arrayContaining(["codex:gpt-6.1-sol", "cursor:gpt-6.1-sol-high"]))
    expect(find("claude fable high")[0]).toBe("claude:claude-fable-5-1:high")
    expect(find("codex fable")).toEqual([])
  })

  it("only offers efforts a model takes", () => {
    expect(find("opus 4.6 xhigh")).toEqual([])
    expect(find("opus 4.5 high")).toEqual([])
    expect(find("luna ultra")).toEqual([])
    expect(find("terra ultra")[0]).toBe("codex:gpt-6.1-terra:ultra")
  })

  it("searches only inside an open level", () => {
    expect(find("sol", "codex")).toEqual(["codex:gpt-6.1-sol", "codex:gpt-6-sol", "codex:gpt-5.6-sol"])
    expect(find("fable high", "claude")[0]).toBe("claude:claude-fable-5-1:high")
    expect(find("fable", "codex")).toEqual([])
    expect(find("h", "claude:claude-fable-5-1")).toEqual(["claude:claude-fable-5-1:high", "claude:claude-fable-5-1:xhigh"])
  })

  it("an empty query is the level as it is browsed", () => {
    expect(find("")).toEqual(filterRunTargets(harnesses, "").map((t) => t.token))
    expect(find("  ", "claude")).toEqual(filterRunTargets(harnesses, "claude").map((t) => t.token))
  })

  it("falls back to a fuzzy match only when nothing else fits", () => {
    expect(find("gpt6 terra")[0]).toBe("codex:gpt-6.1-terra")
    expect(find("zzzz")).toEqual([])
  })
})

describe("searchRunTargets: where tasks run", () => {
  it("finds a box size, a GPU and a machine from words", () => {
    expect(where("box l")).toEqual(["box:large"])
    expect(where("large")).toEqual(["box:large", "daytona:cpu-large"])
    expect(where("box")).toEqual(["box"])
    expect(where("upstash")).toEqual(["box"])
    expect(where("h100")).toContain("gpu:daytona:h100")
    expect(where("4090")[0]).toBe("gpu:vast:rtx-4090")
    expect(where("mini")).toEqual(["example-mini"])
    expect(where("this")).toEqual(["local"])
  })

  it("keeps what can't be picked in the list, greyed out by its row", () => {
    const blocked = buildRunTargets({ problems: { local: null, box: "no Upstash key", docker: null, gpu: null }, machines: [], localLabel: null })
    expect(searchRunTargets(blocked, "box m")[0]).toMatchObject({ token: "box:medium", disabled: "no Upstash key" })
  })
})
