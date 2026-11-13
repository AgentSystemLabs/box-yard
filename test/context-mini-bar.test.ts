import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ContextMiniBar } from "../web/src/components/ContextMeter.js"

const render = (tokens: number | null, window: number | null) => renderToStaticMarkup(createElement(ContextMiniBar, { tokens, window }))

describe("ContextMiniBar", () => {
  it("shows the percentage, with the full reading as its accessible name and tooltip", () => {
    const html = render(78_000, 1_000_000)
    expect(html).toContain('<span class="sr-only">Context 78k / 1m · 8%</span>')
    // Room for "100%" is reserved, so the chip's width holds as the number grows.
    expect(html).toContain('<span aria-hidden="true" class="min-w-[4ch]">8%</span>')
    expect(html).toContain("title=\"Context 78k / 1m · 8%. How much of this agent&#x27;s context window is used.\"")
  })

  it("stays muted until 75%, then turns amber, and red from 90%", () => {
    expect(render(740_000, 1_000_000)).toContain("text-zinc-500")
    expect(render(750_000, 1_000_000)).toContain("text-amber-300")
    expect(render(900_000, 1_000_000)).toContain("text-red-300")
  })

  it("renders nothing until the context is measured", () => {
    expect(render(null, 1_000_000)).toBe("")
    expect(render(10_000, null)).toBe("")
  })
})
