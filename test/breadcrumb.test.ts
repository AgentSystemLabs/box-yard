import { describe, expect, it, vi } from "vitest"
import { copyIdOnClick } from "../web/src/lib/breadcrumb"

function click(extra: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true), ...extra }
  return e
}

describe("task id crumb", () => {
  it("copies the id on a plain click and cancels the navigation", async () => {
    const writeText = vi.fn(async () => {})
    const e = click()
    expect(await copyIdOnClick(e, "task_3b4c5d6e7f8a", { writeText })).toBe("copied")
    expect(writeText).toHaveBeenCalledWith("task_3b4c5d6e7f8a")
    expect(e.defaultPrevented).toBe(true)
  })

  it("leaves Cmd/Ctrl, Shift and middle clicks to the link", async () => {
    const writeText = vi.fn(async () => {})
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const e = click(extra)
      expect(await copyIdOnClick(e, "task_x", { writeText })).toBe("skipped")
      expect(e.defaultPrevented).toBe(false)
    }
    expect(writeText).not.toHaveBeenCalled()
  })

  it("reports a blocked clipboard", async () => {
    expect(await copyIdOnClick(click(), "task_x", { writeText: async () => Promise.reject(new Error("denied")) })).toBe("failed")
    expect(await copyIdOnClick(click(), "task_x", undefined)).toBe("failed")
  })
})
