import { describe, expect, it } from "vitest"
import { SIZE_DEFAULTS } from "../shared/types"
import { sizeCapacities } from "../web/src/lib/capacity"

describe("sizeCapacities", () => {
  it("shows each size's defaults when nothing is overridden", () => {
    const rows = sizeCapacities({ workerSize: "small", slotsPerBox: 1, maxResidentPerBox: 3 }, { slotsPerBox: "default", maxResidentPerBox: "default" })
    expect(rows.map((r) => [r.size, r.slotsPerBox, r.maxResidentPerBox, r.current])).toEqual([
      ["small", 1, 3, true],
      ["medium", 2, 8, false],
      ["large", 4, 18, false],
    ])
    for (const r of rows) expect(r.defaults).toEqual(SIZE_DEFAULTS[r.size])
  })

  it("applies a saved or env override to every size", () => {
    const rows = sizeCapacities({ workerSize: "medium", slotsPerBox: 2, maxResidentPerBox: 12 }, { slotsPerBox: "env", maxResidentPerBox: "ui" })
    expect(rows.map((r) => [r.slotsPerBox, r.maxResidentPerBox])).toEqual([
      [2, 12],
      [2, 12],
      [2, 12],
    ])
    expect(rows.every((r) => r.slotsOverridden && r.residentOverridden)).toBe(true)
    expect(rows.find((r) => r.current)?.size).toBe("medium")
  })

  it("treats an unsaved edit as an override, one field at a time", () => {
    const rows = sizeCapacities({ workerSize: "small", slotsPerBox: 3, maxResidentPerBox: 3 }, { slotsPerBox: "default", maxResidentPerBox: "default" }, { slotsPerBox: true })
    expect(rows.map((r) => [r.slotsPerBox, r.maxResidentPerBox])).toEqual([
      [3, 3],
      [3, 8],
      [3, 18],
    ])
  })
})
