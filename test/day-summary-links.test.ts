import { describe, expect, it } from "vitest"
import type { ChatMessage, Task } from "../shared/types"
import { dayKey } from "../web/src/lib/calendarDay"
import { type DaySummary, daySummaries, daySummaryRepo } from "../web/src/lib/chatDays"

const at = +new Date(2026, 10, 6, 12)
const projects = [{ id: "prj_alpha", repo: "git@github.com:team/alpha.git" }, { id: "prj_beta", repo: "team/beta" }]
const task = (over: Partial<Task> = {}) => ({ id: "task_alpha", title: "Fix #12", projectId: "prj_alpha", prUrl: "https://github.com/team/alpha/pull/42", prState: "open", prMergedAt: null, createdAt: at, ...over }) as Task
const notice = (content: string, meta: ChatMessage["meta"] = { taskId: "task_alpha" }): ChatMessage => ({ id: "chat_notice", role: "notice", content, meta, createdAt: at })
const links = (bullet: DaySummary) => bullet.refs

describe("day summary repository resolution", () => {
  it("uses each bullet's task project, including in a multi-project Coordinator day", () => {
    const bullets = daySummaries([], [task(), task({ id: "task_beta", projectId: "prj_beta", title: "Fix #12" })], projects).get(dayKey(at))!
    expect(bullets.map(links)).toEqual([["https://github.com/team/alpha/issues/12"], ["https://github.com/team/beta/issues/12"]])
    expect(daySummaryRepo("prj_beta", task(), undefined, projects)).toBe("team/alpha")
  })

  it("falls back to the owning PR or Captain project, and leaves unknown repos plain", () => {
    expect(daySummaryRepo(undefined, task({ projectId: "deleted" }), undefined, projects)).toBe("team/alpha")
    expect(daySummaryRepo(undefined, undefined, "https://github.com/archive/repo/pull/7", projects)).toBe("archive/repo")
    expect(daySummaryRepo("prj_beta", undefined, undefined, projects)).toBe("team/beta")
    for (const prUrl of [undefined, "https://github.com/a/b/issues/7", "https://github.com.evil/a/b/pull/7"]) {
      expect(daySummaryRepo(undefined, undefined, prUrl, projects)).toBeNull()
    }
    const bullet = daySummaries([notice("✅ **Fix #12** is done: Ready.", null)], [], projects).get(dayKey(at))![0]!
    expect(bullet).toEqual({ kind: "finished", title: "Fix #12", repo: null, refs: [], sourceMessageId: "chat_notice" })
    expect(links(bullet)).toEqual([])
  })

  it("resolves an unambiguous title but never guesses between duplicate task titles", () => {
    const message = notice("✅ **Fix #12** is done: Ready.", null)
    expect(daySummaries([message], [task()], projects).get(dayKey(at))!.at(-1)?.repo).toBe("team/alpha")
    const duplicates = [task(), task({ id: "task_beta", projectId: "prj_beta" })]
    expect(daySummaries([message], duplicates, projects).get(dayKey(at))!.at(-1)?.repo).toBeNull()
    expect(daySummaries([message], [], projects, "prj_beta").get(dayKey(at))![0]?.repo).toBe("team/beta")
    expect(daySummaries([{ ...message, projectId: "prj_beta" }], [task()], projects).get(dayKey(at))!.at(-1)?.repo).toBe("team/beta")
    // A stale explicit task id must not bind to a different task that happens to share its title.
    expect(daySummaries([notice(message.content, { taskId: "deleted" })], [task()], projects).get(dayKey(at))!.at(-1)?.repo).toBeNull()
    const ambiguous = daySummaries([notice("✅ **Fix #12** is done: https://github.com/a/b/pull/1 and https://github.com/c/d/pull/2", null)], [], projects).get(dayKey(at))![0]!
    expect(ambiguous.repo).toBeNull()
    expect(links(ambiguous)).toEqual(["https://github.com/a/b/pull/1", "https://github.com/c/d/pull/2"])
  })

  it("retains PR links on merged milestones and references from recorded notice details", () => {
    const merged = daySummaries([], [task({ prState: "merged", prMergedAt: at })], projects).get(dayKey(at))![0]!
    expect(links(merged)).toEqual(["https://github.com/team/alpha/issues/12", "https://github.com/team/alpha/pull/42"])
    const opened = daySummaries([notice("🔀 **Fix #12** opened a pull request: https://github.com/archive/repo/pull/7", { taskId: "deleted" })], [], projects).get(dayKey(at))![0]!
    expect(opened.repo).toBe("archive/repo")
    expect(links(opened)).toEqual(["https://github.com/archive/repo/issues/12", "https://github.com/archive/repo/pull/7"])
    const finished = daySummaries([notice("✅ **Fix #12** is done: Fixes #12 and other/repo#9; PR #42 (https://github.com/team/alpha/pull/42).")], [task()], projects).get(dayKey(at))![0]!
    expect(links(finished)).toEqual(["https://github.com/team/alpha/issues/12", "https://github.com/other/repo/issues/9", "https://github.com/team/alpha/pull/42"])
  })
})
