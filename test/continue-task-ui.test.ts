// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ContinueTask } from "../web/src/components/ContinueTask.js"
import { keys } from "../web/src/lib/queries.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
let qc: QueryClient
const requests: { url: string; body: unknown }[] = []
let rejected = false
const task = { id: "task_example123", agentCli: "claude", status: "failed" } as Task
beforeEach(() => {
  requests.length = 0
  rejected = false
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.tasks, [task])
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(rejected ? { error: "Wait for workspace saving" } : { ...task, agentCli: "codex", status: "queued" }), { status: rejected ? 409 : 200 })
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})
const render = (over: Partial<Task> = {}) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ContinueTask, { task: { ...task, ...over } }))))
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!
const click = (text: string) => act(() => button(text).click())
const choose = (value: string) => act(() => {
  const select = document.querySelector("select")!
  select.value = value
  select.dispatchEvent(new Event("change", { bubbles: true }))
})
const submit = () => act(async () => {
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 30))
})

describe("Continue with a harness", () => {
  it("requires an explicit choice and sends the same id, leaving Retry and saved choices alone", async () => {
    render()
    click("Continue with…")
    expect(document.querySelector("select")?.value).toBe("claude")
    expect(document.body.textContent).toContain("Keep the saved model and effort choices")
    choose("codex")
    expect(document.body.textContent).toContain("Clear this task's model, effort and routing pins")
    expect(requests).toEqual([])
    await submit()
    expect(requests).toEqual([{ url: `/api/tasks/${task.id}/continue`, body: { agent: "codex" } }])
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(qc.getQueryData<Task[]>(keys.tasks)?.[0]).toMatchObject({ id: task.id, agentCli: "codex", status: "queued" })
  })

  it("exposes explicit default resolution with predictable pin reset", async () => {
    render({ status: "idle" })
    click("Continue with…")
    choose("default")
    expect(document.body.textContent).toContain("Changing defaults in Settings only affects new tasks")
    await submit()
    expect(requests[0]?.body).toEqual({ agent: "default" })
  })

  it("keeps the choice open and cache unchanged on a busy conflict", async () => {
    rejected = true
    render()
    click("Continue with…")
    choose("codex")
    await submit()
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
    expect(document.querySelector("select")?.value).toBe("codex")
    expect(qc.getQueryData<Task[]>(keys.tasks)?.[0]).toEqual(task)
  })

  it.each(["working", "starting", "queued", "done"] as const)("is unavailable while %s", (status) => {
    render({ status })
    expect(host.textContent).toBe("")
  })
})
