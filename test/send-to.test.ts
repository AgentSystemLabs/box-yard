import { describe, expect, it } from "vitest"
import { sendDestinations, sendToMention } from "../web/src/lib/sendTo"
import type { Project, Task } from "../shared/types"

describe("Send to query", () => {
  it("finds the destination query at the caret and preserves the rest of a draft", () => {
    const text = "Please review >acme api\nKeep this too"
    const mention = sendToMention(text, text.indexOf("\n"))!
    expect(mention.query).toBe("acme api")
    expect(text.slice(0, mention.start) + text.slice(mention.end)).toBe("Please review \nKeep this too")
    expect(sendToMention(">", 1)).toEqual({ start: 0, end: 1, query: "" })
  })
  it("leaves operators, escaped triggers, code and selected text alone", () => {
    for (const s of ["a>b", "\\>task", "`>task", "```ts\n>task", "hello\nworld"]) expect(sendToMention(s, s.length)).toBeNull()
    expect(sendToMention(">task", -1)).toBeNull()
    expect(sendToMention("```\nquote\n```\n>task", 22)).not.toBeNull()
  })
  it("searches tasks by title, project, status and ID; never invents another project's tasks", () => {
    const p = [{ id: "prj_example", name: "Example", repo: "acme/site" }] as Project[]
    const t = [{ id: "task_example", projectId: "prj_example", title: "Fix uploads", status: "done" }, { id: "task_hidden", projectId: "prj_missing", title: "Hidden" }] as Task[]
    const all = sendDestinations(p, t, "")
    expect(all.map((d) => d.kind)).toEqual(["coordinator", "captain", "task"])
    expect(sendDestinations(p, t, "Example uploads")[0]?.id).toBe("task_example")
    expect(sendDestinations(p, t, "acme")[0]?.kind).toBe("captain")
    expect(sendDestinations(p, t, "task_example")[0]?.detail).toContain("Sending reopens this task")
    expect(sendDestinations(p, t, "hidden")).toEqual([])
  })
  it("ranks a name over a detail, a word's start over its inside, and needs every word", () => {
    const p = [{ id: "prj_example", name: "Example", repo: "acme/site" }, { id: "prj_docs", name: "Docs", repo: "acme/docs" }] as Project[]
    const t = [
      { id: "task_a", projectId: "prj_example", title: "Tidy the sidebar", status: "working" },
      { id: "task_b", projectId: "prj_docs", title: "Example gallery", status: "done" },
      { id: "task_c", projectId: "prj_docs", title: "Counterexample page", status: "idle" },
    ] as Task[]
    const find = (q: string) => sendDestinations(p, t, q).map((d) => d.id)
    // "Example" names a Captain and a task; it is only the project of task_a, and inside a word of task_c.
    expect(find("example")).toEqual(["prj_example", "task_b", "task_a", "task_c"])
    expect(find("ex")).toEqual(["prj_example", "task_b", "task_a", "task_c"])
    // A whole word before a word that only starts with it.
    expect(find("doc")).toEqual(["prj_docs", "task_b", "task_c"])
    expect(find("docs gallery")).toEqual(["task_b"])
    expect(find("gallery   DOCS ")).toEqual(["task_b"])
    expect(find("docs sidebar")).toEqual([])
    // Equal hits keep the list's order: the Coordinator, the Captains, then tasks.
    expect(find("c")[0]).toBe("coordinator")
    expect(find("")).toEqual(["coordinator", "prj_example", "prj_docs", "task_a", "task_b", "task_c"])
  })
})
