import { describe, expect, it } from "vitest"
import type { CaptainMessage, ChatMessage, TaskMessage } from "../shared/types"
import { dayKey, dayLabel } from "../web/src/lib/calendarDay"
import { chatDays, daySummaries } from "../web/src/lib/chatDays"
import { captainRows } from "../web/src/lib/captainTranscript"
import { coordinatorRows, plainRows, rowMessages } from "../web/src/lib/chatUpdates"
import { groupPublished } from "../web/src/lib/publishedNotices"
import { threadRuns } from "../web/src/lib/taskThread"

const at = (day: number, hour = 12) => +new Date(2026, 10, day, hour)
const notice = (id: string, day: number, content = "✅ **Login** is done: Fixed."): ChatMessage => ({
  id, createdAt: at(day), role: "notice", content, meta: { taskId: "task_login1" },
})

describe("chat calendar days", () => {
  it("uses local calendar dates and labels yesterday across months and years", () => {
    expect(dayKey(at(6))).toBe(dayKey(at(6, 0)))
    expect(dayKey(at(6))).not.toBe(dayKey(at(5, 23)))
    expect(dayLabel(at(6, 0), at(6, 23))).toBe("Today")
    expect(dayLabel(at(5, 23), at(6, 0))).toBe("Yesterday")
    expect(dayLabel(+new Date(2025, 11, 31, 23), +new Date(2026, 0, 1))).toBe("Yesterday")
    expect(dayLabel(at(3), at(6))).toBe(new Date(at(3)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))
    expect(dayLabel(+new Date(2025, 0, 1), at(6))).toContain("2025")
  })

  it("indexes the first message of every day, including days outside the rendered tail", () => {
    const messages = [notice("one", 1), notice("two", 1), notice("three", 5), notice("four", 6)]
    expect(chatDays(messages).map((d) => d.messageId)).toEqual(["one", "three", "four"])
    expect(chatDays([])).toEqual([])
  })

  it("keeps grouped updates and published files within each day", () => {
    const messages = [notice("one", 5), notice("two", 6), notice("three", 6)]
    expect(captainRows(messages as CaptainMessage[]).map((r) => r.type)).toEqual(["notice", "notices"])
    const plain = plainRows(coordinatorRows(messages))
    expect(plain.map((r) => rowMessages(r).map((m) => m.id))).toEqual([["one"], ["two", "three"]])
    const files = messages.map((m) => ({ ...m, content: "📎 **Login** published Shot: /artifacts/art_1234/shot.png" }))
    expect(groupPublished(files).map((r) => r.type === "files" && r.group.messages.length)).toEqual([1, 2])
    expect(captainRows(files as CaptainMessage[]).map((r) => r.id)).toEqual(["one", "two"])
  })

  it("doesn't join task bookkeeping or published files across midnight", () => {
    const messages = [notice("one", 5), notice("two", 6), notice("three", 6)].map((m) => ({
      ...m, taskId: "task_login1", role: "event", content: "Turn 1 finished.", meta: null,
    })) as TaskMessage[]
    expect(threadRuns(messages).map((r) => r.kind)).toEqual(["line", "housekeeping"])
    const files = messages.map((m) => ({ ...m, meta: { kind: "artifact", url: "/artifacts/art_1234/shot.png" } }))
    expect(threadRuns(files).map((r) => r.kind !== "line" && r.messages.length)).toEqual([1, 2])
  })

  it("derives deduplicated stand-up bullets from recorded events without treating a merge request as a merge", () => {
    const tasks = [{ id: "task_login1", projectId: "prj_login1", prUrl: null, title: "Login", createdAt: at(4), prState: "merged" as const, prMergedAt: at(6) }]
    const messages = [
      notice("one", 5, "💬 **Login** finished its turn: Fixed the redirect."),
      notice("two", 5),
      notice("three", 5, "🔀 **Login** opened a pull request: https://github.com/a/b/pull/1"),
      notice("four", 5, "🚢 Owner asked **Login** to merge PR #1 (Merge button): https://github.com/a/b/pull/1"),
      notice("five", 5, "💬 **Login** says: Still working."),
    ]
    const summaries = daySummaries(messages, tasks)
    expect(summaries.get(dayKey(at(4)))).toEqual([{ kind: "started", title: "Login", repo: null, taskId: "task_login1", refs: [] }])
    expect(summaries.get(dayKey(at(5)))).toEqual([{ kind: "finished", title: "Login", repo: null, taskId: "task_login1", refs: [], sourceMessageId: "two" }])
    expect(summaries.get(dayKey(at(6)))).toEqual([{ kind: "pr_merged", title: "Login", repo: null, taskId: "task_login1", refs: [] }])
    expect(daySummaries([messages[0]!], []).get(dayKey(at(5)))).toEqual([{ kind: "worked", title: "Login", repo: null, refs: [], sourceMessageId: "one" }])
    expect(daySummaries([messages[2]!], []).get(dayKey(at(5)))).toEqual([{ kind: "pr_opened", title: "Login", repo: "a/b", refs: ["https://github.com/a/b/pull/1"], sourceMessageId: "three" }])
    expect(daySummaries(messages, [{ ...tasks[0]!, prState: "open" }]).get(dayKey(at(6)))).toBeUndefined()
    expect(daySummaries([], [])).toEqual(new Map())
  })
  it("maps the strongest milestone to a source in the same chat and day, including task-record merges", () => {
    const task = { id: "task_login1", projectId: "prj_login1", prUrl: null, title: "Login", createdAt: at(4), prState: "merged" as const, prMergedAt: at(6) }
    const messages = [
      notice("worked", 6, "💬 **Login** finished its turn: Fixed."),
      notice("finished", 6),
      notice("opened", 6, "🔀 **Login** opened a pull request: https://github.com/a/b/pull/1"),
      notice("other-day", 5),
    ]
    const result = daySummaries(messages, [task])
    expect(result.get(dayKey(at(6)))).toEqual([{ kind: "pr_merged", title: "Login", repo: null, taskId: "task_login1", refs: [], sourceMessageId: "finished" }])
    expect(result.get(dayKey(at(4)))![0]!.sourceMessageId).toBeUndefined()
    expect(result.get(dayKey(at(5)))![0]!.sourceMessageId).toBe("other-day")
    expect(daySummaries([], [task]).get(dayKey(at(6)))![0]!.sourceMessageId).toBeUndefined()
  })

  it("maps task events to their own source ids and never borrows an unrelated task's source", () => {
    const task = { id: "task_login1", projectId: "prj_login1", prUrl: null, title: "Login", createdAt: at(4), prState: "open" as const, prMergedAt: null }
    const event = { ...notice("turn", 6), taskId: task.id, role: "event", content: "Turn 1 finished.", meta: null } as TaskMessage
    const done = { ...event, id: "done", meta: { kind: "auto_done" } }
    const other = { ...event, id: "other", taskId: "task_other" }
    expect(daySummaries([event, done, other], [task]).get(dayKey(at(6)))).toEqual([
      { kind: "finished", title: "Login", repo: null, taskId: "task_login1", refs: [], sourceMessageId: "done" },
    ])
    expect(daySummaries([other], [task]).get(dayKey(at(6)))).toBeUndefined()
  })

})
