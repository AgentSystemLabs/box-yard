// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { keys, useCaptainCompactions, useCaptainMessages, useHarnessTargets, useRunTargets } from "../web/src/lib/queries.js"

let painted: Promise<void>
let paint: () => void
vi.mock("../web/src/lib/afterPaint.js", () => ({ afterPaint: () => painted }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let client: QueryClient
const cases = [
  ["runner availability", () => { useRunTargets(null) }, "/api/run-targets"],
  ["harness availability", () => { useHarnessTargets(null, null) }, "/api/harness-targets"],
  ["Captain compactions", () => { useCaptainCompactions("prj_example") }, "/api/projects/prj_example/captain/compactions"],
  ["cached Captain history", () => { useCaptainMessages("prj_example") }, "/api/projects/prj_example/captain/messages"],
] as const

beforeEach(() => {
  painted = new Promise<void>((resolve) => { paint = resolve })
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { headers: { "Content-Type": "application/json" } })))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(keys.captainMessages("prj_example"), [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount(); client.clear(); paint() })
  host.remove()
  vi.unstubAllGlobals()
})

describe.each(cases)("requests deferred until paint: %s", (_name, useDeferred, url) => {
  function Probe() { useDeferred(); return null }
  const mount = () => act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))))

  it("does not start a request after the last observer unmounts", async () => {
    mount()
    expect(fetch).not.toHaveBeenCalled()
    act(() => root.unmount())
    await act(async () => { paint(); await painted })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("still fetches after paint while its panel or composer is mounted", async () => {
    mount()
    expect(fetch).not.toHaveBeenCalled()
    await act(async () => { paint(); await painted })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(url, expect.any(Object))
  })
})
