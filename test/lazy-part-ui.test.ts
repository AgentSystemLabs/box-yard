// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Suspense, act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { lazyPart, warmLazyParts } from "../web/src/components/LazyPart.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const Loading = ({ name }: { name: string }) => createElement("p", { role: "status" }, `Loading ${name}…`)
const Panel = ({ name }: { name: string }) => createElement("h2", null, `${name} panel`)
const Failed = ({ name }: { name: string }) => createElement("p", { role: "alert" }, `${name} failed`)

/** A chunk that loads when the test says so. */
function chunk() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  let calls = 0
  let promise: Promise<typeof Panel> | undefined
  const load = () => {
    calls++
    return (promise = new Promise<typeof Panel>((res, rej) => {
      resolve = () => res(Panel)
      reject = rej
    }))
  }
  return { load, resolve: () => resolve(), reject: (err: Error) => reject(err), calls: () => calls, settled: () => promise?.catch(() => {}) }
}

describe("lazyPart", () => {
  it("renders a warmed part in the very commit it opens in, with no Loading view in between", async () => {
    const c = chunk()
    const Part = lazyPart(c.load, { Loading })
    warmLazyParts()
    c.resolve()
    await act(async () => await c.settled())
    // A sync act: had the part suspended (React.lazy), this commit would show the fallback, and React holds a
    // fallback up for at least 300 ms.
    act(() => root.render(createElement(Suspense, { fallback: "suspended" }, createElement(Part, { name: "Settings" }))))
    expect(host.textContent).toBe("Settings panel")
    expect(c.calls()).toBe(1)
  })

  it("shows its Loading view until the chunk comes in, then the part, with the same props", async () => {
    const c = chunk()
    const Part = lazyPart(c.load, { Loading })
    act(() => root.render(createElement(Part, { name: "Schedules" })))
    expect(host.textContent).toBe("Loading Schedules…")
    await act(async () => {
      c.resolve()
      await c.settled()
    })
    expect(host.textContent).toBe("Schedules panel")
  })

  it("says it couldn't load instead of throwing when the chunk is gone, and a failed warm-up is retried on open", async () => {
    const c = chunk()
    const Part = lazyPart(c.load, { Loading, Failed })
    warmLazyParts()
    await act(async () => {
      c.reject(new Error("Failed to fetch dynamically imported module"))
      await c.settled()
    })
    act(() => root.render(createElement(Part, { name: "Settings" })))
    expect(host.textContent).toBe("Loading Settings…")
    expect(c.calls()).toBe(2)
    await act(async () => {
      c.reject(new Error("Failed to fetch dynamically imported module"))
      await c.settled()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Settings failed")
  })
})
