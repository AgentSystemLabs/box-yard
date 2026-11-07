// What a question, PR or failure card in the Coordinator's transcript says now (lib/noticeNow.ts): the status word and
// its action while the task still waits on Cody, where the task is once it has moved on, and only each task's newest
// such card asking at all.
import { describe, expect, it } from "vitest"
import { LIVE_LABEL, newestAsks, noticeNow, type NoticeTask } from "../web/src/lib/noticeNow.js"
import { coordinatorRows } from "../web/src/lib/chatUpdates.js"
import type { ChatMessage } from "../shared/types.js"

const task = (over: Partial<NoticeTask> = {}): NoticeTask => ({ status: "working", prUrl: null, prState: null, ...over })
const PR = "https://github.com/o/r/pull/9"

describe("noticeNow", () => {
  it("a newest card whose task still waits leads with its status word", () => {
    expect(noticeNow("needs_input", task({ status: "needs_input" }), true)).toEqual({ live: true, kind: "needs_input", label: "Needs your answer" })
    expect(noticeNow("failed", task({ status: "failed" }), true)).toEqual({ live: true, kind: "failed", label: "Failed" })
    expect(noticeNow("pr", task({ status: "pr_ready", prUrl: PR, prState: "open" }), true)).toEqual({ live: true, kind: "pr", label: "Ready for your review" })
  })

  it("a PR the server hasn't checked yet reads as open, and a draft still waits", () => {
    expect(noticeNow("pr", task({ status: "pr_ready", prUrl: PR }), true)).toMatchObject({ live: true })
    expect(noticeNow("pr", task({ status: "pr_ready", prUrl: PR, prState: "draft" }), true)).toMatchObject({ live: true })
  })

  it("once the task has moved on, it says where the task is now", () => {
    expect(noticeNow("needs_input", task({ status: "working" }), true)).toEqual({ live: false, status: "working" })
    expect(noticeNow("failed", task({ status: "queued" }), true)).toEqual({ live: false, status: "queued" })
    expect(noticeNow("pr", task({ status: "working", prUrl: PR }), true)).toEqual({ live: false, status: "working" })
    expect(noticeNow("pr", task({ status: "done", prUrl: PR, prState: "merged" }), true)).toEqual({ live: false, status: "merged" })
    expect(noticeNow("pr", task({ status: "pr_ready", prUrl: PR, prState: "closed" }), true)).toEqual({ live: false, status: "pr_ready" })
  })

  it("an older card never asks, even while its task waits again", () => {
    expect(noticeNow("needs_input", task({ status: "needs_input" }), false)).toEqual({ live: false, status: "needs_input" })
    expect(noticeNow("failed", task({ status: "failed" }), false)).toEqual({ live: false, status: "failed" })
  })

  it("says nothing for other notices or a task the app doesn't know", () => {
    expect(noticeNow("done", task({ status: "done" }), true)).toBeNull()
    expect(noticeNow("merge", task({ status: "pr_ready", prUrl: PR }), true)).toBeNull()
    expect(noticeNow("needs_input", null, true)).toBeNull()
    expect(noticeNow("pr", undefined, true)).toBeNull()
  })

  it("has a status word for every kind of card that can ask", () => {
    expect(Object.keys(LIVE_LABEL).sort()).toEqual(["failed", "needs_input", "pr"])
  })
})

describe("newestAsks", () => {
  let t = 0
  const msg = (id: string, role: ChatMessage["role"], content: string, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt: ++t })
  const asks = (id: string, taskId: string) => msg(id, "notice", "🙋 **Pick a colour** needs you: Red or blue?", { taskId })
  const failed = (id: string, taskId: string) => msg(id, "notice", "❌ **Build** failed: tsc exited 2", { taskId })
  const pr = (id: string, taskId: string) => msg(id, "notice", `🔀 **Cards** opened a pull request: ${PR}`, { taskId })
  const done = (id: string, taskId: string) => msg(id, "notice", "✅ **Build** is done: ok", { taskId })

  it("maps each task to its newest question, PR or failure", () => {
    const rows = coordinatorRows([
      asks("q1", "task_a"),
      failed("f1", "task_b"),
      msg("u1", "user", "Thanks"),
      pr("p1", "task_a"),
      done("d1", "task_b"),
      asks("q2", "task_c"),
    ])
    expect(Object.fromEntries(newestAsks(rows))).toEqual({ task_a: "p1", task_b: "f1", task_c: "q2" })
  })

  it("skips notices about no task, a Captain's relays and updates", () => {
    const rows = coordinatorRows([
      msg("w1", "notice", "❌ Boxes are busy"),
      msg("c1", "notice", "🙋 **Pick** needs you: which?", { taskId: "task_a", captain: true }),
      done("d1", "task_a"),
    ])
    expect(newestAsks(rows).size).toBe(0)
  })
})
