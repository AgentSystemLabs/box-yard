import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { STOP_GUARD_MS, keepStopped, resetStoppedTasks, staleAfterStop, stopExpired, stopFailed, stopSent, stoppedPatch } from "../web/src/lib/stoppedTasks.js"
import type { Task } from "../shared/types"

const STARTED = 1_000
const task = (patch: Partial<Task> = {}) =>
  ({ id: "task_abc123", projectId: "prj_demo01", title: "Login form", status: "working", turnStartedAt: STARTED, turnCount: 3, prUrl: null, prState: null, updatedAt: 1, ...patch }) as Task

beforeEach(() => {
  resetStoppedTasks()
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())

describe("stoppedPatch: the task as Stop leaves it", () => {
  it("rests a running turn as its end will: PR ready with an open PR, else idle", () => {
    expect(stoppedPatch(task())).toEqual({ status: "idle", turnStartedAt: null })
    expect(stoppedPatch(task({ status: "starting" }))).toEqual({ status: "idle", turnStartedAt: null })
    expect(stoppedPatch(task({ prUrl: "https://github.com/o/r/pull/7" }))).toEqual({ status: "pr_ready", turnStartedAt: null })
    expect(stoppedPatch(task({ prUrl: "https://github.com/o/r/pull/7", prState: "merged" }))).toEqual({ status: "idle", turnStartedAt: null })
  })

  it("settles a queued task as the server does: idle, or failed when it never ran", () => {
    expect(stoppedPatch(task({ status: "queued" }))).toEqual({ status: "idle" })
    expect(stoppedPatch(task({ status: "queued", turnCount: 0 }))).toEqual({ status: "failed" })
    expect(stoppedPatch(task({ status: "idle" }))).toEqual({})
  })
})

describe("staleAfterStop: the server's copies of the stopped turn", () => {
  it("holds back copies of the stopped turn until one says it rested", () => {
    stopSent(task())
    expect(staleAfterStop(task())).toBe(true)
    expect(staleAfterStop(task({ pendingCount: 1 }))).toBe(true)
    expect(staleAfterStop(task({ status: "idle", turnStartedAt: null }))).toBe(false)
  })

  it("keeps holding a late copy of the turn after its end arrived", () => {
    stopSent(task())
    expect(staleAfterStop(task({ status: "pr_ready", turnStartedAt: null }))).toBe(false)
    // The POST's answer, written before the turn ended, can land after the SSE update that ended it.
    expect(staleAfterStop(task())).toBe(true)
  })

  it("lets a new turn through, and nothing is held after it", () => {
    stopSent(task())
    expect(staleAfterStop(task({ status: "starting", turnStartedAt: STARTED + 5_000 }))).toBe(false)
    expect(staleAfterStop(task())).toBe(false)
  })

  it("ends a hold on a turn that hadn't started at its first resting copy", () => {
    stopSent(task({ status: "starting", turnStartedAt: null }))
    expect(staleAfterStop(task({ status: "starting", turnStartedAt: null }))).toBe(true)
    expect(staleAfterStop(task({ status: "idle", turnStartedAt: null }))).toBe(false)
    expect(staleAfterStop(task({ status: "starting", turnStartedAt: null }))).toBe(false)
  })

  it("holds nothing for other tasks, for a task that wasn't running, or after a failed stop", () => {
    stopSent(task())
    expect(staleAfterStop(task({ id: "task_other1" }))).toBe(false)
    stopFailed("task_abc123")
    expect(staleAfterStop(task())).toBe(false)
    stopSent(task({ status: "idle" }))
    expect(staleAfterStop(task())).toBe(false)
  })

  it("gives the server's word back once the hold runs out", () => {
    stopSent(task())
    vi.advanceTimersByTime(STOP_GUARD_MS - 1)
    expect(stopExpired("task_abc123")).toBe(false)
    expect(staleAfterStop(task())).toBe(true)
    vi.advanceTimersByTime(1)
    expect(stopExpired("task_abc123")).toBe(true)
    expect(staleAfterStop(task())).toBe(false)
  })

  it("doesn't call a hold whose turn ended expired", () => {
    stopSent(task())
    staleAfterStop(task({ status: "idle", turnStartedAt: null }))
    vi.advanceTimersByTime(STOP_GUARD_MS)
    expect(stopExpired("task_abc123")).toBe(false)
  })
})

describe("keepStopped: a fetched list", () => {
  it("keeps the cached (stopped) copy where the fetch still has the stopped turn", () => {
    const other = task({ id: "task_other1" })
    stopSent(task())
    const cached = [task({ status: "idle", turnStartedAt: null }), other]
    const fetched = [task(), other]
    const kept = keepStopped(fetched, cached)
    expect(kept[0]).toBe(cached[0])
    expect(kept[1]).toBe(other)
    // Once it rested, the fetched copy is the one.
    const rested = [task({ status: "idle", turnStartedAt: null, summary: "stopped" }), other]
    expect(keepStopped(rested, cached)).toBe(rested)
  })

  it("returns the fetched list itself when nothing is held", () => {
    const fetched = [task()]
    expect(keepStopped(fetched, [task({ status: "idle" })])).toBe(fetched)
  })
})
