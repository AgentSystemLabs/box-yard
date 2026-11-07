// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MoreLogins } from "../web/src/components/MoreLogins.js"
import { keys } from "../web/src/lib/queries.js"
import { SettingsDraftContext, updateParts, type DraftPart } from "../web/src/lib/settingsDraft.js"
import type { AgentLogin } from "../shared/agentLogins"
import type { LimitsReport } from "../shared/loginLimits"

// Settings › Credentials › More logins (docs/logins.md): each login shows its label, last 4 and state, never a value;
// adding, renaming and removing are drafts the dialog's Save writes; Test runs at once.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const login = (over: Partial<AgentLogin>): AgentLogin => ({
  id: "lgn_a",
  harness: "claude",
  label: "Work Max",
  kind: "oauth_token",
  last4: "a1b2",
  fingerprint: "0123456789ab",
  source: "added",
  readable: true,
  state: "ok",
  limitedUntil: null,
  stateReason: null,
  lastUsedAt: null,
  lastCheck: null,
  createdAt: 0,
  ...over,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let parts: Record<string, DraftPart>
let requests: { method: string; url: string; body?: unknown }[]

function render() {
  const registry = { update: (id: string, part: DraftPart | null) => (parts = updateParts(parts, id, part)) }
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(SettingsDraftContext.Provider, { value: registry }, createElement(MoreLogins, { harness: "claude", id: "logins-claude" }))),
    ),
  )
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
/** A request's answer lands over a few timers (fetch, then React Query's notify), more under load: wait for what it shows. */
const until = (check: () => unknown) =>
  act(async () => {
    await vi.waitFor(
      () => {
        if (!check()) throw new Error("not yet")
      },
      { timeout: 3000, interval: 5 },
    )
  })
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label))
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
/** The dialog's Save: every draft part. */
const save = async () => {
  await act(async () => void (await Promise.all(Object.values(parts).map((p) => p.save()))))
  await settle()
}
const writes = () => requests.filter((r) => r.method !== "GET")
/** Up to 2 hours from now but before midnight, so the row says "back Today" whenever the suite runs (late at night too). */
function laterToday() {
  const now = Date.now()
  return now + Math.min(2 * 3_600_000, (new Date(now).setHours(24, 0, 0, 0) - now) / 2)
}

beforeEach(() => {
  parts = {}
  requests = []
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.logins, [
    login({ id: "lgn_cred-claude-xyz", label: "Credentials", source: "credentials", last4: "9f9f", lastUsedAt: Date.now() - 5 * 60_000 }),
    login({ id: "lgn_a" }),
    login({ id: "lgn_b", label: "Old Pro", last4: "c3d4", state: "limited", limitedUntil: laterToday(), stateReason: "Claude AI usage limit reached" }),
    login({ id: "lgn_c", label: "Spent", last4: "e5f6", state: "auth_failed", stateReason: "Invalid API key · Please run /login" }),
    login({ id: "lgn_x", harness: "codex", kind: "chatgpt", label: "ChatGPT", last4: "acct" }),
  ])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
    if (method === "POST" && url === "/api/logins") return json(login({ id: "lgn_new", label: body.label, last4: body.value.slice(-4) }), 201)
    if (method === "POST" && url === "/api/logins/test") return json({ ok: true, text: "Works: Claude answered using this login." })
    if (method === "POST" && url === "/api/logins/lgn_c/test") return json({ ok: true, text: "Works: Claude answered using this login.", login: login({ id: "lgn_c", label: "Spent", last4: "e5f6" }) })
    if (method === "PATCH" && url === "/api/logins/lgn_a") return json(login({ id: "lgn_a", label: body.label }))
    if (method === "DELETE") return json({ ok: true })
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe("More Claude logins", () => {
  it("lists this harness's logins by label and last 4, with why one sits out", () => {
    render()
    const rows = [...host.querySelectorAll("li[data-login]")]
    expect(rows.map((r) => r.getAttribute("data-login"))).toEqual(["lgn_cred-claude-xyz", "lgn_a", "lgn_b", "lgn_c"])
    expect(rows[0]!.textContent).toContain("Credentials…9f9f")
    expect(rows[0]!.textContent).toContain("The login above · last used 5m ago")
    expect(rows[2]!.textContent).toMatch(/At its limit · back Today/)
    expect(rows[3]!.textContent).toContain("Signed out")
    // Settings › Credentials' own login is edited above: no Rename or Remove here.
    expect(rows[0]!.textContent).not.toContain("Remove")
    expect(rows[1]!.textContent).toContain("Remove")
  })

  it("shows an added login's own limits, as its last run read them", () => {
    const now = Date.now()
    const window = { window: "five_hour", label: "5-hour", minutes: 300, usedPct: 64, resetsAt: now + 3_600_000, status: "allowed" as const, asOf: now }
    const limits: LimitsReport = {
      now,
      logins: [
        { loginId: "lgn_cred-claude-1234abcd", harness: "claude", kind: "oauth_token", source: "Settings › Credentials", scope: "settings", fingerprint: null, plan: null, asOf: now, windows: [window] },
        { loginId: "lgn_a", harness: "claude", kind: "oauth_token", source: "Work Max (…a1b2)", scope: "login:lgn_a", fingerprint: null, plan: null, asOf: now, windows: [window] },
      ],
    }
    qc.setQueryData(keys.limits, limits)
    render()
    const lines = [...host.querySelectorAll("li[data-login] [data-testid=limits-line]")]
    // Settings' own login has its line above the list, next to its field.
    expect(lines.map((l) => l.closest("li")!.getAttribute("data-login"))).toEqual(["lgn_a"])
    expect(lines[0]!.textContent).toContain("5-hour")
    expect(lines[0]!.textContent).toContain("64%")
    // The clock is to the minute: a reading from this minute was "just now", not "in <1m".
    expect(lines[0]!.textContent).toContain("as of just now")
  })

  it("adds a pasted login on Save, and only then; the value leaves the page once saved", async () => {
    render()
    await click(button("Add a Claude login"))
    // Open with nothing pasted isn't a change.
    expect(Object.keys(parts)).toEqual([])
    type(host.querySelector<HTMLInputElement>("[data-login-add] input[aria-label='Login name']")!, "Team Max")
    type(host.querySelector<HTMLInputElement>("[data-login-add] input[type=password]")!, "sk-ant-oat01-secret-7777")
    expect(Object.keys(parts)).toEqual(["login-add-claude"])

    // Test checks the typed value without adding it.
    await click([...host.querySelector("[data-login-add]")!.querySelectorAll("button")].find((b) => b.textContent?.includes("Test")))
    expect(writes()).toEqual([{ method: "POST", url: "/api/logins/test", body: { harness: "claude", value: "sk-ant-oat01-secret-7777" } }])
    await until(() => host.querySelector("[data-login-add] [data-login-test=ok]"))

    await save()
    await until(() => host.querySelector("[data-login=lgn_new]"))
    expect(writes().at(-1)).toEqual({ method: "POST", url: "/api/logins", body: { harness: "claude", label: "Team Max", value: "sk-ant-oat01-secret-7777" } })
    expect(host.querySelector("[data-login-add]")).toBeNull()
    expect(host.innerHTML).not.toContain("secret-7777")
    expect(host.querySelector("[data-login=lgn_new]")!.textContent).toContain("Team Max…7777")
  })

  it("renames and removes on Save; Keep it takes a removal back", async () => {
    render()
    const row = () => host.querySelector("[data-login=lgn_a]")!
    await click([...row().querySelectorAll("button")].find((b) => b.textContent?.includes("Rename")))
    type(row().querySelector<HTMLInputElement>("input[aria-label='Login name']")!, "Personal Max")
    await click([...host.querySelector("[data-login=lgn_b]")!.querySelectorAll("button")].find((b) => b.textContent?.includes("Remove")))
    expect(host.querySelector("[data-login=lgn_b]")!.textContent).toContain("Removed when you save.")
    await click([...host.querySelector("[data-login=lgn_c]")!.querySelectorAll("button")].find((b) => b.textContent?.includes("Remove")))
    await click([...host.querySelector("[data-login=lgn_c]")!.querySelectorAll("button")].find((b) => b.textContent?.includes("Keep it")))
    expect(writes()).toEqual([])
    expect(Object.keys(parts).sort()).toEqual(["login-lgn_a", "login-lgn_b"])

    await save()
    expect(writes()).toEqual(
      expect.arrayContaining([
        { method: "PATCH", url: "/api/logins/lgn_a", body: { label: "Personal Max" } },
        { method: "DELETE", url: "/api/logins/lgn_b", body: undefined },
      ]),
    )
    expect(writes()).toHaveLength(2)
    await until(() => !host.querySelector("[data-login=lgn_b]") && host.querySelector("[data-login=lgn_a]")!.textContent!.includes("Personal Max"))
    expect(host.querySelector("[data-login=lgn_a]")!.textContent).toContain("Personal Max")
  })

  it("tests a saved login at once and shows it back in the rotation", async () => {
    render()
    const row = () => host.querySelector("[data-login=lgn_c]")!
    expect(row().textContent).toContain("Signed out")
    await click([...row().querySelectorAll("button")].find((b) => b.textContent?.includes("Test")))
    expect(writes()).toEqual([{ method: "POST", url: "/api/logins/lgn_c/test", body: undefined }])
    await until(() => row().querySelector("[data-login-test=ok]"))
    // The list's copy comes back on React Query's notify, a timer after the result line.
    await until(() => !row().textContent!.includes("Signed out"))
  })
})
