import { describe, expect, it } from "vitest"
import { boxBusyReason, statusCounts } from "../web/src/lib/boxOverview"
import type { BoxCleanup } from "../shared/types"

const MB = 1024 * 1024
const GB = 1024 * MB

const cleanup = (over: Partial<BoxCleanup> = {}): BoxCleanup => ({
  boxId: "b",
  reason: "low-disk",
  status: "done",
  startedAt: 1,
  finishedAt: 2,
  targetFreeBytes: GB,
  freeBefore: 500 * MB,
  freeAfter: 501 * MB,
  totalBytes: 5 * GB,
  freedBytes: MB,
  steps: [],
  enough: false,
  error: null,
  ...over,
})

describe("clear/delete helpers", () => {
  it("groups a box's tasks by status in status order", () => {
    expect(statusCounts([{ status: "done" }, { status: "working" }, { status: "done" }, { status: "idle" }])).toEqual([
      { status: "working", count: 1 },
      { status: "idle", count: 1 },
      { status: "done", count: 2 },
    ])
  })

  it("says why the box's actions are disabled", () => {
    expect(boxBusyReason({ operation: null, cleanup: null })).toBeNull()
    expect(boxBusyReason({ operation: "delete", cleanup: null })).toBe("This box is being deleted")
    expect(boxBusyReason({ operation: null, cleanup: cleanup({ status: "running", reason: "manual" }) })).toBe("A disk cleanup is running on this box")
    expect(boxBusyReason({ operation: null, cleanup: cleanup({ status: "running", reason: "clear" }) })).toBe("This box is being cleared")
  })
})
