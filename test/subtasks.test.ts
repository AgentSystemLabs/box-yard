import { describe, expect, it } from "vitest"
import { MAX_REPORT_CHARS, MAX_SUBTASK_TITLE, parseSpawn, pinsLabel, reportText, spawnProblem, subtaskPins, type SubtaskAsk, type SubtaskPins } from "../server/subtasks.js"
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

  it("reads each sub-task's own agent, model and effort, and leaves out what it doesn't name", () => {
    expect(
      parseSpawn([
        { title: "Sonnet review", prompt: "Review it.", model: " claude-sonnet-5-5 ", effort: "HIGH" },
        { title: "Codex review", prompt: "Review it.", agent: "Codex", model: "gpt-6.1-sol", effort: "ultra" },
        { title: "OpenCode review", prompt: "Review it.", agent: "opencode", model: "acme/model-1#fast" },
        { title: "Plain", prompt: "Review it.", agent: "", model: null, effort: " " },
      ]),
    ).toStrictEqual({
      asks: [
        { id: null, title: "Sonnet review", prompt: "Review it.", runsOn: "same", model: "claude-sonnet-5-5", effort: "high" },
        { id: null, title: "Codex review", prompt: "Review it.", runsOn: "same", agent: "codex", model: "gpt-6.1-sol", effort: "ultra" },
        { id: null, title: "OpenCode review", prompt: "Review it.", runsOn: "same", agent: "opencode", model: "acme/model-1#fast" },
        { id: null, title: "Plain", prompt: "Review it.", runsOn: "same" },
      ],
    })
  })

  it("refuses the whole call for a bad agent, model or effort, naming the item", () => {
    const second = (o: Record<string, unknown>) => parseSpawn([{ title: "A", prompt: "a", model: "opus" }, { title: "B", prompt: "b", ...o }])
    const agent = 'Sub-task 2 ("B"): agent must be one of claude, codex, cursor, opencode, or left out to run on yours.'
    const model = 'Sub-task 2 ("B"): model must be a model id (no spaces, at most 100 characters), or left out to use yours.'
    const effort = 'Sub-task 2 ("B"): effort must be one of low, medium, high, xhigh, max, ultra (ultra on Codex only), or left out to use yours.'
    expect(second({ agent: "gemini" })).toEqual({ problem: agent })
    expect(second({ agent: 1 })).toEqual({ problem: agent })
    expect(second({ model: "claude sonnet" })).toEqual({ problem: model })
    expect(second({ model: "m".repeat(101) })).toEqual({ problem: model })
    expect(second({ model: { id: "opus" } })).toEqual({ problem: model })
    expect(second({ effort: "extreme" })).toEqual({ problem: effort })
    expect(second({ effort: true })).toEqual({ problem: effort })
  })
})

describe("subtaskPins", () => {
  const ask = (o: Partial<SubtaskAsk> = {}): SubtaskAsk => ({ id: null, title: "Review", prompt: "Review it.", runsOn: "same", ...o })
  const claude: SubtaskPins = { agent: "claude", model: "claude-opus-5-5", effort: "max" }
  const refused = (o: Partial<SubtaskAsk>, parent: SubtaskPins = claude, known?: (id: string) => boolean) => {
    const r = subtaskPins([ask({ title: "Fine" }), ask(o)], parent, known)
    return "problem" in r ? r.problem : null
  }

  it("gives a sub-task its parent's pins for what it leaves out, as every sub-task got before", () => {
    expect(subtaskPins([ask()], claude)).toEqual({ pins: [claude] })
    // A parent following the routing chain passes none on, so its sub-task follows it too.
    const routed: SubtaskPins = { agent: "claude", model: null, effort: null }
    expect(subtaskPins([ask()], routed)).toEqual({ pins: [routed] })
    expect(subtaskPins([ask({ model: "claude-sonnet-5-5" }), ask({ effort: "high" }), ask({ agent: "claude", model: "claude-fable-5-2", effort: "high" })], claude)).toEqual({
      pins: [
        { agent: "claude", model: "claude-sonnet-5-5", effort: "max" },
        { agent: "claude", model: "claude-opus-5-5", effort: "high" },
        { agent: "claude", model: "claude-fable-5-2", effort: "high" },
      ],
    })
  })

  it("leaves the parent's model and effort behind on another harness", () => {
    expect(subtaskPins([ask({ agent: "codex" }), ask({ agent: "codex", effort: "ultra" }), ask({ agent: "cursor", model: "composer-2.5" }), ask({ agent: "opencode", model: "acme/model-1" })], claude, () => false)).toEqual({
      pins: [
        { agent: "codex", model: null, effort: null },
        { agent: "codex", model: null, effort: "ultra" },
        { agent: "cursor", model: "composer-2.5", effort: null },
        { agent: "opencode", model: "acme/model-1", effort: null },
      ],
    })
  })

  it("refuses a pin its harness can't take, naming the item and the agent to ask for", () => {
    expect(refused({ model: "gpt-6.1-sol" })).toBe(
      'Sub-task 2 ("Review"): Model gpt-6.1-sol cannot run on Claude Code. Choose a compatible model or use its defaults. It runs on Claude Code like you unless it asks for another agent: pass agent "codex" with that model.',
    )
    expect(refused({ agent: "codex", model: "claude-opus-5-5" })).toBe('Sub-task 2 ("Review"): Model claude-opus-5-5 cannot run on Codex. Choose a compatible model or use its defaults.')
    expect(refused({ effort: "ultra" })).toBe('Sub-task 2 ("Review"): Ultra effort is only available on Codex.')
    expect(refused({ agent: "cursor", effort: "high" })).toBe(`Sub-task 2 ("Review"): Cursor's effort is part of its model id; omit effort.`)
    expect(refused({ agent: "cursor", model: "opus" }, claude, () => false)).toMatch(/^Sub-task 2 \("Review"\): Model opus is not a Cursor model in its catalog\./)
    expect(refused({ agent: "opencode", model: "claude-opus-5-5" })).toMatch(/Model claude-opus-5-5 cannot run on OpenCode\./)
    expect(refused({ agent: "opencode", effort: "high" })).toMatch(/OpenCode uses provider-specific variants: omit effort/)
    // A Cursor parent's sub-task inherits Cursor, so a generic effort or another harness's model is refused.
    const cursor: SubtaskPins = { agent: "cursor", model: "composer-2.5", effort: null }
    expect(refused({ effort: "high" }, cursor)).toMatch(/Cursor's effort is part of its model id/)
    expect(refused({ model: "gpt-6.1-sol" }, cursor, () => false)).toMatch(/not a Cursor model in its catalog\..*It runs on Cursor like you unless it asks for another agent: pass agent "codex" with that model\.$/)
    expect(refused({ model: "claude-opus-5-5-high" }, cursor, (id) => id === "claude-opus-5-5-high")).toBeNull()
  })

  it("doesn't re-check the pins a sub-task inherits", () => {
    // A Cursor parent pinned to an id the server's catalog doesn't list (#41): its sub-tasks still run on that id.
    const cursor: SubtaskPins = { agent: "cursor", model: "claude-example-1-high", effort: null }
    expect(subtaskPins([ask(), ask({ agent: "cursor" })], cursor, () => false)).toEqual({ pins: [cursor, cursor] })
  })

  it("says what a sub-task with pins of its own runs on, with the effort its model takes", () => {
    expect(pinsLabel({ agent: "claude", model: "claude-sonnet-5-5", effort: "high" })).toBe("Claude Code · claude-sonnet-5-5 · high effort")
    expect(pinsLabel({ agent: "codex", model: null, effort: null })).toBe("Codex")
    expect(pinsLabel({ agent: "claude", model: "claude-haiku-4-5", effort: "high" })).toBe("Claude Code · claude-haiku-4-5 · high effort (Haiku 4.5 takes no effort level, so the CLI sends none.)")
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
    expect(top).toContain("Each runs on your agent, model and effort unless it names its own (agent: claude, codex, cursor or opencode;")
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
