// @vitest-environment happy-dom
// The tags in a chat's draft in colour (ComposerTags.tsx): which words are tags (shared/runTargets.ts tagsIn), how the
// layer under the textarea draws them, and that the Composer draws it only while the draft holds one.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { TAG_COLOR, tagLines, tagParts, tagStyle } from "../web/src/components/ComposerTags.js"
import { buildHarnessTargets, buildProjectTargets, buildRunTargets, tagsIn, type RunTarget } from "../shared/runTargets.js"
import { PROJECT_COLOR_HEX, projectColors } from "../shared/projectColors.js"
import { harnessModelTargets } from "../shared/harnessPicks.js"
import { harnessDefaults } from "../shared/harnessDefaults.js"
import type { Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PLACES = buildRunTargets({
  problems: { local: null, box: null, docker: null, gpu: null },
  machines: [{ name: "studio-mac", labels: ["laptops"], state: "ready" }],
  localLabel: null,
  gpu: { default: "runpod", problems: { runpod: null, vast: "no key", daytona: "no key" }, types: { runpod: [], vast: [], daytona: [] } },
})
const HARNESSES = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
// One project picked its colour; the other gets one from its name.
const PROJECTS = [
  { id: "prj_boxyard", name: "Box Yard", color: "rose", createdAt: 1, runner: "box", machineLabel: null, agentCli: null },
  { id: "prj_mobile", name: "Mobile", color: null, createdAt: 2, runner: "local", machineLabel: null, agentCli: null },
] as unknown as Project[]
const LISTS = { runsOn: PLACES, agent: HARNESSES, project: buildProjectTargets(PROJECTS) }

/** Each tag as its kind and its text. */
const tagged = (text: string, lists: Parameters<typeof tagsIn>[1] = LISTS) => tagsIn(text, lists).map((t) => [t.kind, text.slice(t.start, t.end)])

describe("tagsIn", () => {
  it("finds each kind's tags in order, without the punctuation after them", () => {
    expect(tagged("ship %box-yard on @box with !codex.")).toEqual([
      ["project", "%box-yard"],
      ["runsOn", "@box"],
      ["agent", "!codex"],
    ])
    // The same word twice is two tags; the target says what each names.
    const tags = tagsIn("!claude then !CLAUDE", LISTS)
    expect(tags.map((t) => [t.start, t.end, t.target.value])).toEqual([
      [0, 7, "claude"],
      [13, 20, "claude"],
    ])
  })

  it("reads every form the lists hold: GPUs, machines, labels, and tags in brackets or quotes", () => {
    expect(tagged("(@gpu:runpod:a40) '@studio-mac' \"@label:laptops\" [@ssh]")).toEqual([
      ["runsOn", "@gpu:runpod:a40"],
      ["runsOn", "@studio-mac"],
      ["runsOn", "@label:laptops"],
      ["runsOn", "@ssh"],
    ])
  })

  it("leaves words no list names plain: mid-word triggers, unknown names, headings and issue numbers", () => {
    expect(tagged("mail me@box, great!codex, try @nowhere or !gpt, # Plan, see #123, C#")).toEqual([])
  })

  it("has no tags of a kind without a list: a Captain's %, or a list still loading", () => {
    expect(tagged("%box-yard on @box", { runsOn: PLACES })).toEqual([["runsOn", "@box"]])
    expect(tagged("%box-yard on @box !codex", {})).toEqual([])
  })

  it("counts a greyed-out target: the composer warns about it rather than dropping it", () => {
    const blocked = buildHarnessTargets({ problems: { claude: null, codex: "no", cursor: "no" }, blocked: { codex: "Codex is unavailable here" } })
    expect(tagged("!codex", { agent: blocked })).toEqual([["agent", "!codex"]])
  })

  it("colours a new form as soon as a list holds it, with no other change", () => {
    const giant: RunTarget = { token: "box:giant", value: "box:giant", kind: "runner", label: "Upstash Giant", detail: null, disabled: null, under: "box" }
    expect(tagged("run @box:giant")).toEqual([])
    expect(tagged("run @box:giant", { runsOn: [...PLACES, giant] })).toEqual([["runsOn", "@box:giant"]])
  })

  it("colours box sizes, their hyphen aliases and harness model/effort picks whole", () => {
    const agent = harnessModelTargets(HARNESSES, { defaults: harnessDefaults(), cursor: [] })
    expect(tagged("run @box:medium, @box-large then !codex:gpt-6.1-sol:xhigh.", { ...LISTS, agent })).toEqual([
      ["runsOn", "@box:medium"],
      ["runsOn", "@box-large"],
      ["agent", "!codex:gpt-6.1-sol:xhigh"],
    ])
  })
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  resetDrafts()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("tagParts and tagLines", () => {
  const draw = (text: string, color = (t: { kind: string }) => (t.kind === "project" ? undefined : "#fbbf24")) => {
    act(() => root.render(createElement("div", null, ...tagParts(text, tagsIn(text, LISTS), color))))
    return host.firstElementChild as HTMLElement
  }

  it("draws the text as it is, each tag a span in its colour", () => {
    const el = draw("on @box with !codex.")
    expect(el.textContent).toBe("on @box with !codex.")
    const spans = [...el.querySelectorAll<HTMLElement>("span")]
    expect(spans.map((s) => [s.dataset.tag, s.textContent, s.className])).toEqual([
      ["runsOn", "@box", "composer-tag"],
      ["agent", "!codex", "composer-tag"],
    ])
    expect(spans[0]!.style.getPropertyValue("--tag")).toBe("#fbbf24")
  })

  it("draws a tag whose colour isn't known yet as plain text", () => {
    const el = draw("for %box-yard on @box")
    expect([...el.querySelectorAll("span")].map((s) => s.textContent)).toEqual(["@box"])
    expect(el.textContent).toBe("for %box-yard on @box")
  })

  it("splits the text into lines, each tag counted from its line's start", () => {
    const text = "%box-yard\n\non @box with !codex\n"
    const lines = tagLines(text, tagsIn(text, LISTS))
    expect(lines.map((l) => [l.text, l.tags.map((t) => [t.kind, l.text.slice(t.start, t.end)])])).toEqual([
      ["%box-yard", [["project", "%box-yard"]]],
      ["", []],
      ["on @box with !codex", [["runsOn", "@box"], ["agent", "!codex"]]],
      ["", []],
    ])
  })

  it("marks a tag that's only its part of the message's, and changes nothing else about it", () => {
    act(() => root.render(createElement("div", null, ...tagParts("on @box with !codex", tagsIn("on @box with !codex", LISTS).map((t) => ({ ...t, partial: t.kind === "agent" })), () => "#fbbf24"))))
    const spans = [...(host.firstElementChild as HTMLElement).querySelectorAll<HTMLElement>("span")]
    expect(spans.map((s) => [s.textContent, s.hasAttribute("data-part"), s.className])).toEqual([
      ["@box", false, "composer-tag"],
      ["!codex", true, "composer-tag"],
    ])
    // Its underline is a text decoration: no border, padding or margin, so the glyphs stay where the textarea's are.
    const css = readFileSync(join(__dirname, "../web/src/styles.css"), "utf8")
    const rule = css.match(/\.composer-tag\[data-part\] \{([^}]*)\}/)![1]!
    expect(rule).toContain("dashed")
    expect(rule).not.toMatch(/border|padding|margin|font|letter-spacing/)
  })

  it("tints each colour at 14%", () => {
    expect(tagStyle("#fbbf24")).toEqual({ "--tag": "#fbbf24", "--tag-tint": "rgb(251 191 36 / 14%)" })
    expect(tagStyle(PROJECT_COLOR_HEX.indigo)).toEqual({ "--tag": "#818cf8", "--tag-tint": "rgb(129 140 248 / 14%)" })
  })
})

describe("Composer tags", () => {
  const commits = vi.fn()
  const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }))

  beforeEach(() => {
    commits.mockClear()
    vi.stubGlobal("fetch", (url: string) => {
      if (url.startsWith("/api/run-targets")) return json(PLACES)
      if (url.startsWith("/api/harness-targets")) return json(HARNESSES)
      if (url === "/api/projects") return json(PROJECTS)
      if (url === "/api/agent-settings") return json({ settings: { agentCli: "claude" }, sources: {}, defaults: {} })
      return new Promise(() => {})
    })
  })

  async function mount(runTargets: boolean, projectId: string | null = null, draftKey?: string) {
    const panel = createRef<HTMLElement>()
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(Profiler, { id: "composer", onRender: commits }, createElement("section", { ref: panel }, createElement(Composer, { onSubmit: () => {}, placeholder: "Ask", panelRef: panel, runTargets, runTargetsProject: projectId, draftKey }))),
        ),
      ),
    )
    // The lists load once the chat is painted.
    await act(async () => new Promise((r) => setTimeout(r, 50)))
  }

  const textarea = () => document.querySelector("textarea")!
  const layer = () => document.querySelector<HTMLElement>('[data-testid="composer-tags"]')
  const tags = () => [...(layer()?.querySelectorAll<HTMLElement>("[data-tag]") ?? [])].map((s) => [s.dataset.tag, s.textContent, s.style.getPropertyValue("--tag")])
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  async function type(text: string) {
    textarea().focus()
    await act(async () => {
      setValue.call(textarea(), text)
      textarea().setSelectionRange(text.length, text.length)
      textarea().dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"))
      await new Promise((r) => setTimeout(r, 20))
    })
  }
  const transparent = () => textarea().classList.contains("text-transparent")
  /** The layer's lines; an empty one holds a zero-width space, so it takes a line's height. */
  const lines = () => [...layer()!.children].map((l) => l.textContent)
  const linesOf = (text: string) => text.split("\n").map((l) => l || "\u200b")

  it("in the Coordinator's chat: %project in its project's colour, @runner and !harness in theirs, unknown words plain", async () => {
    await mount(true)
    await type("ship %box-yard and %mobile on @box with !codex, not @nowhere")
    const mobile = PROJECT_COLOR_HEX[projectColors(PROJECTS).get("prj_mobile")!]
    expect(tags()).toEqual([
      ["project", "%box-yard", PROJECT_COLOR_HEX.rose],
      ["project", "%mobile", mobile],
      ["runsOn", "@box", TAG_COLOR.runsOn],
      ["agent", "!codex", TAG_COLOR.agent],
    ])
    // The layer draws the very text the textarea holds, which keeps the caret, selection and input.
    expect(lines()).toEqual(linesOf(textarea().value))
    expect(layer()!.getAttribute("aria-hidden")).toBe("true")
    expect(layer()!.className).toContain("pointer-events-none")
    expect(transparent()).toBe(true)
    // Its own colour would win over transparent and cover the tags.
    expect(textarea().classList.contains("text-zinc-100")).toBe(false)
    expect(textarea().className).toContain("caret-zinc-100")
  })

  it("draws nothing while the draft holds no tag, and goes when the last one does", async () => {
    await mount(true)
    await type("plain words, me@box and @nowhere")
    expect(layer()).toBeNull()
    expect(transparent()).toBe(false)
    expect(textarea().classList.contains("text-zinc-100")).toBe(true)
    await type("on @box")
    expect(tags()).toEqual([["runsOn", "@box", TAG_COLOR.runsOn]])
    await type("on @bo")
    expect(layer()).toBeNull()
    expect(transparent()).toBe(false)
  })

  it("in a Captain's chat, % is plain text: it isn't a pick there", async () => {
    await mount(true, "prj_mobile")
    await type("%box-yard on @box")
    expect(tags()).toEqual([["runsOn", "@box", TAG_COLOR.runsOn]])
    expect(lines()).toEqual(["%box-yard on @box"])
  })

  it("does nothing in a task's chat", async () => {
    await mount(false)
    await type("%box-yard on @box with !codex")
    expect(layer()).toBeNull()
    expect(transparent()).toBe(false)
  })

  it("follows the textarea's scroll", async () => {
    await mount(true)
    await type(`${"line\n".repeat(30)}on @box`)
    await act(async () => {
      textarea().scrollTop = 120
      textarea().dispatchEvent(new Event("scroll"))
    })
    expect(layer()!.scrollTop).toBe(textarea().scrollTop)
  })

  it("redraws only the line a key changes", async () => {
    await mount(true)
    const draft = `on @box\n${"a line of the plan\n".repeat(20)}and`
    await type(draft)
    expect(lines()).toEqual(linesOf(draft))
    const changed: Node[] = []
    const observer = new MutationObserver((records) => changed.push(...records.map((r) => r.target)))
    observer.observe(layer()!, { subtree: true, childList: true, characterData: true })
    await type(`${draft}d`)
    observer.disconnect()
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.every((n) => layer()!.lastElementChild!.contains(n))).toBe(true)
  })

  it("keeps the textarea's scrollbar gutter once the box scrolls, so both wrap at the same width", async () => {
    // happy-dom has no layout: 20px lines, so 40 lines are past the box's cap.
    vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return 12 + 20 * this.value.split("\n").length
    })
    await mount(true)
    await type("on @box")
    expect(layer()!.className).toContain("overflow-hidden")
    await type(`${"line\n".repeat(40)}on @box`)
    expect(textarea().style.overflowY).toBe("auto")
    expect(layer()!.className).toContain("overflow-y-scroll")
  })

  it("underlines, dashed, the tags only one item of a list is for; the whole message's stay as they are", async () => {
    await mount(true)
    const draft = "@box Two tasks:\n1. Port the pickaxe !codex\n2. Fix the bridge"
    await type(draft)
    const parts = () => [...layer()!.querySelectorAll<HTMLElement>("[data-tag]")].map((s) => [s.textContent, s.hasAttribute("data-part")])
    expect(parts()).toEqual([
      ["@box", false],
      ["!codex", true],
    ])
    expect(lines()).toEqual(linesOf(draft))
    // A single task's picks are the whole message's: none is underlined.
    await type("Fix the bridge @box !codex")
    expect(parts()).toEqual([
      ["@box", false],
      ["!codex", false],
    ])
  })

  it.each([undefined, "coordinator"])("still commits once per key with tags in the draft (%s)", async (draftKey) => {
    await mount(true, null, draftKey)
    await type("on @box with !codex h")
    commits.mockClear()
    for (const text of ["on @box with !codex he", "on @box with !codex hel", "on @box with !codex hell"]) await type(text)
    expect(commits).toHaveBeenCalledTimes(3)
    expect(tags().map(([kind]) => kind)).toEqual(["runsOn", "agent"])
  })
})
