// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { buildHarnessTargets, buildRunTargets } from "../shared/runTargets.js"
import { keys } from "../web/src/lib/queries.js"
import type { Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TARGETS = buildRunTargets({
  problems: { local: null, box: null, docker: null, gpu: "no RunPod key" },
  machines: [{ name: "studio-mac", labels: ["laptops"], state: "ready" }],
  localLabel: null,
})

const HARNESSES = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
// A Captain's project: it runs on this computer and follows Settings › Box agents, which says Codex.
const PROJECT = { id: "prj_captain", name: "Mobile", runner: "local", machineLabel: null, agentCli: null, description: "" } as unknown as Project
// Another project, for messages with tasks for both.
const WEB = { id: "prj_web", name: "Web", runner: null, machineLabel: null, agentCli: null, description: "" } as unknown as Project
let projects: Project[] = [PROJECT]
// On an SSH machine, Codex shows greyed out (the server's list does the same).
const ON_SSH = buildHarnessTargets({ problems: { claude: null, codex: "no", cursor: "no" }, blocked: { codex: "Codex is unavailable here" } })

let root: Root
let host: HTMLElement
const onSubmit = vi.fn()
const rendered = vi.fn()
const asked: string[] = []
let client: QueryClient

function mount(runTargets: boolean, count = 1, projectId: string | null = null) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Profiler, { id: "composers", onRender: rendered }, ...Array.from({ length: count }, (_, i) => {
          const panel = createRef<HTMLElement>()
          return createElement("section", { key: i, ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel, runTargets, runTargetsProject: projectId }))
        })),
      ),
    ),
  )
}

beforeEach(() => {
  onSubmit.mockClear()
  rendered.mockClear()
  asked.length = 0
  projects = [PROJECT]
  vi.stubGlobal("fetch", (url: string) => {
    asked.push(String(url))
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }))
    if (String(url).startsWith("/api/run-targets")) return json(TARGETS)
    if (String(url).startsWith("/api/harness-targets")) return json(/runsOn=(label|ssh)/.test(String(url)) ? ON_SSH : HARNESSES)
    if (String(url) === "/api/projects") return json(projects)
    if (String(url) === "/api/agent-settings") return json({ settings: { agentCli: "codex" }, sources: {}, defaults: {} })
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    client?.clear()
    // Let pending afterPaint availability probes reach the stub before restoring fetch.
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  })
  focusManager.setFocused(undefined)
  host.remove()
  vi.unstubAllGlobals()
})

const textarea = () => document.querySelector("textarea")!
const menu = () => document.querySelector<HTMLElement>('[data-testid="run-target-menu"]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.dataset.token)
const whereButton = () => document.querySelector<HTMLElement>('[data-testid="pick-runsOn"]')!
const harnessButton = () => document.querySelector<HTMLElement>('[data-testid="pick-agent"]')!
const projectButton = () => document.querySelector<HTMLElement>('[data-testid="pick-project"]')
const option = (token: string) => document.querySelector<HTMLElement>(`[role="option"][data-token="${token}"]`)!
const listTitle = () => document.querySelector<HTMLElement>('[data-testid="run-target-menu-title"]')?.textContent
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
async function press(el: HTMLElement) {
  await act(async () => void el.click())
  await settle()
}
/** A tap on a list's option. */
const tap = press
const active = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.dataset.token
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
function slowResponse() {
  let resolve!: (v: Response) => void
  const promise = new Promise<Response>((r) => { resolve = r })
  return { promise, reply: (v: unknown) => resolve(json(v)), fail: () => resolve(new Response("Unavailable", { status: 503 })) }
}
const requestsFor = (path: string) => asked.filter((u) => u.startsWith(path))
function ageLists() {
  for (const key of [keys.runTargets(null), keys.harnessTargets(null, null)]) {
    client.setQueryData(key, client.getQueryData(key), { updatedAt: Date.now() - 31_000 })
  }
}

async function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  textarea().focus()
  await act(async () => {
    set.call(textarea(), text)
    textarea().setSelectionRange(text.length, text.length)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  // The list's fetch resolves on a later tick.
  await act(async () => new Promise((r) => setTimeout(r, 20)))
}

function key(k: string) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
  act(() => void (document.querySelector('[role="dialog"]') ? document.activeElement! : textarea()).dispatchEvent(e))
  return e
}

describe('Composer "@" run targets', () => {
  it("opens on @, lists the server's targets and filters as Cody types", async () => {
    mount(true)
    // Asked for once the chat it opened with is painted, not in the tap that opened it.
    expect(asked.some((u) => u.startsWith("/api/run-targets"))).toBe(false)
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))))
    expect(asked.some((u) => u.startsWith("/api/run-targets"))).toBe(true)
    await type("start it on @")
    expect(menu()).not.toBeNull()
    expect(options()).toEqual(["local", "box", "docker", "studio-mac", "ssh", "label:laptops"])
    expect(textarea().getAttribute("aria-expanded")).toBe("true")
    await type("start it on @lap")
    expect(options()).toEqual(["label:laptops"])
    await type("start it on @zzz")
    expect(menu()).toBeNull()
  })

  it("↓ and Enter pick instead of sending; the pick goes with the message", async () => {
    mount(true)
    await type("fix it @")
    expect(active()).toBe("local")
    key("ArrowDown")
    expect(active()).toBe("box")
    key("ArrowUp")
    key("ArrowUp")
    expect(active()).toBe("label:laptops")
    key("ArrowDown")
    key("ArrowDown")
    const enter = key("Enter")
    expect(enter.defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    // Enter on a partial token drills with a trailing ":" so sizes stay open.
    expect(textarea().value).toBe("fix it @box:")
    expect(options()).toEqual(["box", "box:small", "box:medium", "box:large"])
    key("Enter")
    expect(textarea().value).toBe("fix it @box ")
    expect(menu()).toBeNull()
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @box (Upstash box)")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("fix it @box", [], { runsOn: { value: "box", token: "box", label: "Upstash box" } })
  })

  it("offers box sizes after a tap and sends a typed hyphen alias as the same size", async () => {
    mount(true)
    await type("fix it @bo")
    await tap(option("box"))
    await tap(option("box:medium"))
    expect(textarea().value).toBe("fix it @box:medium ")
    expect(menu()).toBeNull()
    await type("fix it @box-medium")
    key("Escape")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("fix it @box-medium", [], { runsOn: { value: "box:medium", token: "box:medium", label: "Upstash Medium" } })
  })

  it("box sizes use the harness drill-down: the default size first, and Back or Esc returns to every place", async () => {
    mount(true)
    await type("fix it @bo")
    await tap(option("box"))
    expect(textarea().value).toBe("fix it @box:")
    expect(option("box").textContent).toContain("Default size")
    expect(listTitle()).toContain("Upstash box")
    await tap(document.querySelector<HTMLElement>('button[aria-label="Back to choices"]')!)
    expect(textarea().value).toBe("fix it @")
    expect(options()).toContain("local")
    await tap(option("box"))
    key("Escape")
    expect(textarea().value).toBe("fix it @")
  })

  it("Tab picks, a tap picks, Esc closes and Enter then sends", async () => {
    mount(true)
    await type("on @st")
    key("Tab")
    expect(textarea().value).toBe("on @studio-mac ")
    await type("on @la")
    act(() => void document.querySelector<HTMLElement>('[data-token="label:laptops"]')!.click())
    expect(textarea().value).toBe("on @label:laptops ")
    await type("mail @lo")
    const esc = key("Escape")
    expect(esc.defaultPrevented).toBe(true)
    expect(menu()).toBeNull()
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("mail @lo", [])
  })

  it("opens a GPU cloud's GPUs on the first pick, then picks one of them or any GPU there", async () => {
    const gpuTargets = buildRunTargets({
      problems: { local: null, box: null, docker: null, gpu: null },
      machines: [],
      localLabel: null,
      gpu: { default: "runpod", problems: { runpod: null, vast: "no key", daytona: null }, types: { runpod: [], vast: [], daytona: ["H100"] } },
    })
    const fetchAll = globalThis.fetch
    vi.stubGlobal("fetch", (url: string) => (String(url).startsWith("/api/run-targets") ? Promise.resolve(json(gpuTargets)) : fetchAll(url)))
    mount(true)
    await type("train it @gpu")
    expect(options().filter((t) => t === "gpu" || t?.startsWith("gpu:"))).toEqual(["gpu", "gpu:runpod", "gpu:daytona"])
    // A cloud with GPUs says it opens them; plain @gpu (the default cloud) doesn't.
    expect(option("gpu:daytona").querySelector('[data-testid="run-target-opens"]')).not.toBeNull()
    expect(option("gpu").querySelector('[data-testid="run-target-opens"]')).toBeNull()
    await tap(option("gpu:daytona"))
    expect(textarea().value).toBe("train it @gpu:daytona:")
    expect(menu()).not.toBeNull()
    expect(options()[0]).toBe("gpu:daytona")
    expect(options()).toContain("gpu:daytona:h100")
    expect(option("gpu:daytona").querySelector('[data-testid="run-target-opens"]')).toBeNull()
    await tap(option("gpu:daytona:h100"))
    expect(textarea().value).toBe("train it @gpu:daytona:h100 ")
    expect(menu()).toBeNull()
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @gpu:daytona:h100 (Daytona H100)")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("train it @gpu:daytona:h100", [], { runsOn: { value: "gpu:daytona:h100", token: "gpu:daytona:h100", label: "Daytona H100" } })

    // Enter on the opened cloud's own row picks any GPU there.
    await type("again @gpu:daytona")
    expect(active()).toBe("gpu:daytona")
    key("Enter")
    expect(textarea().value).toBe("again @gpu:daytona ")
  })

  it("does nothing in a chat without the list (a task's)", async () => {
    mount(false)
    await type("ping @box")
    expect(menu()).toBeNull()
    expect(asked.some((u) => u.startsWith("/api/run-targets"))).toBe(false)
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("ping @box", [])
  })
})

describe('Composer "!" harness', () => {
  it("opens on ! at the start of a word only, lists the harnesses for where the tasks run, and sends both picks", async () => {
    mount(true)
    await type("great!")
    expect(menu()).toBeNull()
    await type("fix it @box !")
    expect(menu()?.dataset.kind).toBe("agent")
    expect(options()).toEqual(["claude", "codex", "cursor"])
    expect(asked).toContain("/api/harness-targets?runsOn=box")
    await type("fix it @box !co")
    // Codex leads (token prefix); Cursor and Claude Code also match "co".
    expect(options()[0]).toBe("codex")
    expect(options()).toEqual(expect.arrayContaining(["codex", "cursor", "claude"]))
    key("Tab")
    // Partial "co" → Tab drills into Codex models with a trailing ":".
    expect(textarea().value).toBe("fix it @box !codex:")
    expect(options()[0]).toBe("codex")
    expect(option("codex").textContent).toContain("Settings default")
    // On `!codex:` the Settings default row picks (no further drill).
    key("Tab")
    expect(textarea().value).toBe("fix it @box !codex ")
    expect(harnessButton().getAttribute("aria-label")).toBe("Harness: !codex (Codex)")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("fix it @box !codex", [], {
      runsOn: { value: "box", token: "box", label: "Upstash box" },
      agent: { value: "codex", token: "codex", label: "Codex" },
    })
  })

  it("drills into models then supported efforts, goes back with tap or Esc, and sends the explicit choice", async () => {
    mount(true)
    await type("build !")
    await tap(option("codex"))
    expect(textarea().value).toBe("build !codex:")
    expect(options()).toContain("codex:gpt-6.1-sol")
    await tap(option("codex:gpt-6.1-sol"))
    expect(textarea().value).toBe("build !codex:gpt-6.1-sol:")
    expect(options()[0]).toBe("codex:gpt-6.1-sol")
    expect(option("codex:gpt-6.1-sol").textContent).toContain("Default effort")
    expect(options()).toContain("codex:gpt-6.1-sol:ultra")
    key("Escape")
    expect(textarea().value).toBe("build !codex:")
    await tap(document.querySelector<HTMLElement>('button[aria-label="Back to choices"]')!)
    expect(textarea().value).toBe("build !")
    await tap(option("codex"))
    await tap(option("codex:gpt-6.1-sol"))
    await tap(option("codex:gpt-6.1-sol:xhigh"))
    expect(textarea().value).toBe("build !codex:gpt-6.1-sol:xhigh ")
    expect(menu()).toBeNull()
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("build !codex:gpt-6.1-sol:xhigh", [], { agent: expect.objectContaining({ value: "codex", model: "gpt-6.1-sol", effort: "xhigh" }) })
  })

  it("Tab or Space on an exact harness advances so typing filters models (no colon to discover)", async () => {
    mount(true)
    await type("build !cursor")
    await act(async () => client.setQueryData(keys.cursorModels, {
      models: [
        { id: "auto", label: "Auto" },
        { id: "deepseek-v3", label: "DeepSeek V3" },
        { id: "gpt-6.1-sol-high", label: "GPT 6.1 Sol High" },
      ],
      source: "cli",
    }))
    await settle()
    expect(options()).toEqual(["cursor", "cursor:auto", "cursor:deepseek-v3", "cursor:gpt-6.1-sol-high"])
    // Exact !cursor + Tab advances into models (trailing ":"); Enter would have picked Settings default.
    const tab = key("Tab")
    expect(tab.defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea().value).toBe("build !cursor:")
    await type("build !cursor:deep")
    expect(options()).toEqual(["cursor:deepseek-v3"])
    expect(listTitle()).toMatch(/Harness/)
    expect(listTitle()).toMatch(/Cursor|DeepSeek|↑↓|Tab/)
    key("Tab")
    expect(textarea().value).toBe("build !cursor:deepseek-v3 ")
    expect(menu()).toBeNull()
    key("Enter")
    expect(onSubmit.mock.calls.at(-1)?.[2].agent).toMatchObject({ value: "cursor", model: "deepseek-v3" })
    expect(onSubmit.mock.calls.at(-1)?.[2].agent.effort).toBeUndefined()

    // Space on an exact harness advances the same way.
    await type("again !cursor")
    const space = key(" ")
    expect(space.defaultPrevented).toBe(true)
    expect(textarea().value).toBe("again !cursor:")
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("uses Cursor's live ids as leaves, and preserves model-only and plain tags typed with whitespace", async () => {
    mount(true)
    await type("build !cursor")
    await act(async () => client.setQueryData(keys.cursorModels, { models: [{ id: "future-max", label: "Future Max" }], source: "cli" }))
    await settle()
    expect(options()).toEqual(["cursor", "cursor:future-max"])
    await tap(option("cursor:future-max"))
    expect(textarea().value).toBe("build !cursor:future-max ")
    key("Enter")
    expect(onSubmit.mock.calls.at(-1)?.[2].agent).toMatchObject({ value: "cursor", model: "future-max" })
    expect(onSubmit.mock.calls.at(-1)?.[2].agent.effort).toBeUndefined()
    await type("build !claude:sonnet[1m] please")
    key("Enter")
    expect(onSubmit.mock.calls.at(-1)?.[2].agent).toMatchObject({ value: "claude", model: "sonnet[1m]" })
    await type("build !codex please")
    key("Enter")
    expect(onSubmit.mock.calls.at(-1)?.[2].agent).toEqual({ value: "codex", token: "codex", label: "Codex" })
  })

  it("warns about Codex on an SSH machine before sending, and won't send it", async () => {
    mount(true)
    await type("build @studio-mac !codex")
    expect(document.querySelector('[data-testid="pick-conflict"]')?.textContent).toMatch(/Codex is unavailable here \(you picked @studio-mac\)/)
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true)
    // The Harness button says it too, without hover.
    expect(harnessButton().getAttribute("aria-label")).toBe("Harness: !codex (Codex, Codex is unavailable here)")
    key("Enter")
    expect(onSubmit).not.toHaveBeenCalled()
    // Another place clears it.
    await type("build @box !codex")
    expect(document.querySelector('[data-testid="pick-conflict"]')).toBeNull()
  })
})

describe("Composer Where, Harness and Project buttons", () => {
  it("type their trigger at the caret and open a sheet whose search field takes focus", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: Default (This computer, Mobile's Runs on)")
    // Preserve the caret on the press; the sheet's search field then takes the focus, its first choice highlighted.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    whereButton().dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    await press(whereButton())
    expect(textarea().value).toBe("@")
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search where tasks run")
    expect(active()).toBe("local")
    expect(textarea().getAttribute("aria-expanded")).toBe("false")
    expect(textarea().selectionStart).toBe(1)
    expect(menu()?.dataset.kind).toBe("runsOn")
    expect(options()).toEqual(["local", "box", "docker", "studio-mac", "ssh", "label:laptops"])
    // The sheet says what Default is, since the buttons are only icons.
    expect(menu()?.textContent).toContain("Default: This computer, Mobile's Runs on")
    await tap(option("box"))
    expect(options()).toEqual(["box", "box:small", "box:medium", "box:large"])
    await tap(option("box"))
    expect(textarea().value).toBe("@box ")
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @box (Upstash box)")
    // After a space, no extra one.
    await press(harnessButton())
    expect(textarea().value).toBe("@box !")
    expect(menu()?.dataset.kind).toBe("agent")
    await tap(option("claude"))
    await type("@box !claude ship it")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("@box !claude ship it", [], {
      runsOn: { value: "box", token: "box", label: "Upstash box" },
      agent: { value: "claude", token: "claude", label: "Claude Code" },
    })
  })

  it("space the trigger from the words around the caret, and a second press opens the same one again", async () => {
    mount(true)
    await settle()
    await type("run now")
    act(() => textarea().setSelectionRange(3, 3))
    await press(whereButton())
    expect(textarea().value).toBe("run @ now")
    expect(textarea().selectionStart).toBe(5)
    expect(menu()?.dataset.kind).toBe("runsOn")
    key("Escape")
    expect(menu()).toBeNull()
    await press(whereButton())
    expect(textarea().value).toBe("run @ now")
    expect(menu()?.dataset.kind).toBe("runsOn")
  })

  it("select the draft's own pick instead of adding another, so a pick from the list replaces it", async () => {
    mount(true)
    await settle()
    await type("run @box now")
    await press(whereButton())
    expect(textarea().value).toBe("run @box now")
    expect([textarea().selectionStart, textarea().selectionEnd]).toEqual([5, 8])
    expect(menu()?.dataset.kind).toBe("runsOn")
    await tap(option("local"))
    expect(textarea().value).toBe("run @local now")
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @local (This computer)")
  })

  it("aren't there in a chat without picks (a task's)", () => {
    mount(false)
    expect(document.querySelector('[data-testid="pick-runsOn"]')).toBeNull()
    expect(document.querySelector('[data-testid="pick-agent"]')).toBeNull()
    expect(projectButton()).toBeNull()
  })
})

describe("Composer picks typed in one item of a list of tasks", () => {
  const scopeChips = (which: "wide" | "inline") => [...document.querySelectorAll<HTMLElement>(`[data-testid="pick-scope-${which}"]`)].map((c) => c.textContent)

  it("one inline pick is only its item's: the message's own pick still goes as its pick, the item's as a hint", async () => {
    mount(true)
    await settle()
    const text = "@box Two tasks:\n1. Raise the drawbridge, use Codex gpt-6.1-sol xhigh\n2. Port the pickaxe !claude"
    // A space after "!claude" closes its list: typed whole, it opens Claude's models.
    await type(`${text} `)
    // The buttons are the whole message's: Where says @box, Harness stays on Default.
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @box (Upstash box)")
    expect(harnessButton().getAttribute("aria-label")).toMatch(/^Harness: Default/)
    // The line over the buttons says which is which.
    expect(scopeChips("wide")).toEqual(["@box"])
    expect(scopeChips("inline")).toEqual(["!claude · item 2"])
    expect(document.querySelector('[data-testid="pick-scope"]')?.textContent).toContain("Only their part")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith(text, [], {
      runsOn: { value: "box", token: "box", label: "Upstash box" },
      inline: [{ kind: "agent", value: "claude", token: "claude", label: "Claude Code", where: 'item 2 ("Port the pickaxe")', reason: "item" }],
    })
  })

  it("several different picks force nothing: each goes as a hint for its item", async () => {
    mount(true)
    await settle()
    const text = "1. Port the pickaxe !codex\n2. Fix the bridge !claude @local"
    await type(text)
    expect(harnessButton().getAttribute("aria-label")).toMatch(/^Harness: Default/)
    expect(whereButton().getAttribute("aria-label")).toMatch(/^Where tasks run: Default/)
    expect(scopeChips("wide")).toEqual([])
    expect(scopeChips("inline")).toEqual(["!codex · item 1", "!claude · item 2", "@local · item 2"])
    key("Escape")
    key("Enter")
    const [, , extra] = onSubmit.mock.calls[0]!
    expect(extra.runsOn).toBeUndefined()
    expect(extra.agent).toBeUndefined()
    expect(extra.inline.map((p: { token: string; where: string }) => [p.token, p.where])).toEqual([
      ["codex", 'item 1 ("Port the pickaxe")'],
      ["claude", 'item 2 ("Fix the bridge")'],
      ["local", 'item 2 ("Fix the bridge")'],
    ])
  })

  it("a single task shows no line, and sends its picks as the message's, as before", async () => {
    mount(true)
    await settle()
    await type("Fix the login bug.\n\nIt fails on Safari. @box !codex ")
    expect(document.querySelector('[data-testid="pick-scope"]')).toBeNull()
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("Fix the login bug.\n\nIt fails on Safari. @box !codex", [], {
      runsOn: { value: "box", token: "box", label: "Upstash box" },
      agent: { value: "codex", token: "codex", label: "Codex" },
    })
  })

  it("the list typed in an item says it's that item's; a button puts the whole message's pick at its start", async () => {
    mount(true)
    await settle()
    await type("Two tasks:\n1. Port the pickaxe\n2. Fix the bridge !")
    expect(menu()?.dataset.kind).toBe("agent")
    expect(listTitle()).toContain("Which harness runs item 2's task")
    expect(listTitle()).toContain("only item 2's, not the whole message's")
    key("Escape")
    // The caret in item 1: the Where button is the whole message's, so its @ goes on top, not into item 1.
    act(() => textarea().setSelectionRange(20, 20))
    await press(whereButton())
    expect(textarea().value).toBe("@ Two tasks:\n1. Port the pickaxe\n2. Fix the bridge !")
    expect(textarea().selectionStart).toBe(1)
    expect(listTitle()).toContain("Where this message's tasks run")
    await tap(option("box"))
    // Drill keeps a trailing ":" so sizes stay open; the @box token still counts as the message's pick.
    expect(textarea().value.startsWith("@box: Two tasks:")).toBe(true)
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: @box (Upstash box)")
    // A pick typed in an item isn't the button's: pressing Harness adds the message's own, on top too.
    await type("@box Two tasks:\n1. Port the pickaxe\n2. Fix the bridge !claude")
    act(() => textarea().setSelectionRange(25, 25))
    await press(harnessButton())
    expect(textarea().value).toBe("! @box Two tasks:\n1. Port the pickaxe\n2. Fix the bridge !claude")
  })
})

describe('Composer "%" typed in one item of a list of tasks', () => {
  const scopeChips = (which: "wide" | "inline") => [...document.querySelectorAll<HTMLElement>(`[data-testid="pick-scope-${which}"]`)].map((c) => c.textContent)
  const mobile = { value: "prj_captain", token: "mobile", label: "Mobile" }
  const web = { value: "prj_web", token: "web", label: "Web" }

  it("one item's %project is only that item's: the message goes with no project, and the Coordinator is told where it is", async () => {
    projects = [PROJECT, WEB]
    mount(true)
    await settle()
    const text = "Three tasks:\n1. Fix the flaky login test\n2. Speed up the build\n3. Tidy the header %web"
    await type(text)
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: none picked, the Coordinator decides")
    expect(scopeChips("wide")).toEqual([])
    expect(scopeChips("inline")).toEqual(["%web · item 3"])
    key("Escape")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith(text, [], { inline: [{ kind: "project", ...web, where: 'item 3 ("Tidy the header")', reason: "item" }] })
  })

  it("a project per item names no project for the message; each goes as a hint for its item", async () => {
    projects = [PROJECT, WEB]
    mount(true)
    await settle()
    await type("1. %mobile Fix the flaky login test @box\n2. %web Tidy the header @box ")
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: none picked, the Coordinator decides")
    // @box in every item agrees, but it's still written in the items: each item's own.
    expect(scopeChips("inline")).toEqual(["%mobile · item 1", "@box · item 1", "%web · item 2", "@box · item 2"])
    key("Enter")
    const [, , extra] = onSubmit.mock.calls[0]!
    expect(extra.project).toBeUndefined()
    expect(extra.inline.filter((p: { kind: string }) => p.kind === "project")).toEqual([
      { kind: "project", ...mobile, where: 'item 1 ("Fix the flaky login test")', reason: "item" },
      { kind: "project", ...web, where: 'item 2 ("Tidy the header")', reason: "item" },
    ])
  })

  it("a %project over the list is the whole message's, as before; one over it that an item contradicts isn't", async () => {
    projects = [PROJECT, WEB]
    mount(true)
    await settle()
    await type("%mobile Two tasks:\n1. Fix the flaky login test\n2. Speed up the build")
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: %mobile (Mobile)")
    expect(document.querySelector('[data-testid="pick-scope"]')).toBeNull()
    key("Escape")
    key("Enter")
    expect(onSubmit).toHaveBeenLastCalledWith("%mobile Two tasks:\n1. Fix the flaky login test\n2. Speed up the build", [], { project: mobile })

    await type("%mobile Two tasks:\n1. Fix the flaky login test\n2. Tidy the header %web")
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: none picked, the Coordinator decides")
    expect(scopeChips("inline")).toEqual(["%mobile · disagrees", "%web · item 2"])
    key("Escape")
    key("Enter")
    const [, , extra] = onSubmit.mock.calls[1]!
    expect(extra.project).toBeUndefined()
    expect(extra.inline).toEqual([
      { kind: "project", ...mobile, where: null, reason: "mixed" },
      { kind: "project", ...web, where: 'item 2 ("Tidy the header")', reason: "item" },
    ])
  })

  it("the % list typed in an item says it's that item's; the Project button puts the message's % at its start", async () => {
    projects = [PROJECT, WEB]
    mount(true)
    await settle()
    await type("Two tasks:\n1. Fix the flaky login test\n2. Tidy the header %")
    expect(menu()?.dataset.kind).toBe("project")
    expect(listTitle()).toContain("Which project item 2 is for")
    expect(listTitle()).toContain("only item 2's, not the whole message's")
    key("Escape")
    act(() => textarea().setSelectionRange(20, 20))
    await press(projectButton()!)
    expect(textarea().value).toBe("% Two tasks:\n1. Fix the flaky login test\n2. Tidy the header %")
    expect(listTitle()).toContain("Which project this message is for")
    await tap(option("mobile"))
    expect(textarea().value.startsWith("%mobile Two tasks:")).toBe(true)
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: %mobile (Mobile)")
  })
})

describe('Composer "%" project, in the Coordinator\'s chat', () => {
  it("the Project button types %, lists the projects, and the pick goes with the message, its %token kept in the text", async () => {
    mount(true)
    await settle()
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: none picked, the Coordinator decides")
    await type("fix the flaky test")
    await press(projectButton()!)
    expect(textarea().value).toBe("fix the flaky test %")
    expect(menu()?.dataset.kind).toBe("project")
    expect(options()).toEqual(["mobile"])
    expect(listTitle()).toContain("its Captain gets it")
    await tap(option("mobile"))
    expect(textarea().value).toBe("fix the flaky test %mobile ")
    expect(projectButton()!.getAttribute("aria-label")).toBe("Project: %mobile (Mobile)")
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("fix the flaky test %mobile", [], { project: { value: "prj_captain", token: "mobile", label: "Mobile" } })
  })

  it("matches loosely as Cody types, and Tab picks", async () => {
    mount(true)
    await settle()
    await type("see %mbl")
    expect(options()).toEqual(["mobile"])
    key("Tab")
    expect(textarea().value).toBe("see %mobile ")
  })

  it("a bare % lists every project; Markdown headings, issue numbers and mid-word %s stay text", async () => {
    mount(true)
    await settle()
    await type("%")
    expect(options()).toEqual(["mobile"])
    for (const text of ["% Plan", "%% Plan", "see %123", "a%mob", "C%"]) {
      await type(text)
      expect(menu(), text).toBeNull()
    }
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("C%", [])
  })

  it("does nothing in a Captain's chat, which is already its project's", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    expect(projectButton()).toBeNull()
    await type("ask %mob")
    expect(menu()).toBeNull()
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("ask %mob", [])
  })

  it("does nothing in a task's chat", async () => {
    mount(false)
    await type("ask %mob")
    expect(menu()).toBeNull()
    expect(asked).not.toContain("/api/projects")
  })
})

describe("Composer picker cache", () => {
  it("prefetches both lists once across composers; cold lists open while responses are still pending", async () => {
    const places = slowResponse(), harnesses = slowResponse()
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url)
      if (url.startsWith("/api/run-targets")) return places.promise
      if (url.startsWith("/api/harness-targets")) return harnesses.promise
      return new Promise(() => {})
    })
    mount(true, 2)
    await settle()
    expect(requestsFor("/api/run-targets")).toEqual(["/api/run-targets"])
    expect(requestsFor("/api/harness-targets")).toEqual(["/api/harness-targets"])
    await press(whereButton())
    expect(menu()?.querySelector("[data-loading]")).not.toBeNull()
    expect(options()).toEqual([])
    // The search field is there while the list loads.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search where tasks run")
    key("Escape")
    // Opening another composer's list shares the same pending request.
    await press(document.querySelectorAll<HTMLElement>('[data-testid="pick-agent"]')[1]!)
    expect(menu()?.dataset.kind).toBe("agent")
    expect(menu()?.querySelector("[data-loading]")).not.toBeNull()
    expect(requestsFor("/api/harness-targets")).toHaveLength(1)
    await act(async () => { places.reply(TARGETS); harnesses.reply(HARNESSES) })
    await settle()
    expect(options()).toEqual(["claude", "codex", "cursor"])
  })

  it("opens typed @ immediately on a cold cache, without treating unknown targets as available", async () => {
    const places = slowResponse()
    vi.stubGlobal("fetch", (url: string) => url.startsWith("/api/run-targets") ? places.promise : new Promise(() => {}))
    mount(true)
    await type("run @")
    expect(menu()).not.toBeNull()
    expect(menu()?.textContent).toContain("Checking availability")
    expect(options()).toEqual([])
    expect(textarea().hasAttribute("aria-activedescendant")).toBe(false)
    expect(key("Enter").defaultPrevented).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => places.reply(TARGETS))
    await settle()
    expect(options()).toContain("studio-mac")
  })

  it.each(["runsOn", "agent"])("shows prefetched %s options immediately during a slow stale refresh, with focus inside the sheet", async (kind) => {
    mount(true)
    await settle()
    ageLists()
    const refresh = slowResponse()
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url)
      return url.startsWith("/api/run-targets") || url.startsWith("/api/harness-targets") ? refresh.promise : new Promise(() => {})
    })
    await press(kind === "runsOn" ? whereButton() : harnessButton())
    const original = kind === "runsOn" ? TARGETS : HARNESSES
    expect(options()).toEqual(original.filter((t) => !t.under).map((t) => t.token))
    expect(menu()?.textContent).not.toContain("Checking availability")
    expect(document.activeElement?.getAttribute("role")).toBe("combobox")
    expect(active()).toBe(kind === "runsOn" ? "local" : "claude")
    const gone = kind === "runsOn" ? "box" : "codex"
    const changed = original.map((t) => t.token === gone ? { ...t, disabled: "No longer available" } : t)
    await act(async () => refresh.reply(changed))
    await settle()
    expect(option(gone).getAttribute("aria-disabled")).toBe("true")
    expect(option(gone).title).toContain("No longer available")
    expect(document.activeElement?.getAttribute("role")).toBe("combobox")
    expect(active()).toBe(kind === "runsOn" ? "local" : "claude")
    const path = kind === "runsOn" ? "/api/run-targets" : "/api/harness-targets"
    expect(requestsFor(path)).toHaveLength(2)
    // Close/reopen within freshness window must not probe again.
    key("Escape")
    await press(kind === "runsOn" ? whereButton() : harnessButton())
    expect(menu()).not.toBeNull()
    expect(requestsFor(path)).toHaveLength(2)
  })

  it("revalidates on composer and window focus; unchanged responses don't rerender composers or disturb the draft", async () => {
    mount(true)
    await settle()
    ageLists()
    await type("keep this local draft")
    expect(requestsFor("/api/run-targets")).toHaveLength(2)
    expect(requestsFor("/api/harness-targets")).toHaveLength(2)
    ageLists()
    await settle()
    const places = slowResponse(), harnesses = slowResponse()
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url)
      if (url === "/api/projects") return Promise.resolve(json([PROJECT]))
      return url.startsWith("/api/run-targets") ? places.promise : harnesses.promise
    })
    rendered.mockClear()
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await settle()
    expect(requestsFor("/api/run-targets")).toHaveLength(3)
    expect(requestsFor("/api/harness-targets")).toHaveLength(3)
    expect(rendered).not.toHaveBeenCalled()
    await act(async () => { places.reply(TARGETS); harnesses.reply(HARNESSES) })
    await settle()
    expect(rendered).not.toHaveBeenCalled()
    expect(textarea().value).toBe("keep this local draft")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("keeps previous harness rows visible but unpickable until the new location's checks finish", async () => {
    mount(true)
    await settle()
    const ssh = slowResponse()
    vi.stubGlobal("fetch", (url: string) => url.startsWith("/api/harness-targets?") ? ssh.promise : new Promise(() => {}))
    await press(whereButton())
    await tap(option("studio-mac"))
    await press(harnessButton())
    expect(textarea().value).toBe("@studio-mac !")
    expect(options()).toEqual(["claude", "codex", "cursor"])
    expect(options().every((t) => option(t!).getAttribute("aria-disabled") === "true")).toBe(true)
    await act(async () => ssh.reply(ON_SSH))
    await settle()
    expect(option("claude").getAttribute("aria-disabled")).toBeNull()
    expect(option("codex").getAttribute("aria-disabled")).toBe("true")
  })

  it("keeps a picked harness blocked when the new location's check fails", async () => {
    mount(true)
    await settle()
    await type("keep the picks !codex")
    const ssh = slowResponse()
    vi.stubGlobal("fetch", () => ssh.promise)
    await type("keep the picks !codex @studio-mac")
    expect(document.querySelector('[data-testid="pick-conflict"]')?.textContent).toContain("Checking availability for this location")
    await act(async () => ssh.fail())
    await settle()
    expect(document.querySelector('[data-testid="pick-conflict"]')?.textContent).toContain("Couldn't check availability for this location")
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true)
    key("Enter")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("updates an already picked runner when availability changes, without silently sending to the default", async () => {
    mount(true)
    await settle()
    await type("keep this on the box @box")
    await act(async () => { client.setQueryData(keys.runTargets(null), TARGETS.map((t) => t.token === "box" ? { ...t, disabled: "Box access was removed" } : t)) })
    await settle()
    expect(whereButton().getAttribute("aria-label")).toContain("Box access was removed")
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(true)
    key("Enter")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows failed cold checks honestly and retries on reopening without automatic probe retries", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url)
      return Promise.resolve(new Response("Unavailable", { status: 503 }))
    })
    mount(true)
    await settle()
    await press(whereButton())
    expect(menu()!.textContent).toContain("Couldn't refresh availability")
    expect(options()).toEqual([])
    const attempts = requestsFor("/api/run-targets").length
    await settle()
    expect(requestsFor("/api/run-targets")).toHaveLength(attempts)
    key("Escape")
    act(() => textarea().blur())
    vi.stubGlobal("fetch", (url: string) => { asked.push(url); return Promise.resolve(json(url.startsWith("/api/harness-targets") ? HARNESSES : TARGETS)) })
    await press(whereButton())
    expect(options()).toContain("box")
    expect(requestsFor("/api/run-targets")).toHaveLength(attempts + 1)
  })

  it("prefetches a Captain's scoped lists without reusing the Coordinator's availability", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    expect(requestsFor("/api/run-targets")).toEqual(["/api/run-targets?project=prj_captain"])
    expect(requestsFor("/api/harness-targets")).toEqual(["/api/harness-targets?project=prj_captain"])
    expect(client.getQueryData(keys.runTargets(null))).toBeUndefined()
  })
})

describe("Composer says where new tasks go, without a line over the buttons", () => {
  it("spells out a Captain's Defaults in the buttons' names and the sheet", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: Default (This computer, Mobile's Runs on)")
    expect(harnessButton().getAttribute("aria-label")).toBe("Harness: Default (Codex, Mobile's agent)")
    await type("add a dark mode toggle")
    // No line between the text and the buttons.
    expect(document.querySelector('[data-testid="pick-summary"]')).toBeNull()
    await press(harnessButton())
    expect(menu()?.textContent).toContain("Default: Codex, Mobile's agent")
  })

  it("follows the project's own agent over Settings, and live", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    await act(async () => void client.setQueryData(keys.projects, [{ ...PROJECT, agentCli: "claude", runner: "box" }]))
    await settle()
    expect(whereButton().getAttribute("aria-label")).toBe("Where tasks run: Default (Upstash box, Mobile's Runs on)")
    expect(harnessButton().getAttribute("aria-label")).toBe("Harness: Default (Claude Code, Mobile's agent)")
  })

  it("says when the Default can't run where the tasks go, without blocking the send", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.startsWith("/api/run-targets")) return Promise.resolve(json(TARGETS))
      if (url.startsWith("/api/harness-targets")) return Promise.resolve(json(buildHarnessTargets({ problems: { claude: null, codex: "not signed in", cursor: "not signed in" } })))
      if (url === "/api/projects") return Promise.resolve(json([PROJECT]))
      if (url === "/api/agent-settings") return Promise.resolve(json({ settings: { agentCli: "codex" }, sources: {}, defaults: {} }))
      return new Promise(() => {})
    })
    mount(true, 1, "prj_captain")
    await settle()
    await type("what's open?")
    expect(harnessButton().getAttribute("aria-label")).toBe("Harness: Default (Codex, Mobile's agent: Codex isn't set up where these tasks run)")
    // Drawn as a warning, so it shows without hover.
    expect(harnessButton().querySelector(".lucide-triangle-alert, .lucide-alert-triangle")).not.toBeNull()
    key("Enter")
    expect(onSubmit).toHaveBeenCalledWith("what's open?", [])
  })

  it("doesn't re-render the composer when another of the project's settings changes", async () => {
    mount(true, 1, "prj_captain")
    await settle()
    await type("keep typing")
    rendered.mockClear()
    await act(async () => {
      client.setQueryData(keys.projects, [{ ...PROJECT, description: "Edited elsewhere" }])
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(rendered).not.toHaveBeenCalled()
  })
})
