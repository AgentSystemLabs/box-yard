// @vitest-environment happy-dom
// The composer's one row of buttons (lib/composerRow.ts): what folds into More at which box width, and the menu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { ComposerMenuItem, useCloseMore } from "../web/src/components/ComposerMenu.js"
import { FOLD_ORDER, foldPlan, type FoldGroup, type RowParts } from "../web/src/lib/composerRow.js"
import { buildHarnessTargets, buildRunTargets } from "../shared/runTargets.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { GitPullRequest } from "lucide-react"
import type { Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Parts = RowParts & { tools: number }
/** Stop is on the row while `fixed` counts it (Mic + Stop + Send). */
const running = (parts: Parts) => parts.fixed >= 3
/** Send's group's gaps: 0.25rem between its buttons, 0.5rem while Stop is there; one before Send for Stop, one for Expand. */
const gapsOf = (parts: Parts, expand: boolean) => (running(parts) ? 0.5 : 0.25) * ((running(parts) ? 1 : 0) + (expand ? 1 : 0))
/** What sits on the row in a box `rem` wide under `plan`: the buttons that never fold, the groups from their width, More. */
function onTheRow(parts: Parts, rem: number) {
  const plan = foldPlan(parts, { stop: running(parts) })
  const groups = FOLD_ORDER.filter((g) => parts[g] > 0 && (plan[g] === null || rem >= plan[g]!))
  const more = plan.more !== null && rem < plan.more
  return { groups, more, slots: parts.fixed + groups.reduce((n, g) => n + parts[g], 0) + (more ? 1 : 0) }
}
/** 2.75rem a button edge to edge, inside the row's 0.25rem padding and 0.25rem between tools and Send's group. */
const need = (slots: number, gaps: number) => 2.75 * slots + 0.75 + gaps
const fits = (slots: number, gaps: number, rem: number) => need(slots, gaps) <= rem
/** The narrowest box for `slots` buttons, rounded up to a quarter rem. */
const rowWidth = (slots: number, gaps: number) => Math.ceil(need(slots, gaps) * 4) / 4

describe("foldPlan", () => {
  // Mic + Send, and Stop while a turn runs; the Coordinator's 3 picks or a Captain's 2; Expand when the text overflows;
  // Pull requests (1.25 with its count) or none; Attach or a text-only box.
  // Send to (a chat that can send elsewhere) or none.
  const combos: Parts[] = []
  for (const fixed of [2, 3, 3.75])
    for (const picks of [0, 2, 3])
      for (const sendTo of [0, 1])
        for (const expand of [0, 1])
          for (const tools of [0, 1, 1.25])
            for (const attach of [0, 1]) combos.push({ fixed, picks, sendTo, expand, tools, attach })

  it("keeps the row to what fits at every width, whenever folding can make it fit", () => {
    for (const parts of combos) {
      const plan = foldPlan(parts, { stop: running(parts) })
      const everything = parts.fixed + FOLD_ORDER.reduce((n, g) => n + parts[g], 0)
      const fewest = plan.more === null ? rowWidth(everything, gapsOf(parts, parts.expand > 0)) : rowWidth(parts.fixed + 1, gapsOf(parts, false))
      for (let rem = 8; rem <= 40; rem += 0.125) {
        const row = onTheRow(parts, rem)
        if (rem >= fewest) expect(fits(row.slots, gapsOf(parts, row.groups.includes("expand")), rem), `${JSON.stringify(parts)} at ${rem}rem: ${row.slots} buttons`).toBe(true)
      }
    }
  })

  it("folds the least used first, shows More exactly while something is folded, and folds nothing it doesn't need to", () => {
    for (const parts of combos) {
      const there = FOLD_ORDER.filter((g) => parts[g] > 0)
      for (let rem = 8; rem <= 40; rem += 0.125) {
        const row = onTheRow(parts, rem)
        const folded = there.filter((g) => !row.groups.includes(g))
        // The folded ones are always the first in the order: picks, then Send to, then Expand, then tools, then Attach.
        expect(there.slice(0, folded.length)).toEqual(folded)
        expect(row.more).toBe(folded.length > 0)
        // Wide enough for one more group (and More, if others stay folded), rounded up to a quarter rem: it's on the row.
        if (folded.length) {
          const next = folded.at(-1)! as FoldGroup
          const withIt = row.slots + parts[next] - (folded.length === 1 ? 1 : 0)
          // A lone first fold (never folded alone) comes back with the next one, so its gap counts too.
          const back = folded.length === 2 && parts[folded[0]] <= 1 ? folded : [next]
          expect(rem < rowWidth(withIt, gapsOf(parts, back.includes("expand") || row.groups.includes("expand"))), `${JSON.stringify(parts)} at ${rem}rem could show ${next}`).toBe(true)
        }
      }
    }
  })

  it("puts Cody's usual buttons on a 320px panel's row (a 17.875rem box), and the rest in More", () => {
    const coordinator = { fixed: 2, picks: 3, sendTo: 0, expand: 0, tools: 1.25, attach: 1 }
    // Attach, More, Mic, Pull requests, Send.
    expect(onTheRow(coordinator, 17.875)).toEqual({ groups: ["tools", "attach"], more: true, slots: 5.25 })
    // While a turn runs, Stop takes Pull requests' place: Attach, More, Mic, Stop, Send.
    expect(onTheRow({ ...coordinator, fixed: 3 }, 17.875)).toEqual({ groups: ["attach"], more: true, slots: 5 })
    // At 125% zoom (a 13.875rem box) with a turn running: More, Mic, Stop, Send.
    expect(onTheRow({ ...coordinator, fixed: 3 }, 13.875)).toEqual({ groups: [], more: true, slots: 4 })
    // A 400px panel (22.875rem) shows everything.
    expect(onTheRow(coordinator, 22.875)).toEqual({ groups: ["picks", "tools", "attach"], more: false, slots: 7.25 })
  })

  it("never folds a lone button: More would only take its place", () => {
    expect(foldPlan({ fixed: 4, picks: 0, sendTo: 0, expand: 0, tools: 0, attach: 1 })).toEqual({ picks: null, sendTo: null, expand: null, tools: null, attach: null, more: null, tool: [null], label: [null] })
    expect(foldPlan({ fixed: 2, picks: 0, sendTo: 0, expand: 1, tools: 0, attach: 1 }).more).not.toBeNull()
  })
})

const TARGETS = buildRunTargets({ problems: { local: null, box: null, docker: null, gpu: null }, machines: [], localLabel: null })
const HARNESSES = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
const PROJECT = { id: "prj_mobile", name: "Mobile", runner: "local", machineLabel: null, agentCli: null, description: "" } as unknown as Project

let root: Root
let host: HTMLElement
const onSubmit = vi.fn()

function mount(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const panel = createRef<HTMLElement>()
  const render = (more: Partial<Parameters<typeof Composer>[0]> = {}) =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            "section",
            { ref: panel },
            createElement(Composer, {
              onSubmit,
              placeholder: "Ask",
              panelRef: panel,
              runTargets: true,
              tools: createElement("button", { type: "button", "data-testid": "tool" }, "PRs"),
              toolsMenu: createElement(ComposerMenuItem, { "data-testid": "tool-line", icon: GitPullRequest, label: "Pull requests" }),
              toolSlots: 1.25,
              ...props,
              ...more,
            }),
          ),
        ),
      ),
    )
  render()
  return render
}

beforeEach(() => {
  resetDrafts()
  onSubmit.mockClear()
  vi.stubGlobal("fetch", (url: string) => {
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }))
    if (url.startsWith("/api/run-targets")) return json(TARGETS)
    if (url.startsWith("/api/harness-targets")) return json(HARNESSES)
    if (url === "/api/projects") return json([PROJECT])
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  })
  host.remove()
  vi.unstubAllGlobals()
})

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const send = () => document.querySelector<HTMLElement>('button[type="submit"]')!
const attach = () => document.querySelector<HTMLElement>('button[title="Attach files"]')!
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
async function press(el: HTMLElement) {
  await act(async () => void el.click())
  await settle()
}

describe("Composer row", () => {
  it("is one line: what doesn't fit hides by the box's width (a container query), and Send never moves", () => {
    mount()
    const row = byTestId("composer-row")!
    expect(row.className).toContain("flex-nowrap")
    expect(row.className).not.toContain("flex-wrap")
    // The part that may scroll if a tool is wider than counted never holds Stop or Send.
    expect(send().closest(".overflow-x-auto")).toBeNull()
    expect(send().className).not.toMatch(/composer:hidden/)
    // The Coordinator with Pull requests: the picks fold below 20.75rem, Pull requests below 15.25, Attach below 11.75.
    expect(byTestId("pick-runsOn")!.parentElement!.className).toContain("@max-[20.75rem]/composer:hidden")
    expect(byTestId("tool")!.parentElement!.className).toContain("@max-[15.25rem]/composer:hidden")
    expect(attach().className).toContain("@max-[11.75rem]/composer:hidden")
    expect(byTestId("composer-more")!.className).toContain("@min-[20.75rem]/composer:hidden")
    // The mic (hold to talk) never folds.
    expect(byTestId("mic")?.className ?? "").not.toMatch(/composer:hidden/)
  })

  it("folds sooner while a turn runs, since Stop takes a place", () => {
    const render = mount()
    render({ stop: { label: "Stop the Coordinator", onStop: () => {} } })
    expect(byTestId("composer-more")!.className).toContain("@min-[24rem]/composer:hidden")
    expect(byTestId("tool")!.parentElement!.className).toContain("@max-[18.5rem]/composer:hidden")
    expect(attach().className).toContain("@max-[15rem]/composer:hidden")
  })

  it("has no More when nothing can fold: tools without a menu form stay on the row", () => {
    mount({ runTargets: false, toolsMenu: undefined, toolSlots: undefined })
    expect(byTestId("composer-more")).toBeNull()
    expect(attach().className).not.toMatch(/composer:hidden/)
    expect(byTestId("tool")!.parentElement!.className).not.toMatch(/composer:hidden/)
  })

  it("More lists each folded button once, by the same widths, and a line does what its button does", async () => {
    mount()
    await settle()
    const more = byTestId("composer-more")!
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    more.dispatchEvent(down)
    // The caret stays in the text, where a picked @ ! % goes.
    expect(down.defaultPrevented).toBe(true)
    await press(more)
    const menu = byTestId("composer-more-menu")!
    expect(more.getAttribute("aria-expanded")).toBe("true")
    expect(more.getAttribute("aria-controls")).toBe(menu.id)
    expect(byTestId("more-attach")!.className).toContain("@min-[11.75rem]/composer:hidden")
    for (const kind of ["project", "runsOn", "agent"]) expect(byTestId(`more-pick-${kind}`)!.className).toContain("@min-[20.75rem]/composer:hidden")
    expect(byTestId("tool-line")!.parentElement!.className).toContain("@min-[15.25rem]/composer:hidden")
    // A line names what it types, so the menu teaches the shortcut.
    expect(byTestId("more-pick-project")!.textContent).toContain("%")
    // It sits in a box-wide `composer` container, so its queries read the box's width.
    expect(menu.parentElement!.className).toContain("@container/composer")
    await press(byTestId("more-pick-project")!)
    expect(byTestId("composer-more-menu")).toBeNull()
    expect(document.querySelector("textarea")!.value).toBe("%")
    expect(byTestId("run-target-menu")?.dataset.kind).toBe("project")
  })

  it("opened from the keyboard, the first line takes the focus; opened by a press, the caret stays in the text", async () => {
    mount()
    await settle()
    const more = byTestId("composer-more")!
    // detail 0: Enter or Space on the button (or assistive tech), not a pointer.
    await act(async () => void more.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })))
    await settle()
    expect(document.activeElement).toBe(byTestId("more-attach"))
    await act(async () => void more.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })))
    expect(byTestId("composer-more-menu")).toBeNull()
    const text = document.querySelector("textarea")!
    act(() => text.focus())
    await act(async () => void more.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })))
    await settle()
    expect(byTestId("composer-more-menu")).not.toBeNull()
    expect(document.activeElement).toBe(text)
  })

  it("a tools line closes the menu with useCloseMore once it has done its job", async () => {
    function Line() {
      const close = useCloseMore()
      return createElement(ComposerMenuItem, { "data-testid": "tool-line", icon: GitPullRequest, label: "Toggle", onClick: close })
    }
    mount({ toolsMenu: createElement(Line) })
    await settle()
    await press(byTestId("composer-more")!)
    await press(byTestId("tool-line")!)
    expect(byTestId("composer-more-menu")).toBeNull()
  })

  it("Esc from the menu closes it and puts the focus back on More; a press elsewhere closes it too", async () => {
    mount()
    await settle()
    const more = byTestId("composer-more")!
    await press(more)
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    act(() => void byTestId("more-attach")!.dispatchEvent(esc))
    expect(esc.defaultPrevented).toBe(true)
    expect(byTestId("composer-more-menu")).toBeNull()
    expect(document.activeElement).toBe(more)
    await press(more)
    expect(byTestId("composer-more-menu")).not.toBeNull()
    act(() => void document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    expect(byTestId("composer-more-menu")).toBeNull()
  })

  it("Esc in the text closes the menu first, and a send closes it", async () => {
    mount()
    await settle()
    const box = document.querySelector("textarea")!
    await press(byTestId("composer-more")!)
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    act(() => void box.dispatchEvent(esc))
    expect(esc.defaultPrevented).toBe(true)
    expect(byTestId("composer-more-menu")).toBeNull()
    await press(byTestId("composer-more")!)
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      set.call(box, "ship it")
      box.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    expect(onSubmit).toHaveBeenCalledWith("ship it", [])
    expect(byTestId("composer-more-menu")).toBeNull()
  })
})

describe("Composer box height", () => {
  it("rests at the same slim line in every chat: no taller box for the target icon", () => {
    mount({ target: createElement("span", { role: "img", "aria-label": "Message target: Coordinator" }) })
    const withTarget = document.querySelector("textarea")!.className
    expect(withTarget).not.toMatch(/\bmin-h-11\b/)
    act(() => root.render(createElement("div")))
    mount({ runTargets: false, toolsMenu: undefined })
    const plain = document.querySelector("textarea")!.className
    // The same metrics, the target's only moving the text over for its icon.
    expect(withTarget.replace(/\s*\bpl-11\b/, "")).toBe(plain)
  })
})
