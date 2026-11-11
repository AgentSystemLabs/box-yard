// A task named in a message as context (lib/taskReference.ts): what the reference says to each reader, and where in
// the draft it goes.
import { describe, expect, it } from "vitest"
import { excerpt, insertReference, needsContext, targetName, taskIdOfRowKey, taskReference, EXCERPT_CHARS } from "../web/src/lib/taskReference.js"
import type { Project, Task } from "../shared/types"

const task = (extra: Partial<Task> = {}) =>
  ({ id: "task_api001", projectId: "prj_yard01", title: "Build the API", status: "idle", prUrl: null, branch: null, question: null, error: null, summary: null, activity: null, ...extra }) as Task

describe("who needs to be told what a task is at", () => {
  it("the Coordinator and the task's own Captain read it with get_task; everyone else can't", () => {
    const t = task()
    expect(needsContext("coordinator", t)).toBe(false)
    expect(needsContext("captain:prj_yard01", t)).toBe(false)
    // Another project's Captain, a task's agent, a side thread, a task not started yet.
    for (const key of ["captain:prj_site01", "task:task_plan01", "thread:thr_abc123", "new-task:prj_yard01", "local:3"]) expect(needsContext(key, t)).toBe(true)
  })
})

describe("the reference", () => {
  it("names the task by title and id, which links to it in the sent message", () => {
    expect(taskReference(task())).toBe("Task “Build the API” (task_api001)")
    // A title is one line.
    expect(taskReference(task({ title: "Fix  the\nlogin" }))).toBe("Task “Fix the login” (task_api001)")
  })

  it("with context: its project, state and PR (or branch), and the start of its latest reply, on a quoted line", () => {
    const t = task({ status: "pr_ready", prUrl: "https://github.com/acme/api/pull/7", branch: "build-the-api", summary: "Added the routes.\n\n- GET /items\n- POST /items" })
    expect(taskReference(t, { context: true, projectName: "box-yard" })).toBe(
      "Task “Build the API” (task_api001, project box-yard, PR open, https://github.com/acme/api/pull/7)\n> Latest reply: Added the routes. - GET /items - POST /items",
    )
    expect(taskReference(task({ branch: "build-the-api" }), { context: true })).toBe("Task “Build the API” (task_api001, idle, branch build-the-api)")
  })

  it("a question it asks comes first, then a failure's error, then its reply, then its latest step", () => {
    const all = { question: "Which port?", error: "boom", summary: "Done.", activity: "Read app.ts" }
    expect(taskReference(task({ ...all, status: "needs_input" }), { context: true })).toBe("Task “Build the API” (task_api001, waiting on an answer)\n> It asks: Which port?")
    expect(taskReference(task({ ...all, question: null, status: "failed" }), { context: true })).toBe("Task “Build the API” (task_api001, failed)\n> Error: boom")
    expect(taskReference(task({ ...all, question: null }), { context: true })).toBe("Task “Build the API” (task_api001, idle)\n> Latest reply: Done.")
    expect(taskReference(task({ activity: "Read app.ts", status: "working" }), { context: true })).toBe("Task “Build the API” (task_api001, working)\n> Latest step: Read app.ts")
  })

  it("a long reply is cut at a word, to a few lines' worth", () => {
    const long = "word ".repeat(200)
    const cut = excerpt(long)
    expect(cut.length).toBeLessThanOrEqual(EXCERPT_CHARS)
    expect(cut.endsWith("word…")).toBe(true)
    expect(excerpt("short")).toBe("short")
  })
})

describe("putting it in the draft", () => {
  const ref = "Task “A” (task_aaaaaa)"
  const block = "Task “A” (task_aaaaaa, idle)\n> Latest reply: ok"

  it("a one-line reference goes in at the caret, a space each side where there's none", () => {
    expect(insertReference("", 0, ref)).toEqual({ text: `${ref} `, caret: ref.length + 1 })
    expect(insertReference("Ask", 3, ref)).toEqual({ text: `Ask ${ref} `, caret: `Ask ${ref} `.length })
    expect(insertReference("Ask about", 3, ref)).toEqual({ text: `Ask ${ref} about`, caret: `Ask ${ref}`.length })
    expect(insertReference("about it", 0, ref)).toEqual({ text: `${ref} about it`, caret: `${ref} `.length })
    // A caret past the end is the end.
    expect(insertReference("Hi", 99, ref).text).toBe(`Hi ${ref} `)
  })

  it("a quoted one gets lines of its own, and a blank line after so what's typed next isn't quoted", () => {
    expect(insertReference("", 0, block)).toEqual({ text: `${block}\n\n`, caret: block.length + 2 })
    expect(insertReference("Look at ", 8, block)).toEqual({ text: `Look at\n${block}\n\n`, caret: `Look at\n${block}\n\n`.length })
    expect(insertReference("Look at\n\nthen fix it", 9, block).text).toBe(`Look at\n\n${block}\n\nthen fix it`)
    expect(insertReference("A\nB", 1, block).text).toBe(`A\n${block}\n\nB`)
    // Mid-sentence: what follows starts its own line, without the space it had.
    expect(insertReference("Follow up on  and check", 13, block)).toEqual({ text: `Follow up on\n${block}\n\nand check`, caret: `Follow up on\n${block}\n\n`.length })
  })
})

describe("names", () => {
  it("a sidebar row's task id, from its tree key", () => {
    expect(taskIdOfRowKey("task:task_api001@project")).toBe("task_api001")
    expect(taskIdOfRowKey("task:task_api001@waiting")).toBe("task_api001")
    for (const key of ["coordinator", "captain:prj_yard01", "group:more", null]) expect(taskIdOfRowKey(key)).toBeNull()
  })

  it("a message box by its draft key, as the menu calls it", () => {
    const data = { tasks: [task({ title: "A very long task title that goes on and on" })], projects: [{ id: "prj_yard01", name: "box-yard" } as Project] }
    expect(targetName("coordinator", data)).toBe("Coordinator chat")
    expect(targetName("captain:prj_yard01", data)).toBe("box-yard Captain")
    expect(targetName("task:task_api001", data)).toBe("task “A very long task title that goe…”")
    expect(targetName("thread:thr_abc123", data)).toBe("side thread")
    expect(targetName("new-task:prj_yard01", data)).toBe("New task")
    expect(targetName("local:2", data)).toBe("chat")
  })
})
