// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { Modal } from "../web/src/components/Modal.js"
import { resetDrafts, setDraftText } from "../web/src/lib/composerDraft.js"
import { buildHarnessTargets, buildRunTargets } from "../shared/runTargets.js"
import { BUILTIN_MODELS } from "../shared/models.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGETS = buildRunTargets({
  problems: { local: null, box: null, docker: null, gpu: null },
  machines: [], localLabel: null,
  identityProblem: (runner) => runner === "docker" ? "This project disallows Docker" : null,
  gpu: { default: "runpod", problems: { runpod: null, vast: null, daytona: null }, types: { runpod: ["A40"], vast: ["RTX 4090"], daytona: ["H100"] } },
})
const HARNESSES = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
const SETTINGS = { agentModel: "sonnet", agentEffort: "medium", agentCodexModel: "gpt-6.1-terra", agentCodexEffort: "ultra", agentCursorModel: "auto" }
let host: HTMLElement, root: Root, client: QueryClient
const onSubmit = vi.fn(), outerClose = vi.fn()
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const input = () => document.querySelector("textarea")!
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
// Every Fable in the catalog, in its order: the latest, the aliases, then the older ones. A new release moves them along.
const FABLE_MODELS = BUILTIN_MODELS.filter((m) => /^fable/i.test(m.label))
const FABLES = FABLE_MODELS.map((m) => `claude:${m.id}`)
const NEWEST = FABLE_MODELS[0]!
const row = (token: string) => document.querySelector<HTMLElement>(`[role="option"][data-token="${token}"]`)!
/** The sheet's search field: it keeps the focus, and says which row is highlighted. */
const search = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[role="combobox"]')!
const active = () => document.getElementById(search().getAttribute("aria-activedescendant") ?? "")?.dataset.token
const tags = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => el.textContent)
async function find(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), text)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const choices = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((el) => el.dataset.token!)
const back = () => document.querySelector<HTMLElement>('button[data-dismiss="back"]')!
const title = () => document.querySelector('[data-testid="run-target-menu-title"]')!.textContent
async function tap(el: HTMLElement) {
  await act(async () => el.click())
  await settle()
}
function key(key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
  act(() => void document.activeElement!.dispatchEvent(event))
  return event
}
async function open(kind: "runsOn" | "agent") {
  await tap(document.querySelector<HTMLElement>(`[data-testid="pick-${kind}"]`)!)
}
function mount(enclosed = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const panel = createRef<HTMLElement>()
  const composer = createElement("section", { ref: panel }, createElement(Composer, {
    onSubmit, panelRef: panel, placeholder: "Ask", runTargets: true, draftKey: "coordinator",
  }))
  act(() => root.render(createElement(QueryClientProvider, { client }, enclosed
    ? createElement(Modal, { title: "Outer dialog", onClose: outerClose, children: composer }) : composer)))
}

beforeEach(() => {
  resetDrafts()
  onSubmit.mockReset()
  outerClose.mockReset()
  vi.stubGlobal("fetch", (url: string) => {
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }))
    if (url.startsWith("/api/run-targets")) return json(TARGETS)
    if (url.startsWith("/api/harness-targets")) return json(HARNESSES)
    if (url === "/api/agent-settings") return json({ settings: SETTINGS, sources: {}, defaults: {} })
    if (url === "/api/models") return json({ models: BUILTIN_MODELS, source: "builtin" })
    if (url === "/api/cursor/models") return json({ models: [{ id: "auto", label: "Auto" }, { id: "gpt-6.1-sol-high", label: "GPT 6.1 Sol High" }], source: "cli" })
    return json([])
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); client?.clear(); await frame() })
  host.remove()
  vi.unstubAllGlobals()
})

describe("Composer button picker panels", () => {
  it("drills into box sizes, uses Back and Esc one level at a time, and colours and sends the chosen token", async () => {
    setDraftText("coordinator", "Build the feature")
    mount()
    await settle()
    await open("runsOn")
    expect(dialog()?.getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(search())
    expect(active()).toBe("local")
    expect(row("local").getAttribute("aria-selected")).toBe("true")
    expect(input().getAttribute("aria-expanded")).toBe("false")
    await tap(row("box"))
    expect(choices()).toEqual(["box", "box:small", "box:medium", "box:large"])
    expect(row("box").textContent).toContain("Default size")
    expect(document.activeElement).toBe(search())
    expect(active()).toBe("box")
    expect(document.querySelector('[data-dismiss="close"]')).toBeNull()
    await tap(back())
    expect(choices()).toContain("local")
    await tap(row("box"))
    key("Escape")
    expect(choices()).toContain("local")
    expect(dialog()).not.toBeNull()
    await tap(row("box"))
    await tap(row("box:medium"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("Build the feature @box:medium ")
    expect(document.querySelector('[data-tag="runsOn"]')?.textContent).toBe("@box:medium")
    expect(document.activeElement).toBe(input())
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("Build the feature @box:medium", [], { runsOn: expect.objectContaining({ value: "box:medium", token: "box:medium" }) })
  })

  it.each(["daytona", "gpu:runpod", "gpu:vast"])("offers the shared %s provider choices with the default first", async (provider) => {
    mount()
    await settle()
    await open("runsOn")
    await tap(row(provider))
    expect(choices()[0]).toBe(provider)
    expect(back()).not.toBeNull()
    const child = TARGETS.find((t) => t.under === provider)!
    expect(child).toBeDefined()
    await tap(row(child.token))
    expect(dialog()).toBeNull()
    expect(input().value).toBe(`@${child.token} `)
    key("Enter")
    expect(onSubmit.mock.calls[0]![2].runsOn.value).toBe(child.value)
  })

  it.each([
    ["claude", "sonnet[1m]", "high"],
    ["codex", "gpt-6.1-sol", "xhigh"],
  ])("drills from %s to a model to effort, then replaces the full existing pick on reopening", async (harness, model, effort) => {
    mount()
    await settle()
    await open("agent")
    await tap(row(harness!))
    expect(choices()[0]).toBe(harness)
    expect(row(harness!).textContent).toContain("Settings default")
    expect(row(harness!).textContent).toContain(harness === "claude" ? "sonnet · Medium effort" : "gpt-6.1-terra · Ultra effort")
    expect(title()).toMatch(/Harness/)
    await tap(row(`${harness}:${model}`))
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe(`${harness}:${model}`)
    expect(row(`${harness}:${model}`).textContent).toContain("Default effort")
    key("Escape")
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe(harness)
    await tap(row(`${harness}:${model}`))
    await tap(row(`${harness}:${model}:${effort}`))
    expect(input().value).toBe(`!${harness}:${model}:${effort} `)
    expect(document.querySelector('[data-tag="agent"]')?.textContent).toBe(`!${harness}:${model}:${effort}`)
    await open("agent")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    await tap(row("cursor"))
    await tap(row("cursor:gpt-6.1-sol-high"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("!cursor:gpt-6.1-sol-high ")
    key("Enter")
    expect(onSubmit.mock.calls[0]![2].agent).toMatchObject({ value: "cursor", model: "gpt-6.1-sol-high" })
  })

  it("can finish on the Settings default, a model's default effort, or a model with no effort level", async () => {
    mount()
    await settle()
    await open("agent")
    await tap(row("codex"))
    await tap(row("codex"))
    expect(input().value).toBe("!codex ")
    await open("agent")
    await tap(row("codex"))
    await tap(row("codex:gpt-6.1-sol"))
    await tap(row("codex:gpt-6.1-sol"))
    expect(input().value).toBe("!codex:gpt-6.1-sol ")
    await open("agent")
    await tap(row("claude"))
    expect(choices().slice(1, 3)).toEqual(["claude:claude-fable-5-2", "claude:claude-opus-5-5"])
    expect(choices()).toContain("claude:claude-fable-5-1")
    await tap(row("claude:claude-opus-4-5"))
    expect(dialog()).toBeNull()
    expect(input().value).toBe("!claude:claude-opus-4-5 ")
  })

  it("moves the highlight with arrows, Home and End from the search field; Enter picks, Tab stays inside and disabled locations are skipped", async () => {
    mount()
    await settle()
    await open("runsOn")
    expect(row("docker").getAttribute("aria-disabled")).toBe("true")
    key("ArrowDown")
    expect(active()).toBe("box")
    key("ArrowDown")
    expect(active()).not.toBe("docker")
    key("End")
    expect(active()).toBe(choices().at(-1))
    key("Home")
    expect(active()).toBe("local")
    key("ArrowUp")
    expect(active()).toBe(choices().at(-1))
    key("Home")
    // The focus never left the field; Tab goes round the sheet's two stops.
    expect(document.activeElement).toBe(search())
    expect(key("Tab").defaultPrevented).toBe(true)
    expect(document.activeElement?.getAttribute("data-dismiss")).toBe("close")
    key("Tab", true)
    expect(document.activeElement).toBe(search())
    await tap(row("docker"))
    expect(input().value).toBe("@")
    key("ArrowDown")
    key("Enter")
    expect(choices()[0]).toBe("box")
    key("ArrowDown")
    // Space is the search's (it separates words): only Enter and a press pick.
    expect(key(" ").defaultPrevented).toBe(false)
    expect(input().value).toBe("@box:")
    key("Enter")
    expect(input().value).toBe("@box:small ")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("searches in the sheet's field; Esc clears the search before backing out, Backspace in an empty one goes back", async () => {
    mount()
    await settle()
    await open("agent")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    await find("cur")
    expect(choices()).toEqual(["cursor"])
    expect(active()).toBe("cursor")
    expect(key("Escape").defaultPrevented).toBe(true)
    expect(search().value).toBe("")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    expect(dialog()).not.toBeNull()
    await find("cur")
    key("Enter")
    expect(choices()[0]).toBe("cursor")
    expect(input().value).toBe("!cursor:")
    // A new level starts with an empty search, which now looks only inside it.
    expect(search().value).toBe("")
    await find("deep")
    // No DeepSeek in the stub catalog: nothing matches, and Esc clears it.
    expect(choices()).toEqual([])
    expect(dialog()?.textContent).toContain("No matches for “deep”")
    expect(search().hasAttribute("aria-activedescendant")).toBe(false)
    key("Enter")
    expect(input().value).toBe("!cursor:")
    key("Escape")
    expect(choices()).toEqual(["cursor", "cursor:auto", "cursor:gpt-6.1-sol-high"])
    expect(input().value).toBe("!cursor:")
    key("Backspace")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    expect(dialog()).not.toBeNull()
    // At the top there is no level to leave.
    key("Backspace")
    expect(dialog()).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("finds a model and its effort from words, and Enter picks them in one go", async () => {
    mount()
    await settle()
    await open("agent")
    await find("fable high")
    expect(choices()).toEqual(FABLES.map((token) => `${token}:high`))
    expect(active()).toBe(`claude:${NEWEST.id}:high`)
    // Each row is named for its model, with the effort beside it and what sets it apart: no two read alike.
    expect(row(`claude:${NEWEST.id}:high`).textContent).toContain(`${NEWEST.label}High`)
    expect(row("claude:fable:high").textContent).toContain("alias")
    expect(row("claude:claude-fable-5:high").textContent).toContain("older")
    expect(new Set(tags()).size).toBe(FABLES.length)
    expect([...row(`claude:${NEWEST.id}:high`).querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Fable", "High"])
    key("Enter")
    expect(dialog()).toBeNull()
    expect(input().value).toBe(`!claude:${NEWEST.id}:high `)
    expect(document.activeElement).toBe(input())
    key("Enter")
    expect(onSubmit.mock.calls[0]![2].agent).toMatchObject({ value: "claude", model: NEWEST.id, effort: "high" })
  })

  it("lists each model once for part of a name, and opens the first one's efforts on Enter", async () => {
    mount()
    await settle()
    await open("agent")
    await find("fa")
    expect(choices()).toEqual(FABLES)
    expect(document.querySelector('[data-testid="run-target-menu"]')?.textContent).toContain("↵ open")
    key("Enter")
    expect(title()).toContain(NEWEST.label)
    expect(choices()[0]).toBe(`claude:${NEWEST.id}`)
    await find("x")
    // One letter only counts where it starts a word: "x" is Extra high, not also Max.
    expect(choices()).toEqual([`claude:${NEWEST.id}:xhigh`])
    await find("m")
    expect(choices()).toEqual([`claude:${NEWEST.id}:medium`, `claude:${NEWEST.id}:max`])
    key("ArrowDown")
    key("Enter")
    expect(input().value).toBe(`!claude:${NEWEST.id}:max `)
  })

  it("searches inside an open level, and a model's name there finds its efforts too", async () => {
    mount()
    await settle()
    await open("agent")
    await tap(row("codex"))
    await find("fable")
    expect(choices()).toEqual([])
    await find("sol ultra")
    expect(active()).toBe("codex:gpt-6.1-sol:ultra")
    key("Enter")
    expect(input().value).toBe("!codex:gpt-6.1-sol:ultra ")
  })

  it("the pointer moves the same highlight the keys do, so Enter picks the row under it", async () => {
    mount()
    await settle()
    await open("agent")
    act(() => void row("codex").dispatchEvent(new MouseEvent("mousemove", { bubbles: true })))
    expect(active()).toBe("codex")
    expect(row("claude").getAttribute("aria-selected")).toBe("false")
    // A press on a row leaves the focus in the search field.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    act(() => void row("codex").dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    key("ArrowDown")
    expect(active()).toBe("cursor")
    key("Enter")
    expect(choices()[0]).toBe("cursor")
  })

  it("on a touch screen the list takes the focus, and a typed letter still goes to the search", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
    mount()
    await settle()
    await open("agent")
    // No keyboard over the choices until the field is tapped.
    expect(document.activeElement?.getAttribute("role")).toBe("listbox")
    key("ArrowDown")
    expect(active()).toBe("codex")
    expect(key("c").defaultPrevented).toBe(true)
    expect(search().value).toBe("c")
    expect(document.activeElement).toBe(search())
  })

  it("Esc unwinds effort, model and picker before an enclosing dialog; focus returns to the opening button", async () => {
    mount(true)
    await settle()
    const button = document.querySelector<HTMLElement>('[data-testid="pick-agent"]')!
    act(() => button.focus())
    await tap(button)
    await tap(row("codex"))
    await tap(row("codex:gpt-6.1-sol"))
    key("Escape")
    expect(title()).toMatch(/Harness/)
    expect(choices()[0]).toBe("codex")
    key("Escape")
    expect(choices()).toEqual(["claude", "codex", "cursor"])
    key("Escape")
    expect(document.querySelector('[data-testid="run-target-menu"]')).toBeNull()
    expect(outerClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    key("Escape")
    expect(outerClose).toHaveBeenCalledOnce()
  })

  it("opens the same panels from the folded More lines", async () => {
    mount()
    await settle()
    await tap(document.querySelector<HTMLElement>('[data-testid="composer-more"]')!)
    await tap(document.querySelector<HTMLElement>('[data-testid="more-pick-agent"]')!)
    expect(document.querySelector('[data-testid="composer-more-menu"]')).toBeNull()
    expect(dialog()).not.toBeNull()
    await tap(row("cursor"))
    await tap(row("cursor:auto"))
    expect(input().value).toBe("!cursor:auto ")
  })
})
