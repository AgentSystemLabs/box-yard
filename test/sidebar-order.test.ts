// @vitest-environment happy-dom
// Rearranging the sidebar (lib/sidebarOrder.ts): which list a row is in, where a move takes it, the order sent to the
// server, and how the sidebar sorts tasks Cody placed among the ones he didn't (lib/sidebar.ts).
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { captainKey, coordinatorKey, sidebarGroups, taskKey } from "../web/src/lib/sidebar.js"
import { moveTarget, moved, movedText, orderSpot, projectOrderWith, resetOrder, saveOrder, slotTarget } from "../web/src/lib/sidebarOrder.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project, Task, TaskStatus } from "../shared/types.js"

const NOW = 1_800_000_000_000
const project = (id: string, name: string) => ({ id, name }) as unknown as Project
const task = (id: string, projectId: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title: `Task ${id}`, status, prUrl: null, prMergedAt: null, previews: [], error: null, question: null, scheduleId: null, outcome: null, createdAt: NOW, updatedAt: NOW, ...extra }) as unknown as Task

const YARD = project("p_yard", "box-yard")
const SITE = project("p_site", "marketing-site")
const PHOTO = project("p_photo", "photo-tools")
const DOCS = project("p_docs", "docs")
const rows = (g: { rows: { task: Task }[] }) => g.rows.map((r) => r.task.id)

describe("the sidebar's task order", () => {
  it("a list nobody rearranged is in the automatic order: what needs Cody first, newest first", () => {
    const tasks = [task("old", YARD.id, "working", { createdAt: NOW - 2 }), task("new", YARD.id, "working", { createdAt: NOW - 1 }), task("asks", YARD.id, "needs_input", { createdAt: NOW - 3 })]
    expect(rows(sidebarGroups([YARD], tasks, {}, {}).shown[0]!)).toEqual(["asks", "new", "old"])
  })

  it("placed tasks keep Cody's order whatever their state", () => {
    const tasks = [task("a", YARD.id, "idle", { sortOrder: 0 }), task("b", YARD.id, "needs_input", { sortOrder: 2 }), task("c", YARD.id, "working", { sortOrder: 1 })]
    expect(rows(sidebarGroups([YARD], tasks, {}, {}).shown[0]!)).toEqual(["a", "c", "b"])
  })

  it("a new task, not placed yet, shows on top of the placed ones, in the automatic order", () => {
    const tasks = [
      task("a", YARD.id, "needs_input", { sortOrder: 0 }),
      task("b", YARD.id, "idle", { sortOrder: 1 }),
      task("fresh", YARD.id, "queued", { createdAt: NOW + 1 }),
      task("fresher", YARD.id, "working", { createdAt: NOW + 2, sortOrder: null }),
    ]
    expect(rows(sidebarGroups([YARD], tasks, {}, {}).shown[0]!)).toEqual(["fresher", "fresh", "a", "b"])
  })

  it("sub-tasks: Cody's order first, then the rest in spawn order, so a new one goes last", () => {
    const parent = task("parent", YARD.id, "working")
    const kid = (id: string, at: number, sortOrder?: number) => task(id, YARD.id, "working", { parentTaskId: parent.id, createdAt: NOW + at, sortOrder })
    const spawn = sidebarGroups([YARD], [parent, kid("k2", 2), kid("k1", 1), kid("k3", 3)], {}, {}).shown[0]!
    expect(spawn.rows[0]!.kids!.map((r) => r.task.id)).toEqual(["k1", "k2", "k3"])
    const placed = sidebarGroups([YARD], [parent, kid("k1", 1, 1), kid("k2", 2, 0), kid("k3", 3), kid("k4", 4)], {}, {}).shown[0]!
    expect(placed.rows[0]!.kids!.map((r) => r.task.id)).toEqual(["k2", "k1", "k3", "k4"])
  })
})

describe("orderSpot: the list a row moves in", () => {
  const parent = task("parent", YARD.id, "working")
  const tasks = [
    parent,
    task("k1", YARD.id, "working", { parentTaskId: parent.id, createdAt: NOW + 1 }),
    task("k2", YARD.id, "working", { parentTaskId: parent.id, createdAt: NOW + 2, sortOrder: 4 }),
    task("deep", YARD.id, "working", { parentTaskId: "k1", createdAt: NOW + 3 }),
    task("deeper", YARD.id, "working", { parentTaskId: "k1", createdAt: NOW + 4 }),
    task("solo", YARD.id, "idle"),
    task("s1", SITE.id, "working"),
  ]
  const groups = sidebarGroups([YARD, PHOTO, SITE, DOCS], tasks, {}, {})

  it("a project moves among the projects shown, or among More projects, never between them", () => {
    expect(orderSpot(groups, captainKey(SITE.id))).toMatchObject({ index: 1, list: { kind: "projects", ids: [YARD.id, SITE.id], names: ["box-yard", "marketing-site"] } })
    expect(orderSpot(groups, captainKey(DOCS.id))).toMatchObject({ index: 1, list: { kind: "projects", ids: [PHOTO.id, DOCS.id] } })
  })

  it("a task moves among its project's tasks", () => {
    const spot = orderSpot(groups, taskKey("solo", "project"))!
    expect(spot).toMatchObject({ index: 1, list: { kind: "tasks", projectId: YARD.id, ids: ["parent", "solo"], placed: false } })
    expect(spot.list.parentTaskId).toBeUndefined()
    expect(spot.list.keys).toEqual([taskKey("parent", "project"), taskKey("solo", "project")])
    expect(orderSpot(groups, taskKey("s1", "project"))).toMatchObject({ index: 0, list: { projectId: SITE.id, ids: ["s1"] } })
  })

  it("a sub-task moves among its parent's sub-tasks, at any depth", () => {
    expect(orderSpot(groups, taskKey("k1", "project"))).toMatchObject({ index: 1, list: { kind: "subtasks", projectId: YARD.id, parentTaskId: "parent", ids: ["k2", "k1"], placed: true } })
    expect(orderSpot(groups, taskKey("deeper", "project"))).toMatchObject({ index: 1, list: { kind: "subtasks", parentTaskId: "k1", ids: ["deep", "deeper"], names: ["Task deep", "Task deeper"] } })
  })

  it("the Coordinator, Waiting on you and unknown rows don't move", () => {
    expect(orderSpot(groups, coordinatorKey)).toBeNull()
    expect(orderSpot(groups, taskKey("solo", "waiting"))).toBeNull()
    expect(orderSpot(groups, taskKey("nothere", "project"))).toBeNull()
    expect(orderSpot(groups, null)).toBeNull()
  })
})

describe("moves", () => {
  it("moveTarget: one step, or to an end; null at the edge", () => {
    expect(moveTarget(1, 4, "up")).toBe(0)
    expect(moveTarget(1, 4, "down")).toBe(2)
    expect(moveTarget(1, 4, "top")).toBe(0)
    expect(moveTarget(1, 4, "bottom")).toBe(3)
    expect(moveTarget(0, 4, "up")).toBeNull()
    expect(moveTarget(0, 4, "top")).toBeNull()
    expect(moveTarget(3, 4, "down")).toBeNull()
    expect(moveTarget(3, 4, "bottom")).toBeNull()
    expect(moveTarget(0, 1, "down")).toBeNull()
  })

  it("moved: the item goes to its new index and the rest keep their order", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"])
    expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"])
    expect(moved(["a", "b"], 0, 1)).toEqual(["b", "a"])
  })

  it("slotTarget: a drop in the gap above or below the row itself leaves it where it is", () => {
    // Row 1 of [0, 1, 2]: gaps 1 and 2 are its own edges.
    expect(slotTarget(1, 0)).toBe(0)
    expect(slotTarget(1, 1)).toBeNull()
    expect(slotTarget(1, 2)).toBeNull()
    expect(slotTarget(1, 3)).toBe(2)
    expect(slotTarget(0, 3)).toBe(2)
    expect(slotTarget(2, 0)).toBe(0)
  })

  it("projectOrderWith: the moved projects trade the places they had; the other list's stay put", () => {
    const all = ["yard", "photo", "site", "docs", "blog"]
    // yard, site and blog are shown; photo and docs are under More projects.
    expect(projectOrderWith(all, ["blog", "yard", "site"])).toEqual(["blog", "photo", "yard", "docs", "site"])
    expect(projectOrderWith(all, ["docs", "photo"])).toEqual(["yard", "docs", "site", "photo", "blog"])
  })

  it("movedText says the row and its new place", () => {
    expect(movedText("Fix login", 0, 3)).toBe("Fix login moved to 1 of 3")
  })
})

describe("saving an order", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const t of currentToasts()) dismiss(t.id)
  })
  const ok = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  const cache = () => {
    const qc = new QueryClient()
    const tasks = [task("a", YARD.id, "idle"), task("b", YARD.id, "idle"), task("c", YARD.id, "idle"), task("s", SITE.id, "idle")]
    qc.setQueryData(keys.tasks, tasks)
    qc.setQueryData(keys.projects, [YARD, PHOTO, SITE, DOCS])
    return { qc, tasks }
  }
  const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => [init.method, url, JSON.parse(init.body as string)])

  it("tasks: places them in the cache at once and sends the list with its parent", async () => {
    const { qc, tasks } = cache()
    const fetchMock = vi.fn(async () => ok())
    vi.stubGlobal("fetch", fetchMock)
    const list = orderSpot(sidebarGroups([YARD, SITE], tasks, {}, {}), taskKey("a", "project"))!.list
    const saving = saveOrder(qc, list, ["c", "a", "b"])
    const now = qc.getQueryData<Task[]>(keys.tasks)!
    expect(now.map((t) => [t.id, t.sortOrder])).toEqual([["a", 1], ["b", 2], ["c", 0], ["s", undefined]])
    // Another project's task is the same object: its row doesn't re-render.
    expect(now[3]).toBe(tasks[3])
    expect(await saving).toBe(true)
    expect(sent(fetchMock)).toEqual([["PUT", `/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: ["c", "a", "b"] }]])

    // A second save that changes one place leaves the others' objects alone.
    const before = qc.getQueryData<Task[]>(keys.tasks)!
    await saveOrder(qc, list, ["c", "b", "a"])
    const after = qc.getQueryData<Task[]>(keys.tasks)!
    expect(after[2]).toBe(before[2])
    expect(after[0]).not.toBe(before[0])
  })

  it("sub-tasks name their parent, and Automatic order clears the places", async () => {
    const qc = new QueryClient()
    const parent = task("parent", YARD.id, "working")
    const tasks = [parent, task("k1", YARD.id, "working", { parentTaskId: "parent", sortOrder: 1 }), task("k2", YARD.id, "working", { parentTaskId: "parent", sortOrder: 0 })]
    qc.setQueryData(keys.tasks, tasks)
    const fetchMock = vi.fn(async () => ok())
    vi.stubGlobal("fetch", fetchMock)
    const list = orderSpot(sidebarGroups([YARD], tasks, {}, {}), taskKey("k1", "project"))!.list
    expect(await resetOrder(qc, list)).toBe(true)
    expect(qc.getQueryData<Task[]>(keys.tasks)!.map((t) => t.sortOrder ?? null)).toEqual([null, null, null])
    expect(sent(fetchMock)).toEqual([["PUT", `/api/projects/${YARD.id}/tasks/order`, { parentTaskId: "parent", ids: ["k2", "k1"], auto: true }]])
  })

  it("projects: sends every project, the moved ones in the places they had between them", async () => {
    const { qc, tasks } = cache()
    const fetchMock = vi.fn(async () => ok())
    vi.stubGlobal("fetch", fetchMock)
    // YARD and SITE have tasks, so they're shown; PHOTO and DOCS are under More projects.
    const groups = sidebarGroups([YARD, PHOTO, SITE, DOCS], tasks, {}, {})
    const list = orderSpot(groups, captainKey(SITE.id))!.list
    expect(await saveOrder(qc, list, [SITE.id, YARD.id])).toBe(true)
    expect(qc.getQueryData<Project[]>(keys.projects)!.map((p) => p.id)).toEqual([SITE.id, PHOTO.id, YARD.id, DOCS.id])
    expect(sent(fetchMock)).toEqual([["PUT", "/api/projects/order", { ids: [SITE.id, PHOTO.id, YARD.id, DOCS.id] }]])

    // The same order again asks the server nothing.
    fetchMock.mockClear()
    await saveOrder(qc, { ...list, ids: [SITE.id, YARD.id] }, [SITE.id, YARD.id])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("a save the server refuses says so and asks for the server's order again", async () => {
    const { qc, tasks } = cache()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Task b is in another project" }), { status: 400, headers: { "Content-Type": "application/json" } })))
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const list = orderSpot(sidebarGroups([YARD, SITE], tasks, {}, {}), taskKey("a", "project"))!.list
    expect(await saveOrder(qc, list, ["b", "a", "c"])).toBe(false)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.tasks })
    expect(currentToasts().map((t) => [t.kind, t.title, t.body])).toEqual([["error", "Couldn't save the new order", "Task b is in another project"]])
  })
})
