import { describe, expect, it } from "vitest"
import type { Task } from "../shared/types"
import { comparePullRequests, isPrHistory, taskPullRequests } from "../web/src/lib/taskPullRequests"

const url = "https://github.com/acme/box-yard/pull/12"
function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_pr001", projectId: "prj_yard01", title: "Phone sign-in", prompt: "", status: "pr_ready",
    boxId: null, sessionId: "s", branch: "boxyard/phone", prUrl: url, prState: "open",
    prMergedAt: null, prMergedBy: null, previews: [], question: null, summary: "The phone preview is ready.",
    error: null, waitReason: null, turnCount: 1, pendingCount: 0, lastArchivedAt: null, scheduleId: null,
    outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false,
    model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null,
    mergeRequest: null, createdAt: 1, updatedAt: 1, ...over,
  }
}

describe("task-linked pull requests", () => {
  it("groups canonical GitHub URLs without changing the tasks or their order", () => {
    const tasks = [task(), task({ id: "task_pr002", prUrl: url.toUpperCase() + "/?tab=checks#review", updatedAt: 2 })]
    const groups = taskPullRequests(tasks, null)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.url).toBe(url)
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["task_pr002", "task_pr001"])
    expect(tasks.map((t) => t.id)).toEqual(["task_pr001", "task_pr002"])
  })

  it("scopes before grouping, and excludes absent or non-GitHub PR URLs", () => {
    const tasks = [task(), task({ id: "task_pr002", projectId: "prj_site01", prState: "draft" }), task({ prUrl: null }), task({ prUrl: "https://example.com/pull/12" }), task({ prUrl: "https://github.com.evil.test/acme/box-yard/pull/12" })]
    expect(taskPullRequests(tasks, "prj_yard01")[0]!.tasks).toHaveLength(1)
    expect(taskPullRequests(tasks, "prj_site01")[0]!.state).toBe("draft")
    expect(taskPullRequests(tasks, "prj_missing")).toEqual([])
  })

  it("does not infer open, merged or readiness from unknown or contradictory reports", () => {
    expect(taskPullRequests([task({ prState: null })], null)[0]!.state).toBeNull()
    for (const prState of [null, "draft", "closed", "merged"] as const) {
      const group = taskPullRequests([task(), task({ id: "task_pr002", prState, updatedAt: 2 })], null)[0]!
      expect(group.state).toBeNull()
      expect(isPrHistory(group)).toBe(false)
    }
  })

  it("keeps merged and closed history separate, ordered by the latest linked task activity", () => {
    const groups = taskPullRequests([task({ prState: "merged", updatedAt: 4 }), task({ id: "task_pr002", prUrl: url + "0", prState: "closed", updatedAt: 2 }), task({ id: "task_pr003", prUrl: url + "1", prState: "draft", updatedAt: 3 })], null).sort(comparePullRequests)
    expect(groups.map((pr) => pr.state)).toEqual(["merged", "draft", "closed"])
    expect(groups.filter(isPrHistory).map((pr) => pr.state)).toEqual(["merged", "closed"])
  })
})

