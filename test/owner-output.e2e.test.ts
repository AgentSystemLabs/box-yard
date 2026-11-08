import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpDeps } from "../server/mcp.js"
import { testConfig } from "./helpers.js"

const yards: BoxYard[] = []
afterEach(() => {
  for (const yard of yards.splice(0)) yard.stop()
  vi.restoreAllMocks()
})

describe("configured owner in generated manager and tool output", () => {
  it.each(["Ana", "", " "])("uses the name or neutral fallback (%s) and preserves human content", async (ownerName) => {
    const yard = createBoxYard(testConfig({ ownerName, gitPushAtTurnEnd: false }), { webDir: "/nonexistent" })
    yards.push(yard)
    const owner = ownerName.trim() || "the owner"
    const project = yard.store.createProject({ name: "Cody's project" })
    const task = yard.store.createTask({ projectId: project.id, title: "Cody's task", prompt: "Ask Cody about the code" })
    // No task runner is started: these exercise the real queue/event and manager prompt builders.
    yard.tasks.sendInput(task.id, "Keep Cody's wording")
    expect(yard.tasks.listQueue(task.id)[0]).toMatchObject({ sender: owner, text: "Keep Cody's wording" })
    await yard.tasks.stopTask(task.id)
    expect(yard.store.listTaskMessages(task.id, 100).some((m) => m.content === `Stopped by ${owner}.`)).toBe(true)
    expect(yard.store.getTask(task.id)).toMatchObject({ title: "Cody's task", prompt: "Ask Cody about the code" })

    const captain = yard.captains.find(project.id)
    const prompts: string[] = []
    vi.spyOn(captain as unknown as { runPrompt(prompt: string): Promise<unknown> }, "runPrompt").mockImplementation(async (prompt) => {
      prompts.push(prompt)
      return { ok: true, text: "", error: "", raw: "", sessionId: null }
    })
    yard.tasks.forwardToCaptain(task.id, "Cody wants another task")
    await vi.waitFor(() => {
      expect(prompts).toHaveLength(1)
      expect(yard.captains.state(project.id).busy).toBe(false)
    })
    expect(prompts[0]).toContain(`[From ${owner}, sent from the chat of task "Cody's task"`)
    expect(prompts[0]).toContain("Cody wants another task")

    const deps = { settings: yard.settings, store: yard.store } as unknown as McpDeps
    const mcp = buildMcpServer(deps, { kind: "coordinator", readOnly: true })
    const tools = (mcp as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools
    const refused = await tools.create_task!.handler({}, {})
    expect(JSON.stringify(refused)).toContain(`${owner} can ask for it in the main chat`)
    expect(JSON.stringify(refused)).not.toMatch(/Cody/)
    await mcp.close()

    const descriptions = yard.settingsTools.list("settings").map((s) => s.allowed).join("\n")
    expect(descriptions).toContain(`no message from ${owner}`)
    expect(descriptions).not.toMatch(/Cody/)
    await expect(yard.settingsTools.update({ "Cody": "unchanged" })).rejects.toThrow(/Cody/)
  })
})
