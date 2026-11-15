import { afterEach, describe, expect, it } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { testConfig } from "./helpers.js"

// Task.turnModel: the model and effort a task's details show (Store.turnModelOf). The CLI's own word for the model its
// latest turn runs on (the runner's "model" event) wins over what the turn asked for; before the first turn, what that
// will ask for, resolved as the turn will be (the task's pins, else routing, else Settings).

const T = Date.parse("2026-11-15T10:00:00Z")

describe("a task's model in its details", () => {
  const yards: BoxYard[] = []
  afterEach(() => yards.splice(0).forEach((y) => y.stop()))
  const yard = () => {
    const y = createBoxYard(testConfig(), { webDir: "/nonexistent" })
    yards.push(y)
    return y
  }

  it("before its first turn, is what Settings or its project's route will pick, or its own pins", () => {
    const y = yard()
    y.settings.update({ agentModel: "claude-sonnet-5-5", agentEffort: "low", agentRoutingConfig: "projects:\n  routed:\n    model: claude-fable-5-2\n    effort: max\n" })
    const plain = y.store.createProject({ name: "plain" })
    const routed = y.store.createProject({ name: "routed" })
    const fromSettings = y.store.createTask({ projectId: plain.id, title: "A", prompt: "go" })
    const fromRoute = y.store.createTask({ projectId: routed.id, title: "B", prompt: "go" })
    const pinned = y.store.createTask({ projectId: routed.id, title: "C", prompt: "go", model: "opus", effort: "xhigh" })
    expect(y.store.getTask(fromSettings.id)!.turnModel).toEqual({ model: "claude-sonnet-5-5", effort: "low", from: "next", asked: "claude-sonnet-5-5" })
    expect(y.store.getTask(fromRoute.id)!.turnModel).toEqual({ model: "claude-fable-5-2", effort: "max", from: "next", asked: "claude-fable-5-2" })
    expect(y.store.getTask(pinned.id)!.turnModel).toEqual({ model: "opus", effort: "xhigh", from: "next", asked: "opus" })
    // The list reads the same.
    const listed = y.store.listTasks().find((t) => t.id === fromRoute.id)!
    expect(listed.turnModel).toEqual({ model: "claude-fable-5-2", effort: "max", from: "next", asked: "claude-fable-5-2" })
  })

  it("is what its latest turn asked for, then the model the CLI says that turn runs on", async () => {
    const y = yard()
    const project = y.store.createProject({ name: "plain" })
    const task = y.store.createTask({ projectId: project.id, title: "A", prompt: "go" })
    const other = y.store.createTask({ projectId: project.id, title: "B", prompt: "go" })
    y.store.startTaskTurn({ id: "turn_old01", taskId: task.id, turnIndex: 1, model: "claude-haiku-5-5", effort: "low", routingRule: null, routingReason: null })
    await new Promise((r) => setTimeout(r, 5))
    y.store.startTaskTurn({ id: "turn_new01", taskId: task.id, turnIndex: 2, model: "opus", effort: "xhigh", routingRule: null, routingReason: null })
    y.store.updateTask(task.id, { currentTurnId: "turn_new01" })
    expect(y.store.getTask(task.id)!.turnModel).toEqual({ model: "opus", effort: "xhigh", from: "asked", asked: "opus" })

    const sent: string[] = []
    const broadcast = y.hub.broadcast.bind(y.hub)
    y.hub.broadcast = (e) => {
      if (e.type === "task" && e.task.id === task.id) sent.push(e.task.turnModel?.model ?? "")
      broadcast(e)
    }
    await y.tasks.apply(task.id, { seq: 1, ts: T, turnId: "turn_new01", t: "model", model: "claude-opus-5-5" })
    expect(y.store.getTask(task.id)!.turnModel).toEqual({ model: "claude-opus-5-5", effort: "xhigh", from: "ran", asked: "opus" })
    expect(sent).toEqual(["claude-opus-5-5"])
    // Said again: nothing changes, so nothing is sent.
    await y.tasks.apply(task.id, { seq: 2, ts: T, turnId: "turn_new01", t: "model", model: "claude-opus-5-5" })
    expect(sent).toHaveLength(1)

    // Another task's turn, or no model, changes nothing.
    await y.tasks.apply(other.id, { seq: 1, ts: T, turnId: "turn_new01", t: "model", model: "claude-haiku-5-5" })
    await y.tasks.apply(task.id, { seq: 3, ts: T, turnId: "turn_new01", t: "model", model: "  " })
    expect(y.store.getTask(task.id)!.turnModel?.model).toBe("claude-opus-5-5")
    expect(y.store.getTask(other.id)!.turnModel?.from).toBe("next")
    expect(y.store.getTaskTurn("turn_old01")!.ran_model).toBeNull()
  })
})
