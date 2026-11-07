import { describe, expect, it } from "vitest"
import { activityLine } from "../shared/activity.js"
import { withActivity } from "../web/src/lib/taskSummary.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"
import type { Task, TaskMessage } from "../shared/types.js"

const PROMPT = `# Task: Task cards: equal heights in grid

Repo: acme/box-yard (cloned in your folder). UI under \`web/src\`. Branch from the latest \`origin/main\`.

Cody's screenshot shows two task cards side by side with different heights. Fix it in the shared card.`

describe("activityLine", () => {
  it("uses the last paragraph of assistant text, flattened", () => {
    expect(activityLine("assistant", "Looked around.\n\nNow **fixing** the [grid](x) in `TaskGrid.tsx`.")).toBe("Now fixing the grid in TaskGrid.tsx.")
    expect(activityLine("assistant", "   ")).toBeNull()
  })
  it("names the tool and its most telling input", () => {
    expect(activityLine("tool", 'Bash {"command":"npm run build","description":"Build the app"}')).toBe("Bash: Build the app")
    expect(activityLine("tool", 'Bash {"command":"npm run\\n build"}')).toBe("Bash: npm run build")
    expect(activityLine("tool", 'Read {"file_path":"/workspace/home/work/web/src/App.tsx"}')).toBe("Read: web/src/App.tsx")
    expect(activityLine("tool", "TodoWrite")).toBe("TodoWrite")
  })
  it("reads clipped JSON inputs", () => {
    expect(activityLine("tool", 'Write {"file_path":"/a/b/c/d.ts","content":"export const x = 1…')).toBe("Write: b/c/d.ts")
  })
  it("ignores tool errors and other roles", () => {
    expect(activityLine("tool", "boom", { error: true })).toBeNull()
    expect(activityLine("user", "hi")).toBeNull()
    expect(activityLine("event", "Asked Cody")).toBeNull()
  })
})

const task = (over: Partial<Task> = {}): Task => ({
  id: "task_a",
  projectId: "p1",
  title: "T",
  prompt: PROMPT,
  status: "working",
  boxId: null,
  sessionId: "s",
  branch: null,
  prUrl: null,
  previews: [],
  question: null,
  summary: null,
  error: null,
  turnCount: 0,
  pendingCount: 0,
  lastArchivedAt: null,
  scheduleId: null,
  contextTokens: null,
  contextWindow: null,
  compactPending: false,
  compacting: false,
  model: null,
  effort: null,
  routingRule: null,
  routingReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const msg = (role: TaskMessage["role"], content: string, taskId = "task_a"): TaskMessage => ({ id: `tm_${content}`, taskId, role, content, meta: null, createdAt: 2 })

describe("withActivity", () => {
  it("moves the activity of a task without a summary and keeps the list otherwise", () => {
    const list = [task(), task({ id: "task_b", summary: "Done" })]
    const next = withActivity(list, msg("tool", 'Bash {"command":"ls"}'))!
    expect(next).not.toBe(list)
    expect(next[0]!.activity).toBe("Bash: ls")
    expect(next[1]).toBe(list[1])
    expect(withActivity(next, msg("tool", 'Bash {"command":"ls"}'))).toBe(next)
    expect(withActivity(list, msg("tool", "x", "task_b"))).toBe(list)
    expect(withActivity(list, msg("user", "hello"))).toBe(list)
    expect(withActivity(undefined, msg("tool", "x"))).toBeUndefined()
  })
})

describe("store activity", () => {
  it("reports the latest useful assistant or tool line until there is a summary", () => {
    const s = new Store(openDb(tmpDir()))
    const p = s.createProject({ name: "site", repo: "a/b" })
    const t = s.createTask({ projectId: p.id, title: "t", prompt: "p" })
    expect(s.getTask(t.id)!.activity).toBeNull()
    s.addTaskMessage(t.id, "assistant", "Reading the grid.")
    s.addTaskMessage(t.id, "tool", 'Edit {"file_path":"/w/web/src/components/TaskCard.tsx"}')
    s.addTaskMessage(t.id, "tool", "oops", { error: true })
    s.addTaskMessage(t.id, "event", "Asked Cody")
    expect(s.getTask(t.id)!.activity).toBe("Edit: src/components/TaskCard.tsx")
    s.updateTask(t.id, { summary: "Done." })
    expect(s.getTask(t.id)!.activity).toBeNull()
  })
})
