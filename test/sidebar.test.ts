// The sidebar's lists: which projects show, which of their tasks, in what order, each row's short meta, the one row
// drawn selected, and the folds.
import { describe, expect, it } from "vitest"
import {
  WAITING_FOLD,
  cappedRows,
  inboxRows,
  keepGroups,
  keepRows,
  keepSelection,
  revealScroll,
  rowMeta,
  sidebarGroups,
  sidebarSelection,
  withFold,
  type SelectionInput,
} from "../web/src/lib/sidebar.js"
import type { Project, Task, TaskStatus } from "../shared/types.js"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const project = (id: string, name: string) => ({ id, name }) as unknown as Project
const task = (id: string, projectId: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title: `Task ${id}`, status, prUrl: null, prMergedAt: null, previews: [], error: null, question: null, scheduleId: null, outcome: null, createdAt: NOW - HOUR, updatedAt: NOW - HOUR, ...extra }) as unknown as Task

const YARD = project("p_yard", "box-yard")
const SITE = project("p_site", "marketing-site")
const PHOTO = project("p_photo", "photo-tools")
const opts = { now: NOW }
const ids = (g: { rows: { task: Task }[] }) => g.rows.map((r) => r.task.id)

describe("sidebarGroups", () => {
  it("shows projects with live work in the server's order, and folds quiet ones into others", () => {
    const tasks = [task("a", SITE.id, "working"), task("b", YARD.id, "needs_input"), task("c", PHOTO.id, "done")]
    const { shown, others } = sidebarGroups([YARD, SITE, PHOTO], tasks, {}, opts)
    expect(shown.map((g) => g.project.id)).toEqual([YARD.id, SITE.id])
    expect(others.map((g) => g.project.id)).toEqual([PHOTO.id])
    expect(shown[0]!.needs).toBe(1)
    expect(shown[1]!.running).toBe(1)
  })

  it("keeps a pinned project however quiet, and moves an unpinned one to others however busy", () => {
    const tasks = [task("a", SITE.id, "needs_input")]
    const { shown, others } = sidebarGroups([YARD, SITE], tasks, { [YARD.id]: "pinned", [SITE.id]: "unpinned" }, opts)
    expect(shown.map((g) => g.project.id)).toEqual([YARD.id])
    expect(others.map((g) => g.project.id)).toEqual([SITE.id])
    // Its count still says it asks, for the More projects row.
    expect(others[0]!.needs).toBe(1)
  })

  it("always shows the project whose Captain the chat is talking to", () => {
    const { shown } = sidebarGroups([YARD, SITE], [], { [SITE.id]: "unpinned" }, { ...opts, current: SITE.id })
    expect(shown.map((g) => g.project.id)).toEqual([SITE.id])
  })

  it("orders a project's tasks by what needs Cody first; idle ones stay, dim, however long they rested, and done ones hide", () => {
    const tasks = [
      task("idle-old", YARD.id, "idle", { lastActiveAt: NOW - 30 * 24 * HOUR, createdAt: NOW - 31 * 24 * HOUR }),
      task("idle-new", YARD.id, "idle", { lastActiveAt: NOW - HOUR }),
      task("pr", YARD.id, "pr_ready", { prUrl: "https://github.com/o/r/pull/253" }),
      task("done", YARD.id, "done"),
      task("run", YARD.id, "working"),
      task("ask", YARD.id, "needs_input"),
      task("fail", YARD.id, "failed"),
    ]
    const [g] = sidebarGroups([YARD], tasks, {}, opts).shown
    expect(ids(g!)).toEqual(["ask", "fail", "run", "pr", "idle-new", "idle-old"])
    expect(g!.rows.map((r) => r.dim)).toEqual([false, false, false, false, true, true])
  })

  it("a project whose only tasks are idle, waiting for Cody's review, stays shown until Cody marks them done", () => {
    const tasks = [task("i", YARD.id, "idle", { lastActiveAt: NOW - 10 * 24 * HOUR })]
    const { shown, others } = sidebarGroups([YARD], tasks, {}, opts)
    expect(shown.map((g) => g.project.id)).toEqual([YARD.id])
    expect(ids(shown[0]!)).toEqual(["i"])
    expect(others).toEqual([])
    // Cody marked it done: the project folds into More projects.
    expect(sidebarGroups([YARD], [{ ...tasks[0]!, status: "done" }], {}, opts).others.map((g) => g.project.id)).toEqual([YARD.id])
    // Cody unpinned the project: it goes there anyway.
    expect(sidebarGroups([YARD], tasks, { [YARD.id]: "unpinned" }, opts).others.map((g) => g.project.id)).toEqual([YARD.id])
  })

  it("leaves out quiet schedule runs and tasks being marked done", () => {
    const quiet = task("q", YARD.id, "done", { outcome: "noop", scheduleId: "s1" })
    const closing = task("c", YARD.id, "pr_ready")
    const { shown } = sidebarGroups([YARD], [quiet, closing, task("w", YARD.id, "working")], {}, { ...opts, closing: new Set(["c"]) })
    expect(ids(shown[0]!)).toEqual(["w"])
  })

  it("a tree being marked done leaves at once: its sub-tasks don't stand in for their parent while the close is on its way", () => {
    const parent = task("p", YARD.id, "idle")
    const kid = task("k", YARD.id, "idle", { parentTaskId: "p" })
    const grandkid = task("g", YARD.id, "idle", { parentTaskId: "k" })
    const other = task("o", YARD.id, "idle")
    expect(ids(sidebarGroups([YARD], [parent, kid, grandkid, other], {}, opts).shown[0]!)).toEqual(["p", "o"])
    expect(ids(sidebarGroups([YARD], [parent, kid, grandkid, other], {}, { ...opts, closing: new Set(["p"]) }).shown[0]!)).toEqual(["o"])
  })
})

describe("rowMeta", () => {
  it("says what Cody would ask about first", () => {
    // State words are gone: the row's icon says the state, so only a PR shows here.
    expect(rowMeta(task("a", YARD.id, "needs_input"))).toBe("")
    expect(rowMeta(task("a", YARD.id, "failed"))).toBe("")
    expect(rowMeta(task("a", YARD.id, "queued"))).toBe("")
    expect(rowMeta(task("a", YARD.id, "pr_ready", { prUrl: "https://github.com/o/r/pull/19" }))).toBe("#19")
    expect(rowMeta(task("a", YARD.id, "done", { prUrl: "https://github.com/o/r/pull/19", prMergedAt: NOW }))).toBe("merged #19")
    expect(rowMeta(task("a", YARD.id, "done"))).toBe("")
    expect(rowMeta(task("a", YARD.id, "working", { lastActiveAt: NOW - 12 * 60_000 }))).toBe("")
    expect(rowMeta(task("a", YARD.id, "idle", { lastActiveAt: NOW - 12 * 60_000 }))).toBe("")
    expect(rowMeta(task("a", YARD.id, "idle", { prUrl: "https://github.com/o/r/pull/7" }))).toBe("#7")
  })


})

describe("inboxRows", () => {
  it("lists what the inbox holds: asking, then failed, then PRs to review", () => {
    const tasks = [task("pr", YARD.id, "pr_ready"), task("w", YARD.id, "working"), task("f", SITE.id, "failed"), task("a", SITE.id, "needs_input")]
    const rows = inboxRows(tasks, (t) => ["needs_input", "failed", "pr_ready"].includes(t.status))
    expect(rows.map((r) => r.task.id)).toEqual(["a", "f", "pr"])
  })
})

describe("cappedRows", () => {
  const rows = inboxRows(["a", "b", "c", "d", "e", "f", "g"].map((id) => task(id, YARD.id, "needs_input")), () => true)
  const shownIds = (r: { shown: { task: Task }[] }) => r.shown.map((x) => x.task.id)

  it("shows the first five and counts the rest for \"Show n more\"", () => {
    const r = cappedRows(rows, { expanded: false })
    expect(r.shown).toHaveLength(5)
    expect(r.hidden).toBe(2)
  })

  it("shows them all once expanded, or when there are only a few", () => {
    expect(cappedRows(rows, { expanded: true }).hidden).toBe(0)
    expect(cappedRows(rows.slice(0, 5), { expanded: false })).toEqual({ shown: rows.slice(0, 5), hidden: 0 })
  })

  it("keeps the open task on screen even past the cap", () => {
    const last = rows[6]!.task.id
    const r = cappedRows(rows, { expanded: false, keep: last })
    expect(shownIds(r)).toEqual([...shownIds(cappedRows(rows, { expanded: false })), last])
    expect(r.hidden).toBe(1)
  })
})

describe("sidebarSelection", () => {
  // t1 waits on Cody and sits under box-yard too; t2 is only under box-yard; t3 is under marketing-site.
  const base: SelectionInput = {
    centre: null,
    panel: null,
    picked: null,
    waiting: new Set(["t1"]),
    projectOf: new Map([["t1", YARD.id], ["t2", YARD.id], ["t3", SITE.id]]),
    folds: {},
  }
  const open = (id: string, extra: Partial<SelectionInput> = {}) => sidebarSelection({ ...base, panel: { kind: "session", id }, ...extra })

  it("with no panel, the centre chat is the one selected row: the Coordinator or a Captain", () => {
    expect(sidebarSelection(base)).toEqual({ selected: "coordinator", behind: null, inside: null })
    expect(sidebarSelection({ ...base, centre: SITE.id })).toEqual({ selected: `captain:${SITE.id}`, behind: null, inside: null })
  })

  it("an open task takes the selection; the chat behind it only gets a mark", () => {
    expect(open("t2", { centre: SITE.id })).toEqual({ selected: "task:t2@project", behind: `captain:${SITE.id}`, inside: null })
  })

  it("of a task's two rows, the one clicked is selected, never both", () => {
    expect(open("t1", { picked: { taskId: "t1", spot: "waiting" } }).selected).toBe("task:t1@waiting")
    expect(open("t1", { picked: { taskId: "t1", spot: "project" } }).selected).toBe("task:t1@project")
    // Opened some other way (a link, a notice, a reload): the row under its project.
    expect(open("t1").selected).toBe("task:t1@project")
    expect(open("t1", { picked: { taskId: "t2", spot: "waiting" } }).selected).toBe("task:t1@project")
  })

  it("a folded group never hides the selection while the task has another row on screen", () => {
    expect(open("t1", { picked: { taskId: "t1", spot: "waiting" }, folds: { [WAITING_FOLD]: true } }).selected).toBe("task:t1@project")
    expect(open("t1", { picked: { taskId: "t1", spot: "project" }, folds: { [YARD.id]: true } }).selected).toBe("task:t1@waiting")
  })

  it("when every row of the open task is folded away, its group gets the faint bar instead", () => {
    expect(open("t2", { folds: { [YARD.id]: true } })).toEqual({ selected: null, behind: "coordinator", inside: YARD.id })
    const both = { [YARD.id]: true, [WAITING_FOLD]: true } as const
    expect(open("t1", { folds: both }).inside).toBe(YARD.id)
    expect(open("t1", { folds: both, picked: { taskId: "t1", spot: "waiting" } }).inside).toBe(WAITING_FOLD)
  })

  it("a Captain opened in the panel is selected, with the centre chat behind it", () => {
    expect(sidebarSelection({ ...base, panel: { kind: "captain", id: SITE.id } })).toEqual({ selected: `captain:${SITE.id}`, behind: "coordinator", inside: null })
    expect(sidebarSelection({ ...base, centre: SITE.id, panel: { kind: "captain", id: SITE.id } })).toEqual({ selected: `captain:${SITE.id}`, behind: null, inside: null })
  })

  it("a schedule in the panel has no row: nothing is selected, and the centre chat keeps its mark", () => {
    expect(sidebarSelection({ ...base, panel: { kind: "schedule", id: "sch_1" } })).toEqual({ selected: null, behind: "coordinator", inside: null })
  })
})

describe("revealScroll", () => {
  const list = { top: 100, bottom: 500 }
  it("leaves a group that's already in view where it is", () => {
    expect(revealScroll(list, { top: 100, bottom: 500 })).toBe(0)
    expect(revealScroll(list, { top: 200, bottom: 300 })).toBe(0)
  })
  it("shows all of a group that fits, scrolling as little as it can", () => {
    // Below: up until its bottom is the list's. Above: down until its top is.
    expect(revealScroll(list, { top: 450, bottom: 650 })).toBe(150)
    expect(revealScroll(list, { top: -50, bottom: 150 })).toBe(-150)
  })
  it("a group taller than the list starts at its head", () => {
    expect(revealScroll(list, { top: 300, bottom: 900 })).toBe(200)
    expect(revealScroll(list, { top: -300, bottom: 600 })).toBe(-400)
  })
})

describe("withFold", () => {
  it("folds and unfolds a project or the Waiting section, and returns the same object when nothing changes", () => {
    const folded = withFold({}, YARD.id, true)
    expect(folded).toEqual({ [YARD.id]: true })
    expect(withFold(folded, YARD.id, true)).toBe(folded)
    expect(withFold(folded, WAITING_FOLD, true)).toEqual({ [YARD.id]: true, [WAITING_FOLD]: true })
    expect(withFold(folded, YARD.id, false)).toEqual({})
  })
})

describe("keeping what didn't change", () => {
  // A live task update replaces only the task it names (upsert in lib/queries.ts); the rest stay the same objects.
  const tasks = [task("a", YARD.id, "needs_input"), task("b", YARD.id, "working"), task("c", SITE.id, "pr_ready"), task("d", PHOTO.id, "done", { updatedAt: NOW - 10 * HOUR })]
  const update = (id: string, extra: Partial<Task>) => tasks.map((t) => (t.id === id ? { ...t, ...extra } : t))
  const groups = (list: Task[], at = NOW) => sidebarGroups([YARD, SITE, PHOTO], list, {}, { ...opts, now: at })

  it("one task's update keeps every other row, and every other group, the same objects", () => {
    const before = groups(tasks)
    const shown = keepGroups(before.shown, groups(update("b", { contextTokens: 1200 })).shown)
    expect(shown.map((g) => g.project.id)).toEqual([YARD.id, SITE.id])
    expect(shown[1]).toBe(before.shown[1])
    expect(shown[0]).not.toBe(before.shown[0])
    expect(shown[0]!.rows[0]).toBe(before.shown[0]!.rows[0])
    expect(shown[0]!.rows[1]).not.toBe(before.shown[0]!.rows[1])
    expect(shown[0]!.rows[1]!.task.contextTokens).toBe(1200)
  })

  it("returns the very same list when nothing in it changed, empty ones too", () => {
    const before = groups(tasks)
    // A recompute with nothing new (another query's update, a re-render) builds new objects with the same content.
    expect(keepGroups(before.shown, groups(tasks).shown)).toBe(before.shown)
    expect(keepGroups(before.others, groups(tasks).others)).toBe(before.others)
    const none = groups([])
    expect(keepGroups(none.others, groups([]).others)).toBe(none.others)
    const waiting = inboxRows(tasks, (t) => t.status === "needs_input")
    expect(keepRows(waiting, inboxRows(tasks, (t) => t.status === "needs_input"))).toBe(waiting)
    expect(keepRows([], [])).toEqual([])
  })

  it("keeps the same rows as time passes: idle rows have no last-run age", () => {
    const idle = [task("e", YARD.id, "idle", { updatedAt: NOW - 30 * 60_000 }), task("f", YARD.id, "working")]
    const before = groups(idle).shown
    expect(keepGroups(before, groups(idle, NOW + 5 * 60_000).shown)).toBe(before)
    expect(before[0]!.rows.map((r) => r.meta)).toEqual(["", ""])
  })

  it("follows a task that moves: a new status reorders the rows and changes the group's counts", () => {
    const before = groups(tasks).shown[0]!
    const after = keepGroups([before], groups(update("a", { status: "pr_ready" })).shown)[0]!
    expect(after.needs).toBe(0)
    expect(ids(after)).toEqual(["b", "a"])
    expect(after.rows[0]).toBe(before.rows[1])
  })

  it("a project that comes or goes is followed, never kept stale", () => {
    const before = groups(tasks)
    const after = groups(update("d", { status: "failed" }))
    const shown = keepGroups(before.shown, after.shown)
    expect(shown.map((g) => g.project.id)).toEqual([YARD.id, SITE.id, PHOTO.id])
    expect(shown[0]).toBe(before.shown[0])
    expect(keepGroups(before.others, after.others)).toEqual([])
  })

  it("keeps the selection object while it marks the same rows", () => {
    const sel = { selected: "task:a@project", behind: "coordinator", inside: null }
    expect(keepSelection(sel, { ...sel })).toBe(sel)
    const next = { ...sel, selected: "task:b@project" }
    expect(keepSelection(sel, next)).toBe(next)
    expect(keepSelection(undefined, next)).toBe(next)
  })
})
