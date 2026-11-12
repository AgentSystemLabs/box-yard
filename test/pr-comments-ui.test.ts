// @vitest-environment happy-dom
// New PR comments in the UI: every link to a GitHub pull request reports its click (lib/prViews.ts, through NewTabLink),
// and PrChip shows how many comments were written since (shared/prComments.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Markdown, NewTabLink, PrChip, PrComments } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import { prNewCommentsOf, prTooltip, type PrTask } from "../web/src/lib/prState.js"
import { notePrView } from "../web/src/lib/prViews.js"
import { PR_COMMENT_MINUTES, prCommentMinutesLabel } from "../shared/prComments.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PR = "https://github.com/acme/site/pull/66"
const pr = (over: Partial<PrTask> = {}): PrTask => ({ prUrl: PR, prState: "open", prMergedAt: null, prMergedBy: null, ...over })

let root: Root
let host: HTMLElement
let qc: QueryClient
let posts: { url: string; init: RequestInit }[]

beforeEach(() => {
  posts = []
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    posts.push({ url, init })
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
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

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const fire = (el: Element, type: "click" | "auxclick", init: MouseEventInit = {}) => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  return e
}
const views = () => posts.filter((p) => p.url === "/api/pr-views").map((p) => JSON.parse(String(p.init.body)).url as string)
const badge = () => host.querySelector('[data-testid="pr-new-comments"]')

describe("opening a PR from Box Yard", () => {
  it("reports a GitHub pull request URL, and nothing else", () => {
    notePrView(PR)
    notePrView(`${PR}/files#diff-1`)
    notePrView("https://github.com/acme/site/issues/12")
    notePrView("https://github.com/acme/site")
    notePrView("https://example.com/pull/3")
    notePrView(null)
    expect(views()).toEqual([PR, `${PR}/files#diff-1`, "https://github.com/acme/site/issues/12"])
    // It still goes out when a phone leaves for the GitHub app at once.
    expect(posts[0]!.init).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" })
  })

  it("never keeps a link from opening when the request can't be made", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("offline")
    })
    expect(() => notePrView(PR)).not.toThrow()
  })

  it("a PR chip's click reports the view and still follows the link", () => {
    render(createElement(PrChip, { task: pr(), variant: "number" }))
    const e = fire(host.querySelector("a")!, "click")
    expect(e.defaultPrevented).toBe(false)
    expect(views()).toEqual([PR])
  })

  it("a middle click and Cmd-click open it in a tab too, so they count", () => {
    render(createElement(PrChip, { task: pr() }))
    const a = host.querySelector("a")!
    fire(a, "auxclick", { button: 1 })
    fire(a, "click", { metaKey: true })
    // A right click only opens the menu.
    fire(a, "auxclick", { button: 2 })
    expect(views()).toEqual([PR, PR])
  })

  it("a PR link in a message reports it; a link to another site doesn't", () => {
    render(createElement(Markdown, null, `Opened ${PR} and deployed https://example.com/preview`))
    fire(host.querySelector(`a[href="${PR}"]`)!, "click")
    fire(host.querySelector('a[href="https://example.com/preview"]')!, "click")
    expect(views()).toEqual([PR])
  })

  it("keeps a caller's own handlers", () => {
    const onClick = vi.fn()
    const onAuxClick = vi.fn()
    render(createElement(NewTabLink, { href: PR, onClick, onAuxClick }, "the PR"))
    const a = host.querySelector("a")!
    fire(a, "click")
    fire(a, "auxclick", { button: 1 })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onAuxClick).toHaveBeenCalledTimes(1)
    expect(views()).toEqual([PR, PR])
  })
})

describe("the count on a PR chip", () => {
  it("shows the count on an open or draft PR, and nothing at 0 or before GitHub has said", () => {
    expect(prNewCommentsOf(pr({ prNewComments: 5 }))).toBe(5)
    expect(prNewCommentsOf(pr({ prState: "draft", prNewComments: 2 }))).toBe(2)
    // A PR the server hasn't checked yet reads as open.
    expect(prNewCommentsOf(pr({ prState: null, prNewComments: 1 }))).toBe(1)
    expect(prNewCommentsOf(pr({ prNewComments: 0 }))).toBe(0)
    expect(prNewCommentsOf(pr({ prNewComments: null }))).toBe(0)
    expect(prNewCommentsOf(pr())).toBe(0)
    // A merged or closed PR has nothing left to read here.
    expect(prNewCommentsOf(pr({ prState: "merged", prNewComments: 5 }))).toBe(0)
    expect(prNewCommentsOf(pr({ prState: "closed", prNewComments: 5 }))).toBe(0)
    expect(prNewCommentsOf({ prUrl: null, prState: null, prNewComments: 5 })).toBe(0)
  })

  it("a task row's PR number carries the count in its name and its tooltip", () => {
    render(createElement(PrChip, { task: pr({ prNewComments: 5 }), variant: "number" }))
    const a = host.querySelector("a")!
    expect(badge()!.textContent).toBe("5")
    expect(badge()!.getAttribute("data-count")).toBe("5")
    expect(a.getAttribute("aria-label")).toBe("PR #66, 5 new comments since you last opened this PR, on GitHub (opens in a new tab)")
    expect(a.title).toBe(`Open pull request\n5 new comments since you last opened this PR\nNot counted: the PR author's and the project's GitHub account's own comments, and resolved threads.\n${PR}`)
    // One link: the count is part of the PR's own target, not a second one.
    expect(host.querySelectorAll("a, button")).toHaveLength(1)
  })

  it("the chip without a name of its own says the count in its text", () => {
    render(createElement(PrChip, { task: pr({ prNewComments: 1 }) }))
    expect(host.querySelector("a")!.getAttribute("aria-label")).toBeNull()
    expect(host.querySelector("a")!.textContent).toContain("PR #661, 1 new comment since you last opened this PR")
  })

  it("caps at 99+ and draws nothing without new comments", () => {
    render(createElement(PrComments, { task: pr({ prNewComments: 250 }) }))
    expect(badge()!.querySelector("[aria-hidden]:not(svg)")!.textContent).toBe("99+")
    render(createElement(PrChip, { task: pr({ prNewComments: 0 }), variant: "number" }))
    expect(badge()).toBeNull()
    expect(host.querySelector("a")!.getAttribute("aria-label")).toBe("PR #66 on GitHub (opens in a new tab)")
    render(createElement(PrChip, { task: pr({ prState: "merged", prNewComments: 4 }) }))
    expect(badge()).toBeNull()
    expect(prTooltip(pr({ prState: "merged", prNewComments: 4 }))).toBe(`Merged\n${PR}`)
  })
})

describe("Settings › New PR comments", () => {
  it("words each interval", () => {
    expect(PR_COMMENT_MINUTES.options.map(prCommentMinutesLabel)).toEqual([
      "Off",
      "Every minute",
      "Every 2 minutes",
      "Every 5 minutes (default)",
      "Every 10 minutes",
      "Every 15 minutes",
      "Every 30 minutes",
      "Every hour",
    ])
  })
})
