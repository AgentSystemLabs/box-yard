import { afterEach, describe, expect, it } from "vitest"
import { announceCleanup, cleanupToast, withCleanup } from "../web/src/lib/diskCleanup"
import { currentToasts, dismiss } from "../web/src/lib/toast"
import { CLEANUP_STEPS } from "../shared/disk"
import type { BoxCleanup, BoxInfo } from "../shared/types"

const MB = 1024 * 1024
const GB = 1024 * MB

const cleanup = (over: Partial<BoxCleanup> = {}): BoxCleanup => ({
  boxId: "pleasing-shepherd-27426",
  reason: "low-disk",
  status: "done",
  startedAt: 1,
  finishedAt: 2,
  targetFreeBytes: GB,
  freeBefore: 240 * MB,
  freeAfter: 1.5 * GB,
  totalBytes: 5 * GB,
  freedBytes: 1.25 * GB,
  steps: CLEANUP_STEPS.map((s) => ({ key: s.key, label: s.label, freedBytes: 0, removed: [], skipped: null })).map((s) =>
    s.key === "caches" ? { ...s, freedBytes: 800 * MB } : s.key === "builds" ? { ...s, freedBytes: 480 * MB } : s,
  ),
  enough: true,
  error: null,
  ...over,
})

afterEach(() => {
  for (const t of currentToasts()) dismiss(t.id)
})

describe("cleanup toasts", () => {
  it("toasts how much a finished cleanup freed", () => {
    announceCleanup(cleanup())
    const [t] = currentToasts()
    expect(t).toMatchObject({ kind: "info", title: "Cleaned up pleasing-shepherd-27426", body: "Freed 1.3 GB (caches 800 MB, builds 480 MB). 1.5 GB free now." })
  })

  it("warns when the box is still low", () => {
    expect(cleanupToast(cleanup({ enough: false }))).toMatchObject({ kind: "error", body: expect.stringContaining("Still low") })
  })

  it("stays quiet while running", () => {
    announceCleanup(cleanup({ status: "running" }))
    expect(currentToasts()).toHaveLength(0)
  })
})

describe("withCleanup", () => {
  it("replaces one box's cleanup and leaves other lists alone", () => {
    const list = [{ id: "a", cleanup: null }, { id: "pleasing-shepherd-27426", cleanup: null }] as unknown as BoxInfo[]
    const next = withCleanup(list, cleanup())!
    expect(next[1]!.cleanup?.freedBytes).toBe(1.25 * GB)
    expect(next[0]).toBe(list[0])
    expect(withCleanup(list, cleanup({ boxId: "other" }))).toBe(list)
    expect(withCleanup(undefined, cleanup())).toBeUndefined()
  })
})

describe("clear box report", () => {
  const cleared = (over: Partial<BoxCleanup> = {}) =>
    cleanup({
      reason: "clear",
      targetFreeBytes: null,
      steps: [
        { key: "archive", label: "Archive every workspace, then remove it from the box", freedBytes: 1.25 * GB, removed: ["task_a", "task_b"], skipped: null },
        { key: "git", label: "Repo mirrors", freedBytes: 0, removed: [], skipped: null },
      ],
      ...over,
    })

  it("says how many workspaces were archived and what it freed", () => {
    expect(cleanupToast(cleared())).toEqual({ kind: "info", title: "Cleared pleasing-shepherd-27426", body: "Archived and removed 2 workspaces; freed 1.3 GB (archive 1.3 GB). 1.5 GB free now." })
  })

  it("flags workspaces it had to keep", () => {
    const kept = cleared({ steps: [{ key: "archive", label: "x", freedBytes: 0, removed: [], skipped: "kept task_a: couldn't archive it" }] })
    expect(cleanupToast(kept)).toMatchObject({ kind: "error", body: "Archived and removed 0 workspaces; freed 1.3 GB. 1.5 GB free now. Kept task_a: couldn't archive it." })
  })
})
