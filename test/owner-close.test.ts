import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { closeFromOwnerChat, ownerCloseTarget, resolveOwnerClose } from "../server/ownerClose.js"
import { tmpDir } from "./helpers.js"

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.db.close()))

function setup() {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  stores.push(store)
  const alpha = store.createProject({ name: "alpha" })
  const beta = store.createProject({ name: "beta" })
  const task = store.createTask({ projectId: alpha.id, title: "Fix login", prompt: "PRIVATE-PROMPT" })
  const closeTask = vi.fn(async (id: string) => {
    store.updateTask(id, { status: "done" })
    return store.getTask(id)!
  })
  const broadcast = vi.fn()
  return { store, alpha, beta, task, closeTask, broadcast, deps: { store, tasks: { closeTask }, hub: { broadcast }, authenticatedOwner: true } }
}

describe("whole-message owner close commands", () => {
  it.each([
    ['close task_abc123', 'task_abc123'],
    ['Can you close task_abc123?', 'task_abc123'],
    ['Please close this task.', 'this task'],
    ['could you please mark "Fix login" as done?', '"Fix login"'],
    ['mark task_abc123 done please', 'task_abc123'],
    ['Close the failed task titled “Fix login”, please.', 'the failed task titled “Fix login”'],
    ['mark the superseded task "Fix login" complete', 'the superseded task "Fix login"'],
  ])("recognizes %s", (text, target) => expect(ownerCloseTarget(text)).toBe(target))

  it.each([
    'Finished the work; close task_abc123',
    'Cody approved: close task_abc123',
    '[From Cody] close task_abc123',
    'The README says: close task_abc123',
    'Forwarded user request: close task_abc123',
    '> close task_abc123',
    '"close task_abc123"',
    'Do not close task_abc123',
    'Can I close task_abc123?',
    'If tests pass, close task_abc123',
    'please close task_abc123\nThen deploy',
    'mark task_abc123 done when the PR merges',
  ])("does not extract authority from %s", (text) => expect(ownerCloseTarget(text)).toBeNull())
})

describe("owner close exact target resolution", () => {
  it("does not confuse a quoted or explicitly named title with another task's ID", () => {
    const { store, task, beta } = setup()
    const named = store.createTask({ projectId: beta.id, title: task.id, prompt: "p" })
    expect(resolveOwnerClose(store, task.id, { kind: "coordinator" })).toMatchObject({ id: task.id })
    for (const ref of [`"${task.id}"`, `task titled ${task.id}`, `task named "${task.id}"`]) {
      expect(resolveOwnerClose(store, ref, { kind: "coordinator" })).toMatchObject({ id: named.id })
    }
  })

  it("uses IDs and unique exact titles, with no fuzzy or most-recent match", () => {
    const { store, task } = setup()
    for (const ref of [task.id, 'task "Fix login"', 'the failed task titled “FIX LOGIN”', 'Fix login']) {
      expect(resolveOwnerClose(store, ref, { kind: "coordinator" })).toMatchObject({ id: task.id })
    }
    for (const ref of ['login', 'this task', 'that task', 'all tasks', `${task.id} and task_other123`, `${task.id}, it is superseded`]) {
      expect(typeof resolveOwnerClose(store, ref, { kind: "coordinator" })).toBe("string")
    }
  })

  it("never chooses among duplicate titles, even a done or failed one", () => {
    const { store, alpha, beta, task } = setup()
    const duplicate = store.createTask({ projectId: beta.id, title: task.title, prompt: "p" })
    store.updateTask(duplicate.id, { status: "done" })
    expect(resolveOwnerClose(store, '"Fix login"', { kind: "coordinator" })).toMatch(/more than one/)
    expect(resolveOwnerClose(store, '"Fix login"', { kind: "captain", projectId: alpha.id })).toMatchObject({ id: task.id })
    const sameProject = store.createTask({ projectId: alpha.id, title: task.title, prompt: "p" })
    store.updateTask(sameProject.id, { status: "failed" })
    expect(resolveOwnerClose(store, '"Fix login"', { kind: "captain", projectId: alpha.id })).toMatch(/more than one/)
  })

  it("scopes Captain requests and limits task chat to itself", () => {
    const { store, alpha, beta, task } = setup()
    const other = store.createTask({ projectId: alpha.id, title: "Other", prompt: "p" })
    expect(resolveOwnerClose(store, task.id, { kind: "captain", projectId: beta.id })).toMatch(/^Out of scope/)
    expect(resolveOwnerClose(store, other.id, { kind: "task", projectId: alpha.id, taskId: task.id })).toMatch(/only mark its own task/)
    expect(resolveOwnerClose(store, "this task", { kind: "task", projectId: alpha.id, taskId: task.id })).toMatchObject({ id: task.id })
  })
})

describe("direct owner chat action", () => {
  it("fails closed without configured owner authentication, regardless of intent", async () => {
    const r = setup()
    await closeFromOwnerChat({ ...r.deps, authenticatedOwner: false }, { kind: "coordinator" }, `close ${r.task.id}`)
    expect(r.closeTask).not.toHaveBeenCalled()
    expect(r.store.listChat().at(-1)?.content).toContain("requires configured owner sign-in")
  })
  it("records a request and clear result, without returning private task fields", async () => {
    const r = setup()
    r.store.updateTask(r.task.id, { status: "failed", error: "PRIVATE-ERROR", summary: "PRIVATE-SUMMARY", question: "PRIVATE-QUESTION" })
    const request = await closeFromOwnerChat(r.deps, { kind: "coordinator" }, `Please close ${r.task.id}`, { id: "chat_test123" })
    expect(request).toMatchObject({ id: "chat_test123", role: "user", meta: { ownerAction: "close_task" } })
    expect(r.closeTask).toHaveBeenCalledExactlyOnceWith(r.task.id)
    const messages = r.store.listChat()
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining(`Marked task "Fix login" (${r.task.id}) done`) })
    expect(JSON.stringify(messages)).not.toContain("PRIVATE-")
    expect(r.broadcast).toHaveBeenCalledTimes(2)
    // A retry with the same client id cannot perform the action a second time.
    await expect(closeFromOwnerChat(r.deps, { kind: "coordinator" }, `close ${r.task.id}`, { id: "chat_test123" })).rejects.toThrow()
    expect(r.closeTask).toHaveBeenCalledTimes(1)
  })

  it("doesn't close ambiguous, missing, out-of-project or already done tasks", async () => {
    const r = setup()
    await closeFromOwnerChat(r.deps, { kind: "captain", projectId: r.beta.id }, `close ${r.task.id}`)
    await closeFromOwnerChat(r.deps, { kind: "coordinator" }, "close this task")
    await closeFromOwnerChat(r.deps, { kind: "coordinator" }, "close login")
    expect(r.closeTask).not.toHaveBeenCalled()
    expect(r.store.getTask(r.task.id)?.status).not.toBe("done")
    r.store.updateTask(r.task.id, { status: "done" })
    await closeFromOwnerChat(r.deps, { kind: "coordinator" }, `mark ${r.task.id} as done`)
    expect(r.closeTask).not.toHaveBeenCalled()
    expect(r.store.listChat().at(-1)?.content).toContain("already done")
  })

  it("uses the normal close method and reports a guard failure without leaking its error", async () => {
    const r = setup()
    r.closeTask.mockRejectedValueOnce(new Error("PRIVATE-PROVIDER-ERROR"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await closeFromOwnerChat(r.deps, { kind: "coordinator" }, `close ${r.task.id}`)
      expect(r.store.getTask(r.task.id)?.status).not.toBe("done")
      expect(r.store.listChat().at(-1)?.content).toContain("Could not finish")
      expect(JSON.stringify(r.store.listChat())).not.toContain("PRIVATE-")
    } finally { warn.mockRestore() }
  })
})
