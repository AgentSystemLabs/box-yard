// @vitest-environment happy-dom
// The Update banner in the page (web/src/components/UpdateBanner.tsx): Update asks the server to build the newest
// main, the banner follows the launcher's status from the stream, and once Box Yard is back on the new version it
// offers Refresh, while the build-changed toast (lib/appUpdate.ts) stays quiet so the offer isn't made twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { UpdateBanner, UpdateRow } from "../web/src/components/UpdateBanner.js"
import { keys } from "../web/src/lib/queries.js"
import { noteServerBuild, reloadPage, resetAppUpdate } from "../web/src/lib/appUpdate.js"
import { currentToasts as toasts, dismiss } from "../web/src/lib/toast.js"
import { UNMANAGED_UPDATE, type UpdateStatus } from "../shared/selfUpdate"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = "a".repeat(40)
const B = "b".repeat(40)
const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...UNMANAGED_UPDATE, managed: true, current: A, latest: A, checkedAt: Date.now(), repoPage: "https://github.com/acme/yard", ...patch })

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { method: string; path: string }[] = []

const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const banner = () => host.querySelector<HTMLElement>('[data-testid="update-banner"]')
const buttonByText = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)
const click = async (text: string) => {
  const b = buttonByText(text)
  expect(b, text).toBeTruthy()
  act(() => b!.click())
  await flush()
}
/** The stream brings a new status (lib/stream.ts writes it into the query). */
const hear = async (s: UpdateStatus) => {
  act(() => void qc.setQueryData(keys.update, s))
  await flush()
}

function render(component: typeof UpdateBanner | typeof UpdateRow, first: UpdateStatus) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.update, first)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(component))))
}

beforeEach(() => {
  calls = []
  for (const t of toasts()) dismiss(t.id)
  vi.stubGlobal("fetch", (path: string, init?: { method?: string }) => {
    calls.push({ method: init?.method ?? "GET", path })
    return Promise.resolve(new Response(JSON.stringify(status()), { status: 200 }))
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetAppUpdate()
})

describe("UpdateBanner", () => {
  it("shows nothing when Box Yard wasn't started with npx, or is up to date", async () => {
    render(UpdateBanner, UNMANAGED_UPDATE)
    expect(banner()).toBeNull()
    await hear(status())
    expect(banner()).toBeNull()
  })

  it("goes from Update through the build and restart to Refresh", async () => {
    const reload = vi.spyOn(reloadPage, "run").mockImplementation(() => {})
    render(UpdateBanner, status({ latest: B }))
    expect(banner()!.getAttribute("role")).toBe("status")
    expect(banner()!.textContent).toContain("A newer Box Yard is out: aaaaaaa → bbbbbbb.")
    const whatsNew = banner()!.querySelector("a")!
    expect(whatsNew.getAttribute("href")).toBe(`https://github.com/acme/yard/compare/${A}...${B}`)
    expect(whatsNew.getAttribute("target")).toBe("_blank")

    await click("Update")
    expect(calls).toContainEqual({ method: "POST", path: "/api/update/start" })

    await hear(status({ latest: B, phase: "dependencies" }))
    expect(banner()!.textContent).toContain("step 2 of 4: installing its dependencies")
    expect(buttonByText("Update")).toBeUndefined()

    await hear(status({ latest: B, phase: "ready", ready: B, waitingFor: ["the Coordinator"] }))
    expect(banner()!.textContent).toContain("restarts once the Coordinator finishes its reply")
    expect(buttonByText("Restart now")).toBeTruthy()

    await hear(status({ latest: B, phase: "restarting", ready: B }))
    expect(banner()!.textContent).toContain("Restarting Box Yard into bbbbbbb")

    // The server restarted onto a new web build: the banner offers the reload, so no toast does.
    resetAppUpdate("/assets/index-old.js")
    noteServerBuild("/assets/index-new.js")
    expect(toasts().filter((t) => t.title === "Box Yard was updated")).toEqual([])

    await hear(status({ current: B, latest: B, last: { from: A, to: B, ok: true, at: Date.now() } }))
    expect(banner()!.textContent).toContain("Box Yard updated to bbbbbbb. Refresh to load the new version.")
    await click("Refresh")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("Later hides it until main moves again", async () => {
    render(UpdateBanner, status({ latest: B }))
    await click("Later")
    expect(banner()).toBeNull()
    await hear(status({ latest: "c".repeat(40) }))
    expect(banner()!.textContent).toContain("aaaaaaa → ccccccc")
  })

  it("shows a failure's output behind Details, and Try again builds it again", async () => {
    render(UpdateBanner, status({ latest: B, phase: "failed", error: "Installing its dependencies failed:", detail: "npm ERR! network" }))
    expect(banner()!.querySelector("pre")).toBeNull()
    await click("Details")
    expect(banner()!.querySelector("pre")!.textContent).toBe("npm ERR! network")
    expect(buttonByText("Hide details")!.getAttribute("aria-expanded")).toBe("true")
    await click("Try again")
    expect(calls).toContainEqual({ method: "POST", path: "/api/update/start" })
    await click("Dismiss")
    expect(banner()).toBeNull()
  })
})

describe("UpdateRow (Settings › About)", () => {
  it("offers Check now when up to date, and Update when there's a newer one", async () => {
    render(UpdateRow, status())
    expect(host.querySelector('[data-testid="update-summary"]')!.textContent).toMatch(/^Up to date \(checked/)
    await click("Check now")
    expect(calls).toContainEqual({ method: "POST", path: "/api/update/check" })
    await hear(status({ latest: B }))
    expect(host.textContent).toContain("A newer version is out: bbbbbbb.")
    await click("Update")
    expect(calls).toContainEqual({ method: "POST", path: "/api/update/start" })
  })

  it("tells a git checkout how to update", () => {
    render(UpdateRow, UNMANAGED_UPDATE)
    expect(host.textContent).toBe("Started from a git checkout: update it with git pull, then ./yard local.")
    expect(host.querySelector("button")).toBeNull()
  })
})
