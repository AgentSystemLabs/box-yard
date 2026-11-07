// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { keys } from "../web/src/lib/queries.js"
import type { GithubReferenceAnswer } from "../shared/githubReferences.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLElement, client: QueryClient
const submit = vi.fn()
const calls: { url: string; signal?: AbortSignal }[] = []
const projects = [{ id: "prj_site", name: "Site", repo: "acme/site", identityId: "default" }, { id: "prj_other", name: "Other", repo: "acme/other", identityId: "default" }]
const answer: GithubReferenceAnswer = { repo: "acme/site", problem: null, items: [
  { number: 12, title: "Retry webhooks", kind: "issue", state: "open", url: "https://github.com/acme/site/issues/12" },
  { number: 13, title: "Webhook backoff", kind: "pull", state: "merged", url: "https://github.com/acme/site/pull/13" },
] }
const json = (body: unknown) => new Response(JSON.stringify(body))
let respond: (url: string) => Promise<Response>
const wait = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
const textarea = () => host.querySelector("textarea")!
const menu = () => document.querySelector('[data-testid="github-reference-menu"]')
const options = () => Array.from(menu()?.querySelectorAll('[role="option"]') ?? [])

function mount(projectId: string | null = "prj_site", runTargets = false) {
  const panel = createRef<HTMLElement>()
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement("section", { ref: panel }, createElement(Composer, {
    panelRef: panel, placeholder: "Message", onSubmit: submit, githubProject: projectId, runTargets, draftKey: `test:${projectId}`,
  })))))
}
async function type(text: string) {
  await act(async () => {
    textarea().focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text)
    textarea().setSelectionRange(text.length, text.length)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function key(key: string, extra: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })
  act(() => void textarea().dispatchEvent(e))
  return e
}

beforeEach(() => {
  resetDrafts()
  submit.mockClear()
  calls.length = 0
  respond = async () => json(answer)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.projects, projects)
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (url === "/api/projects") return Promise.resolve(json(projects))
    if (url.includes("github-references")) {
      calls.push({ url, signal: init?.signal ?? undefined })
      return respond(url)
    }
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); client.clear() })
  host.remove()
  vi.unstubAllGlobals()
})

describe("Composer GitHub picker", () => {
  it("opens immediately, debounces title words, uses combobox semantics, and inserts with the existing keys", async () => {
    mount()
    await type("See #")
    expect(menu()).not.toBeNull()
    expect(menu()?.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true")
    await type("See #retry")
    await type("See #retry webhooks")
    expect(calls).toHaveLength(0)
    // Enter waits for the picker instead of submitting the unfinished reference.
    key("Enter")
    expect(submit).not.toHaveBeenCalled()
    await wait(280)
    await wait()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain("q=retry%20webhooks")
    expect(options()).toHaveLength(2)
    expect(textarea().getAttribute("aria-controls")).toBe(menu()?.querySelector("ul")?.id)
    key("ArrowUp")
    expect(textarea().getAttribute("aria-activedescendant")).toBe(options()[1]!.id)
    key("Tab")
    expect(textarea().value).toBe("See [PR acme/site#13: Webhook backoff](https://github.com/acme/site/pull/13) ")
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(textarea())
    key("Enter")
    expect(submit).toHaveBeenCalledWith("See [PR acme/site#13: Webhook backoff](https://github.com/acme/site/pull/13)", [])
  })

  it("supports pointer picking, Escape/reopen, and a shared short-lived cache", async () => {
    mount()
    await type("#12")
    await wait(280); await wait()
    key("Escape")
    expect(menu()).toBeNull()
    await type("")
    await type("#12")
    await wait()
    expect(options()).toHaveLength(2)
    expect(calls).toHaveLength(1)
    await act(async () => (options()[0] as HTMLElement).click())
    expect(textarea().value).toContain("[Issue acme/site#12: Retry webhooks](https://github.com/acme/site/issues/12)")
  })

  it("ignores a browser scrollIntoView return value when changing or closing the popup", async () => {
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = () => Promise.resolve()
    try {
      mount()
      await type("#retry")
      await wait(280); await wait()
      key("ArrowDown")
      key("Enter")
      expect(menu()).toBeNull()
      expect(textarea().value).toContain("[PR acme/site#13:")
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("discards stale responses for a changed filter and project, cancelling the old request", async () => {
    const pending = new Map<string, (value: Response) => void>()
    respond = (url) => new Promise((r) => pending.set(url, r))
    mount()
    await type("#old")
    await wait(280)
    const old = calls[0]!
    await type("#new")
    expect(options()).toHaveLength(0)
    await wait(280)
    const recent = calls[1]!
    await act(async () => pending.get(recent.url)!(json({ ...answer, items: [answer.items[1]] })))
    await wait()
    expect(options()[0]?.textContent).toContain("Webhook backoff")
    await act(async () => pending.get(old.url)!(json(answer)))
    await wait()
    expect(options()).toHaveLength(1)
    expect(old.signal?.aborted).toBe(true)
    mount("prj_other")
    await type("#new")
    expect(options()).toHaveLength(0)
    await wait(280)
    expect(calls.at(-1)?.url).toContain("/projects/prj_other/")
    key("Enter")
    expect(submit).not.toHaveBeenCalled()
  })

  it("shows empty, upstream error, no-repository and retry states", async () => {
    mount()
    respond = async () => json({ ...answer, items: [] })
    await type("#none"); await wait(280); await wait()
    expect(menu()?.textContent).toContain("No matching issues or pull requests")
    respond = async () => json({ ...answer, items: [], problem: "GitHub rate limit reached." })
    await type("#error"); await wait(280); await wait()
    expect(menu()?.textContent).toContain("GitHub rate limit reached")
    respond = async () => json(answer)
    await act(async () => (menu()?.querySelector("button") as HTMLElement).click())
    await wait()
    expect(options()).toHaveLength(2)
    respond = async () => { throw new Error("offline") }
    await type("#offline"); await wait(280); await wait()
    expect(menu()?.textContent).toContain("Couldn't load GitHub references")
    expect(menu()?.querySelector("button")?.textContent).toBe("Try again")
    respond = async () => json({ repo: null, items: [], problem: "This project has no GitHub repository." })
    await type("#empty"); await wait(280); await wait()
    expect(menu()?.textContent).toContain("no GitHub repository")
  })

  it("keeps headings and mid-word hashes plain, and leaves IME and Shift+Enter to the textarea", async () => {
    mount()
    for (const text of ["# Heading", "## Heading", "C#", "acme/site#12"]) {
      await type(text)
      expect(menu()).toBeNull()
    }
    await type("#")
    expect(key("Enter", { isComposing: true }).defaultPrevented).toBe(false)
    expect(key("Enter", { shiftKey: true }).defaultPrevented).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  it("uses the Coordinator's % project selection, and explains missing context without querying GitHub", async () => {
    mount(null, true)
    await type("#12")
    expect(menu()?.textContent).toContain("Choose a project with %")
    await wait(280)
    expect(calls).toHaveLength(0)
    await type("%site #12")
    await wait(280); await wait()
    expect(calls.at(-1)?.url).toContain("/projects/prj_site/")
    expect(options()).toHaveLength(2)
  })
})
