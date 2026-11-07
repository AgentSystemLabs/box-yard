// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { installTheme, parseTheme, resolveTheme, setTheme, THEME_KEY } from "../web/src/lib/theme"

let stop: (() => void) | undefined
let system: MediaQueryList
let dark: boolean
const shown = () => document.documentElement.classList.contains("dark") ? "dark" : "light"

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = '<meta name="theme-color" content="#09090b">'
  dark = false
  system = Object.defineProperty(new EventTarget(), "matches", { get: () => dark }) as MediaQueryList
  vi.spyOn(window, "matchMedia").mockReturnValue(system)
})
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks() })
const changeSystem = (value: boolean) => { dark = value; system.dispatchEvent(new Event("change")) }

// Execute the actual head script without React or CSS: this runs before either loads in the browser.
const firstPaint = () => {
  const html = readFileSync("web/index.html", "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
  new Function(script)()
}

describe("browser theme", () => {
  it.each([null, "garbage", '{"theme":"dark"}', "system"])("treats %s as System", (v) => expect(parseTheme(v)).toBe("system"))
  it.each(["light", "dark", "system"] as const)("resolves %s before the first paint and at runtime", (pref) => {
    localStorage.setItem(THEME_KEY, pref)
    for (const value of [false, true]) {
      dark = value
      firstPaint()
      expect(shown()).toBe(resolveTheme(pref, value))
      expect(document.documentElement.style.colorScheme).toBe(shown())
      expect(document.querySelector("meta")?.content).toBe(shown() === "dark" ? "#09090b" : "#ffffff")
      stop = installTheme()
      expect(shown()).toBe(resolveTheme(pref, value))
      stop()
    }
  })
  it("follows system changes, preserves explicit overrides, and follows again after saving System", () => {
    stop = installTheme()
    expect(shown()).toBe("light")
    changeSystem(true)
    expect(shown()).toBe("dark")
    setTheme("light")
    changeSystem(false); changeSystem(true)
    expect(shown()).toBe("light")
    expect(localStorage.getItem(THEME_KEY)).toBe("light")
    setTheme("dark")
    changeSystem(false)
    expect(shown()).toBe("dark")
    setTheme("system")
    expect(shown()).toBe("light")
    stop(); stop = installTheme()
    changeSystem(true)
    expect(shown()).toBe("dark")
    expect(localStorage.getItem(THEME_KEY)).toBe("system")
  })
  it("reflects another tab's preference, reset or removal", () => {
    stop = installTheme()
    localStorage.setItem(THEME_KEY, "dark")
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY }))
    expect(shown()).toBe("dark")
    localStorage.clear()
    window.dispatchEvent(new StorageEvent("storage", { key: null }))
    expect(shown()).toBe("light")
  })
  it("still works when web storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    firstPaint()
    expect(shown()).toBe("light")
    stop = installTheme()
    expect(() => setTheme("dark")).not.toThrow()
    expect(shown()).toBe("dark")
  })
  it("uses dark when the platform cannot report a system preference", () => {
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true })
    firstPaint()
    expect(shown()).toBe("dark")
    stop = installTheme()
    expect(shown()).toBe("dark")
  })
})
