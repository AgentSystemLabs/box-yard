// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { chatProjectFilter, pickProject, readPins, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { TOUCH_MENU_SHARE, captainHref } from "../web/src/components/ChatSwitcher.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { projectColors } from "../shared/projectColors.js"
import type { Project } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: `acme/${name}`, description: "", notes: [], updatedAt: now }) as unknown as Project
// Sidebar order: the list as the server sends it (PUT /api/projects/order), not alphabetical.
const PROJECTS = [project("prj_yard01", "box-yard"), project("prj_castle1", "keep-the-castle"), project("prj_alpha1", "alpha")]
const captain = (projectId: string, busy: boolean) => ({
  projectId,
  busy,
  compacting: false,
  compactQueued: false,
  error: null,
  usage: { tokens: null, window: null, updatedAt: null },
})

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement

function render(path: string = APP_HOME) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.projects, PROJECTS)
  // What the live stream left: keep-the-castle's Captain is working, box-yard's idle, alpha's never seen.
  qc.setQueryData(keys.captain("prj_yard01"), captain("prj_yard01", false))
  qc.setQueryData(keys.captain("prj_castle1"), captain("prj_castle1", true))
  for (const p of PROJECTS) qc.setQueryData(keys.captainMessages(p.id), [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

/** The centre chat: the Coordinator's, or the picked Captain's. */
// The chat on screen: the centre keeps the chats left last beside it, hidden (lib/keptChats.ts).
const centre = () => [...document.querySelectorAll<HTMLElement>("[data-testid=chat-panel], [data-testid=captain-chat][data-centre]")].find((c) => c.checkVisibility())!
const switcher = (within: ParentNode) => within.querySelector<HTMLButtonElement>("[data-testid=chat-switcher]")!
const menu = () => document.querySelector<HTMLElement>("[data-testid=chat-switcher-menu]")
const items = () => [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])]
const labels = () => items().map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const checked = () => items().filter((el) => el.getAttribute("aria-checked") === "true").map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.replace(/(working|idle)$/, "")
const coordinatorBox = () => centre().querySelector<HTMLTextAreaElement>("textarea[placeholder='Ask the Coordinator…']")!
// "Queue another message…" while it works.
const captainBox = (within: ParentNode = document) => within.querySelector<HTMLTextAreaElement>("[data-testid=captain-chat] textarea")
const panelTitle = () => document.querySelector("[data-testid=panel-title]")?.textContent

const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const key = (k: string, target: Element = document.activeElement ?? document.body, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}
const filterBox = () => menu()?.querySelector<HTMLInputElement>("[data-testid=chat-switcher-filter]") ?? null
/** Types into the filter as React hears it. */
const type = (text: string) =>
  act(() => {
    const input = filterBox()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, input.value + text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const highlighted = () => items().filter((el) => el.dataset.active === "true").map((el) => el.textContent!.replace(/(working|idle)$/, ""))
const title = () => centre().querySelector("[data-testid=chat-title]")!.textContent
/** The sidebar's current chat: "Coordinator", or a project's Captain row by the project's name. */
// The sidebar's one selected row: a project's row (its Captain) reads "<name>, Captain", plus ", working" while it runs.
const pressedChip = () => document.querySelector('nav[aria-label="Projects and tasks"] [aria-current="page"]')?.textContent?.replace(/, Captain(, working)?$/, "").replace(/working$/, "")
/** The composer is focused once the frame after the pick is painted. */
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  setChatProjectFilter(null)
  vi.unstubAllGlobals()
})

describe("the chat switcher in the Coordinator's header", () => {
  it("the title opens a menu: the Coordinator (current) first, then every project's Captain in sidebar order", () => {
    render()
    const button = switcher(centre())
    expect(button.textContent).toContain("Coordinator")
    expect(button.getAttribute("aria-haspopup")).toBe("menu")
    expect(menu()).toBeNull()
    click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(menu()!.getAttribute("role")).toBe("menu")
    expect(button.getAttribute("aria-controls")).toBe(menu()!.id)
    expect(labels()).toEqual(["Coordinator", "box-yard", "keep-the-castle", "alpha"])
    expect(checked()).toEqual(["Coordinator"])
    expect(menu()!.querySelector("[role=group]")!.getAttribute("aria-label")).toBe("Captains")
  })

  it("marks each project with its colour, as its sidebar row does", () => {
    render()
    click(switcher(centre()))
    const colors = projectColors(PROJECTS)
    for (const p of PROJECTS) {
      // Its Captain's icon (the cap here), as on its sidebar row.
      const mark = items().find((el) => el.dataset.chat === p.id)!.querySelector<HTMLElement>("[data-captain-icon]")!
      expect(mark.dataset.captainIcon).toBe("captain-cap")
      expect(mark.getAttribute("data-color")).toBe(colors.get(p.id))
      expect(mark.parentElement!.getAttribute("style")).toContain("--pc")
    }
  })

  it("puts a still working dot on the cached Captain icon, with no dot for idle or unknown chats", () => {
    render()
    click(switcher(centre()))
    const item = (label: string) => items().find((el) => el.textContent === label)!
    for (const label of ["Coordinator", "box-yard", "alpha"]) expect(item(label).querySelector("[data-cue]")).toBeNull()
    const mark = item("keep-the-castle").querySelector('[data-testid="agent-status-icon"]')!
    expect(mark.getAttribute("title")).toBe("Working…")
    expect(mark.getAttribute("aria-label")).toBe("Working…")
    expect(mark.querySelector('[data-cue="working"]')).not.toBeNull()
    expect(mark.querySelector("[data-captain-icon]")!.className).toContain("motion-safe:animate-pulse")
    expect(menu()!.querySelector("[data-testid=chat-switcher-busy]")).toBeNull()
    // Nothing fetched to find out a Captain's status.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/captain"))).toEqual([])
  })

  it("arrows move from the current chat, wrapping; Home and End jump; Esc closes back to the title and stays in the app", () => {
    render()
    const button = switcher(centre())
    click(button)
    expect(focused()).toBe("Coordinator")
    expect(key("ArrowDown").defaultPrevented).toBe(true)
    expect(focused()).toBe("box-yard")
    key("ArrowDown")
    expect(focused()).toBe("keep-the-castle")
    key("End")
    expect(focused()).toBe("alpha")
    key("ArrowDown")
    expect(focused()).toBe("Coordinator")
    key("ArrowUp")
    expect(focused()).toBe("alpha")
    key("Home")
    expect(focused()).toBe("Coordinator")
    key("Escape")
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    // Esc was the menu's, so the app stays.
    expect(document.querySelector("[data-app]")).not.toBeNull()
  })

  it("a click outside closes it", () => {
    render()
    click(switcher(centre()))
    act(() => void document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(menu()).toBeNull()
  })

  it("a second click on the title closes it; with a mouse there's no scrim and the menu gets the height below the title", () => {
    render()
    const button = switcher(centre())
    click(button)
    expect(document.querySelector("[data-testid=chat-switcher-scrim]")).toBeNull()
    // happy-dom lays nothing out: the title's bottom is 0, so all but the 14px margin of the 768px window.
    expect(menu()!.style.maxHeight).toBe(`${innerHeight - 14}px`)
    click(button)
    expect(menu()).toBeNull()
    expect(button.getAttribute("aria-expanded")).toBe("false")
  })

  it("Enter on a project pins it to the sidebar and shows it in this chat, its Captain's box focused, without opening the side panel", async () => {
    render()
    click(switcher(centre()))
    key("ArrowDown")
    key("ArrowDown")
    key("Enter")
    expect(menu()).toBeNull()
    expect(location.pathname).toBe(APP_HOME)
    expect(title()).toBe("keep-the-castle Captain")
    expect(pressedChip()).toBe("keep-the-castle")
    expect(readPins()).toEqual({ prj_castle1: "pinned" })
    await frame()
    expect(document.activeElement).toBe(centre().querySelector("textarea"))
    expect(centre().querySelector("textarea")!.placeholder).toBe("Queue another message for the Captain…")
  })

  it("beside a page, a pick stays in the Coordinator too: no navigation to the Captain's tab", () => {
    render("/")
    click(switcher(centre()))
    click(items().find((el) => el.textContent!.startsWith("alpha"))!)
    expect(location.pathname).toBe(APP_HOME)
    expect(title()).toBe("alpha Captain")
    expect(pressedChip()).toBe("alpha")
  })

  it("Enter on the current chat just closes the menu and focuses its composer", async () => {
    render()
    click(switcher(centre()))
    key("Enter")
    expect(menu()).toBeNull()
    await frame()
    expect(document.activeElement).toBe(coordinatorBox())
  })
})

// A tablet's: a phone's header names its chat plainly, and ☰ switches (ChatName).
describe("the chat switcher on a touch screen", () => {
  const scrim = () => document.querySelector<HTMLElement>("[data-testid=chat-switcher-scrim]")
  beforeEach(() => {
    const wide = (q: string) => Number(/min-width: (\d+)px/.exec(q)?.[1] ?? Infinity) <= innerWidth
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: /coarse/.test(q) || wide(q), media: q, addEventListener() {}, removeEventListener() {} }))
  })

  it("takes at most 55% of the window, and a tap opens it on the current chat, not the filter, so no keyboard comes up", () => {
    render()
    click(switcher(centre()))
    expect(menu()!.style.maxHeight).toBe(`${Math.round(innerHeight * TOUCH_MENU_SHARE)}px`)
    expect(TOUCH_MENU_SHARE).toBe(0.55)
    expect(focused()).toBe("Coordinator")
    expect(document.activeElement).not.toBe(filterBox())
  })

  it("dims the rest of the page; a tap on it only closes the menu: nothing under it is hit, and focus goes back to the title", () => {
    render()
    const button = switcher(centre())
    click(button)
    expect(scrim()!.getAttribute("aria-hidden")).toBe("true")
    // The same dim as a dialog's backdrop.
    expect(scrim()!.className).toContain("bg-black/60")
    // The press is the scrim's: the menu stays up for the click, so the tap can't fall through to the page.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    act(() => void scrim()!.dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    const underneath = vi.fn()
    document.addEventListener("click", (e) => e.target !== scrim() && underneath(), { once: true })
    click(scrim()!)
    expect(menu()).toBeNull()
    expect(scrim()).toBeNull()
    expect(underneath).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(title()).toBe("Box Yard Coordinator")
    expect(location.pathname + location.search).toBe(APP_HOME)
  })

  it("Esc closes the menu and its scrim, and only them", () => {
    render()
    const button = switcher(centre())
    click(button)
    expect(key("Escape").defaultPrevented).toBe(true)
    expect(menu()).toBeNull()
    expect(scrim()).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(document.querySelector("[data-app]")).not.toBeNull()
  })

  it("a pick still works through the scrim's menu", () => {
    render()
    click(switcher(centre()))
    click(items().find((el) => el.textContent!.startsWith("alpha"))!)
    expect(menu()).toBeNull()
    expect(scrim()).toBeNull()
    expect(title()).toBe("alpha Captain")
  })
})

describe("Captain selection", () => {
  it("a Captain deep link opens above the shared chat without changing its selection", () => {
    render("/projects/prj_alpha1?tab=captain")
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("alpha Captain")
    expect(captainBox(dialog)).not.toBeNull()
    expect(title()).toBe("Box Yard Coordinator")
    expect(chatProjectFilter()).toBeNull()
    expect(readPins()).toEqual({})
    expect(location.search).toBe("?captain=prj_alpha1")
    expect(key("Escape", document.body).defaultPrevented).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(location.pathname + location.search).toBe(APP_HOME)
    expect(title()).toBe("Box Yard Coordinator")
  })

  it("an explicit Captain pick selects its project in the shared chat", async () => {
    render(captainHref("prj_alpha1"))
    expect(title()).toBe("alpha Captain")
    click(switcher(centre()))
    expect(labels()[0]).toBe("Coordinator")
    expect(checked()).toEqual(["alpha"])
    click(items().find((el) => el.textContent!.startsWith("keep-the-castle"))!)
    expect(title()).toBe("keep-the-castle Captain")
    expect(location.pathname).toBe(APP_HOME)
    await frame()
    expect(document.activeElement).toBe(centre().querySelector("[data-testid=chat-footer] textarea"))
    click(switcher(centre()))
    key("Home")
    key("Enter")
    expect(title()).toBe("Box Yard Coordinator")
  })
})

describe("the project picker hotkey (P)", () => {
  it("names the key in the Coordinator's switcher title, and only there", () => {
    render(captainHref("prj_alpha1"))
    expect(switcher(centre()).title).toBe("Switch to the Coordinator or a project (P)")
    expect(switcher(centre()).getAttribute("aria-keyshortcuts")).toBe("p")
  })

  it("opens the Coordinator's switcher with the filter focused; typing picks the best match, Enter pins and shows it", async () => {
    render()
    expect(key("p", document.body).defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(filterBox())
    // Before typing, the current chat is highlighted.
    expect(highlighted()).toEqual(["Coordinator"])
    type("ktc")
    expect(labels()).toEqual(["keep-the-castle"])
    expect(highlighted()).toEqual(["keep-the-castle"])
    expect(filterBox()!.getAttribute("aria-activedescendant")).toBe(items()[0]!.id)
    key("Enter")
    expect(menu()).toBeNull()
    expect(title()).toBe("keep-the-castle Captain")
    expect(pressedChip()).toBe("keep-the-castle")
    expect(readPins()).toEqual({ prj_castle1: "pinned" })
    await frame()
    expect(document.activeElement).toBe(centre().querySelector("textarea"))
  })

  it("ranks prefix matches first, arrows move the highlight (wrapping), and Esc closes without a pick", () => {
    render()
    key("p", document.body)
    type("a")
    // "alpha" starts with it; the others only contain it.
    expect(labels()[0]).toBe("alpha")
    expect(highlighted()).toEqual(["alpha"])
    expect(key("ArrowDown").defaultPrevented).toBe(true)
    expect(highlighted()).toEqual([labels()[1]])
    key("ArrowUp")
    key("ArrowUp")
    expect(highlighted()).toEqual([labels().at(-1)])
    key("Escape")
    expect(menu()).toBeNull()
    expect(title()).toBe("Box Yard Coordinator")
    expect(readPins()).toEqual({})
    // Esc was the menu's, so the app stays.
    expect(document.querySelector("[data-app]")).not.toBeNull()
  })

  it("'all' finds the Coordinator, which shows the whole chat again", () => {
    render()
    act(() => pickProject("prj_yard01"))
    key("p", document.body)
    type("all")
    expect(highlighted()).toEqual(["Coordinator"])
    key("Enter")
    expect(title()).toBe("Box Yard Coordinator")
    expect(pressedChip()).toBe("Coordinator")
  })

  it("says so when nothing matches, and Enter does nothing (the menu stays, to fix the typing)", () => {
    render()
    key("p", document.body)
    type("zzz")
    expect(items()).toEqual([])
    expect(menu()!.textContent).toContain("No match.")
    key("Enter")
    expect(menu()).not.toBeNull()
    expect(title()).toBe("Box Yard Coordinator")
  })

  it("still opens beside the side panel, which isn't a dialog, but not over a dialog", () => {
    render("/projects/prj_alpha1?tab=captain")
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("alpha Captain")
    expect(key("p", document.body).defaultPrevented).toBe(true)
    expect(menu()).not.toBeNull()
    key("Escape")
    expect(menu()).toBeNull()
    // The panel stays: Esc was the menu's.
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => openPalette())
    expect(key("p", document.body).defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
    key("Escape")
    expect(document.querySelector('[aria-label="Command palette"]')).toBeNull()
  })

  it("doesn't fire while typing in a field, with a modifier, or held down", () => {
    render()
    expect(key("p", coordinatorBox()).defaultPrevented).toBe(false)
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }]) {
      expect(key("p", document.body, init).defaultPrevented).toBe(false)
      expect(menu()).toBeNull()
    }
  })

  it("typing on a menu item (opened by a click) goes to the filter", () => {
    render()
    click(switcher(centre()))
    expect(focused()).toBe("Coordinator")
    key("b")
    expect(document.activeElement).toBe(filterBox())
    expect(filterBox()!.value).toBe("b")
    expect(labels()[0]).toBe("box-yard")
  })
})
