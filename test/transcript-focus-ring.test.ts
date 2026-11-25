import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// A chat's scroller (StickyScroll's [data-scroller], tabindex=-1 so Jump to end can hand it the keyboard) is the whole
// transcript panel. Chrome matches :focus-visible on it once a key is pressed after a click or a text selection, so a
// ring there drew a gold frame around the whole chat. The global focus rule must skip it, and it must also override
// the browser's own default ring.
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
const source = readFileSync(new URL("../web/src/components/StickyScroll.tsx", import.meta.url), "utf8")

/** [selectors, declarations] of every top-level rule. */
const rules = [...css.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)].map((m) => [m[2]!.split(",").map((s) => s.trim()), m[3]!] as const)

describe("transcript focus ring", () => {
  it("the scroller is still the focusable [data-scroller]", () => {
    expect(source).toMatch(/data-scroller tabIndex=\{-1\}/)
  })

  it("the global focus-visible outline skips the scroller", () => {
    const global = rules.filter(([selectors, body]) => /outline:\s*2px solid var\(--focus-ink\)/.test(body) && selectors.some((s) => s.includes("[tabindex]")))
    expect(global.length).toBeGreaterThan(0)
    for (const [selectors] of global) {
      const withTabindex = selectors.filter((s) => s.includes("[tabindex]"))
      for (const s of withTabindex) expect(s).toContain("[tabindex]:not([data-scroller])")
    }
  })

  it("the scroller draws no outline of its own when focused", () => {
    const own = rules.filter(([selectors]) => selectors.includes("[data-scroller]:focus-visible"))
    expect(own.map(([, body]) => body.replace(/\s+/g, ""))).toContain("outline:none;")
  })
})
