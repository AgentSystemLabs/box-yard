import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { PR_EVENTS, prTasks } from "../server/prTasks.js"
import { prKey } from "../shared/prTasks.js"
import { tmpDir } from "./helpers.js"

const url = "https://github.com/acme/box-yard/pull/12"

describe("which tasks worked on a pull request", () => {
  let s: Store
  let now = 1_000
  const at = (t: number) => {
    now = t
    vi.setSystemTime(t)
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    at(1_000)
    s = new Store(openDb(tmpDir()))
    s.createProject({ id: "prj_yard01", name: "box-yard", repo: "acme/box-yard" })
    s.createProject({ id: "prj_site01", name: "site", repo: "acme/site" })
  })
  afterEach(() => vi.useRealTimers())

  const task = (id: string, branch: string | null, projectId = "prj_yard01") => s.createTask({ id, projectId, title: id, prompt: "p", branch })
  const reported = (id: string, prUrl: string, branch: string | null) => {
    s.updateTask(id, { prUrl, branch })
    s.addTaskMessage(id, "event", `Opened pull request: ${prUrl}`, { kind: "pr", url: prUrl, branch })
  }
  const ask = (id: string) => prTasks(s, "acme", "box-yard", 12).tasks.find((t) => t.taskId === id)

  it("lists the opener first, then tasks that pushed to it, worked on its branch or were asked to merge it", () => {
    task("task_owner1", "phone-sign-in")
    at(2_000)
    reported("task_owner1", url, "phone-sign-in")
    // A follow-up that checked out the PR's branch and only pushed at turn end.
    at(3_000)
    task("task_fixup1", "fix-flaky-test")
    s.updateTask("task_fixup1", { pushState: { status: "pushed", at: now, branch: "phone-sign-in", head: "abc1234", wip: null, reason: null } })
    // Another task whose create_pull_request landed on the same PR (its own "Opened" from where it stood).
    at(4_000)
    task("task_rebase1", "phone-sign-in-rebase")
    at(5_000)
    reported("task_rebase1", url + "/", "phone-sign-in")
    at(6_000)
    s.addTaskMessage("task_owner1", "event", "Merge requested", { kind: "merge_requested", prNumber: 12, prUrl: url })
    s.recordClaudeUsage({ source: "task", runKind: "turn", taskId: "task_owner1", projectId: "prj_yard01", model: "claude-opus-5-5", startedAt: 5_500, endedAt: 5_900, durationMs: 400 })
    // Not it: another PR, a task on the base branch, the same branch name in another repo.
    task("task_other1", "other")
    reported("task_other1", "https://github.com/acme/box-yard/pull/120", "other")
    task("task_main01", "main")
    task("task_site01", "phone-sign-in", "prj_site01")

    const answer = prTasks(s, "acme", "box-yard", 12)
    expect(answer.url).toBe(url)
    expect(answer.branch).toBe("phone-sign-in")
    expect(answer.tasks).toEqual([
      { taskId: "task_owner1", roles: ["opened", "merge"], model: "claude-opus-5-5", since: 2_000 },
      { taskId: "task_fixup1", roles: ["branch"], model: null, since: 3_000 },
      { taskId: "task_rebase1", roles: ["pushed"], model: null, since: 5_000 },
    ])
  })

  it("still finds a task that moved on to another PR, and the tasks on the old PR's branch", () => {
    task("task_owner1", "first-try")
    reported("task_owner1", url, "first-try")
    at(2_000)
    task("task_help01", "first-try")
    at(3_000)
    reported("task_owner1", "https://github.com/acme/box-yard/pull/13", "second-try")
    expect(prTasks(s, "acme", "box-yard", 12)).toMatchObject({ branch: "first-try", tasks: [{ taskId: "task_owner1", roles: ["opened"] }, { taskId: "task_help01", roles: ["branch"] }] })
    expect(prTasks(s, "acme", "box-yard", 13).tasks.map((t) => t.taskId)).toEqual(["task_owner1"])
  })

  it("counts a task linked without a report from when it started, matching the URL in any case", () => {
    task("task_owner1", "phone-sign-in")
    s.updateTask("task_owner1", { prUrl: "https://github.com/Acme/Box-Yard/pull/12#issuecomment-1", model: "claude-sonnet-5-5" })
    at(2_000)
    task("task_merge01", null)
    s.updateTask("task_merge01", { mergeRequest: { prNumber: 12, prUrl: url, requestedAt: 2_500, deliveredAt: null } })
    expect(ask("task_owner1")).toEqual({ taskId: "task_owner1", roles: ["opened"], model: "claude-sonnet-5-5", since: 1_000 })
    expect(ask("task_merge01")).toEqual({ taskId: "task_merge01", roles: ["merge"], model: null, since: 2_500 })
  })

  it("never matches the base branch, and says nothing when no task touched the PR", () => {
    task("task_owner1", "main")
    reported("task_owner1", url, "main")
    task("task_main01", "main")
    expect(prTasks(s, "acme", "box-yard", 12).tasks.map((t) => t.taskId)).toEqual(["task_owner1"])
    expect(prTasks(s, "acme", "box-yard", 99)).toEqual({ url: "https://github.com/acme/box-yard/pull/99", branch: null, tasks: [] })
  })

  it("finds PR events through the partial index", () => {
    const plan = s.db.prepare(`EXPLAIN QUERY PLAN ${PR_EVENTS}`).all() as { detail: string }[]
    expect(plan.map((p) => p.detail).join("\n")).toContain("task_messages_pr_events")
  })

  it("reads PR URLs the way GitHub links them", () => {
    expect(prKey("https://github.com/A/B/pull/7/files?x=1")).toBe("a/b/7")
    expect(prKey("https://www.github.com/a/b/pull/007")).toBe("a/b/7")
    expect(prKey("https://github.com/a/b/pull/7x")).toBeNull()
    expect(prKey("https://github.com.evil.test/a/b/pull/7")).toBeNull()
    expect(prKey(null)).toBeNull()
  })
})
