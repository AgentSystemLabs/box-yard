import { describe, expect, it } from "vitest"
import { MAX_REPORT_CHARS, MAX_SUBTASK_TITLE, parseSpawn, reportText, spawnProblem } from "../server/subtasks.js"
import { workerSystemPrompt } from "../server/prompts.js"

describe("parseSpawn", () => {
  it("reads each sub-task, runs_on \"same\" unless it names a runner", () => {
    const parsed = parseSpawn([
      { id: "task_0123456789ab", title: "  Pans   and heat ", prompt: " Compare pans. " },
      { id: "not-an-id", title: "Eggs", prompt: "Which eggs?", runsOn: "Docker" },
      { title: "x".repeat(200), prompt: "Long title" },
    ])
    expect(parsed).toEqual({
      asks: [
        { id: "task_0123456789ab", title: "Pans and heat", prompt: "Compare pans.", runsOn: "same" },
        { id: null, title: "Eggs", prompt: "Which eggs?", runsOn: "docker" },
        { id: null, title: "x".repeat(MAX_SUBTASK_TITLE), prompt: "Long title", runsOn: "same" },
      ],
    })
  })

  it("refuses the whole call for one bad sub-task", () => {
    expect(parseSpawn([])).toEqual({ problem: expect.stringMatching(/at least one/) })
    expect(parseSpawn([{ title: "A", prompt: "a" }, { title: "B" }])).toEqual({ problem: 'Sub-task 2 ("B") has no prompt.' })
    expect(parseSpawn([{ title: "A", prompt: "a", runsOn: "mars" }])).toEqual({ problem: expect.stringMatching(/runs_on must be "same" or one of box, /) })
  })
})

describe("spawnProblem", () => {
  const limits = { maxDepth: 3, maxChildren: 10 }
  it("caps the depth and the sub-tasks per task", () => {
    expect(spawnProblem({ depth: 2, started: 0, asked: 4, limits })).toBeNull()
    expect(spawnProblem({ depth: 3, started: 0, asked: 1, limits })).toMatch(/^Sub-tasks nest at most 3 deep .* at depth 3/)
    expect(spawnProblem({ depth: 0, started: 8, asked: 2, limits })).toBeNull()
    expect(spawnProblem({ depth: 0, started: 8, asked: 3, limits })).toMatch(/has started 8, so at most 2 more\.$/)
    expect(spawnProblem({ depth: 0, started: 10, asked: 1, limits })).toMatch(/so no more\.$/)
  })
})

describe("reportText", () => {
  const base = { id: "task_0123456789ab", title: "Pans", status: "done" as const, text: "Use butter.", live: 0, total: 1 }
  it("says who reports, how, and how many are still out", () => {
    expect(reportText(base)).toBe('Sub-task report from "Pans" (task_0123456789ab), done:\n\nUse butter.\n\nYour sub-task has reported. Write your answer from its report.')
    expect(reportText({ ...base, total: 4 })).toMatch(/All 4 of your sub-tasks have reported\.[^]*$/)
    expect(reportText({ ...base, live: 2, total: 4 })).toMatch(/\n\n2 of your 4 sub-tasks were still running when this report came;/)
    expect(reportText({ ...base, status: "needs_input", question: "Gas or electric?" })).toMatch(/asking for input:[^]*It asks: Gas or electric\?\nAnswer it with message_agent to "task_0123456789ab"/)
    expect(reportText({ ...base, text: "" })).toContain("\n\n(no reply)\n\n")
  })

  it("cuts a long report, pointing at the sub-task's transcript", () => {
    const text = reportText({ ...base, text: "a".repeat(MAX_REPORT_CHARS + 50) })
    expect(text).toContain(`${"a".repeat(MAX_REPORT_CHARS)}… (cut; the whole report is in task_0123456789ab's transcript)`)
  })
})

describe("the worker prompt", () => {
  const prompt = (subtasks: Parameters<typeof workerSystemPrompt>[0]["subtasks"], ownerName = "Cody") =>
    workerSystemPrompt({
      project: { id: "p", name: "kitchen", repo: null, description: "" } as never,
      task: { id: "task_0123456789ab", title: "Pans" } as never,
      branch: null,
      port: 4000,
      ownerName,
      subtasks,
    } as never)

  it("offers spawn_subtasks above the depth cap, and tells a sub-task where its report goes", () => {
    const top = prompt({ depth: 0, maxDepth: 3, maxChildren: 10, parent: null })
    expect(top).toContain("spawn_subtasks")
    expect(top).toContain("Every descendant keeps the original type; the server rejects other environments.")
    expect(top).not.toContain("You are a sub-task of")
    const deepest = prompt({ depth: 3, maxDepth: 3, maxChildren: 10, parent: { id: "task_aaaaaaaaaaaa", title: "Omelette" } })
    expect(deepest).toContain('You are a sub-task of "Omelette" (task id task_aaaaaaaaaaaa), depth 3 of at most 3.')
    expect(deepest).not.toContain("spawn_subtasks")
  })

  it.each(["RunPod", "Vast.ai"].flatMap((provider) => ["Cody", "Ana", ""].map((ownerName) => ({ provider, ownerName }))))("tells $provider agents to explain the unsupported subtask request to '$ownerName'", ({ provider, ownerName }) => {
    const reason = `Subtasks are not supported on ${provider} GPU boxes.`
    const unsupported = prompt({ depth: 0, maxDepth: 3, maxChildren: 10, parent: null, spawnUnsupported: reason }, ownerName)
    expect(unsupported).toContain(reason)
    expect(unsupported).toContain(`explain this limitation to ${ownerName || "the owner"} and do the work yourself`)
    expect(unsupported).not.toContain("spawn_subtasks")
  })
})
