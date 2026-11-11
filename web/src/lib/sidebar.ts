// The left sidebar (components/Sidebar.tsx): the Coordinator, "Waiting on you", then each project (its row opens
// its Captain) and its open tasks: live ones, and resting ones waiting for Cody's review until Cody marks them done.
// Which projects and rows it shows, in what order, each row's short meta, and which one row is drawn selected are pure,
// so they are unit tested. Whether it's a full column, a rail, or a drawer is kept here too, for the shell and the chat
// header to share.
import { useSyncExternalStore } from "react"
import type { Project, Task, TaskStatus } from "../../../shared/types"
import { isQuietRun } from "../../../shared/quiet"
import { prNumber } from "./prState"
import type { BarPins, PinState } from "./projectBar"

export interface SidebarRow {
  task: Task
  /** Resting (idle), ready for Cody's review: drawn dim, so live work stands out. */
  dim: boolean
  /** The short word on the right: "asks", "starting", or "#253". Working/failed use the title and icon. */
  meta: string
  /** Its sub-tasks (server/subtasks.ts), nested under it in spawn order, finished ones too. Only under a project. */
  kids?: SidebarRow[]
  /** Over every sub-task below it, nested ones too: how many are still on their way to a report, of how many. */
  tree?: TreeCount
}

export interface TreeCount {
  running: number
  total: number
  asks: number
}

export interface SidebarGroup {
  project: Project
  pin: PinState | null
  rows: SidebarRow[]
  /** Tasks asking Cody. */
  needs: number
  /** Turns running or being set up. */
  running: number
}

// Needs Cody first, then what broke, then what's moving, then what's waiting on review; resting ones last.
const ORDER: Record<TaskStatus, number> = { needs_input: 0, failed: 1, working: 2, starting: 2, waiting: 3, queued: 4, pr_ready: 5, idle: 6, done: 7 }
const LIVE: ReadonlySet<TaskStatus> = new Set(["needs_input", "failed", "working", "starting", "waiting", "queued", "pr_ready"])

const lastActive = (t: Task) => t.lastActiveAt ?? t.updatedAt

/** The word a row ends with: what Cody would ask about first. */
export function rowMeta(t: Task): string {
  const pr = t.prUrl ? prNumber(t.prUrl) : null
  switch (t.status) {
    case "needs_input": return "asks"
    case "failed": return ""
    case "working": return ""
    case "starting": return "starting"
    case "queued": return "queued"
    case "waiting": return "waiting"
    case "pr_ready": return pr ? `#${pr}` : "PR"
    case "done": return t.prMergedAt ? (pr ? `merged #${pr}` : "merged") : "done"
    default: return pr ? `#${pr}` : ""
  }
}

const byAttention = (a: Task, b: Task) => ORDER[a.status] - ORDER[b.status] || b.createdAt - a.createdAt

/** A sub-task on its way to a report (the server's LIVE_SUBTASK): the tree's "running" count. */
const SUBTASK_RUNNING: ReadonlySet<TaskStatus> = new Set(["queued", "starting", "working", "waiting"])

/**
 * The project list's sub-task trees: which tasks nest under a parent instead of being rows of their own, and each
 * shown task's row with its sub-tasks below it. A tree shows while its top task would (live, or resting for review) or
 * while anything in it still runs; every sub-task of a shown task shows with it, finished ones dim, so the whole tree
 * stays in view until Cody marks it done.
 */
function subtaskTrees(tasks: readonly Task[], shownAlone: (t: Task) => boolean) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const kidsOf = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.parentTaskId || !byId.has(t.parentTaskId)) continue
    const list = kidsOf.get(t.parentTaskId) ?? []
    list.push(t)
    kidsOf.set(t.parentTaskId, list)
  }
  for (const list of kidsOf.values()) list.sort((a, b) => a.createdAt - b.createdAt)
  const liveBelow = new Map<string, boolean>()
  const running = (id: string, seen = new Set<string>()): boolean => {
    const known = liveBelow.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return false
    seen.add(id)
    const live = (kidsOf.get(id) ?? []).some((k) => LIVE.has(k.status) || running(k.id, seen))
    liveBelow.set(id, live)
    return live
  }
  const visible = (t: Task, depth = 0): boolean => {
    if (shownAlone(t) || running(t.id)) return true
    const parent = t.parentTaskId ? byId.get(t.parentTaskId) : undefined
    return Boolean(parent && depth < 12 && visible(parent, depth + 1))
  }
  /** Shown, and not nested under a parent that's shown. */
  const top = (t: Task) => {
    const parent = t.parentTaskId ? byId.get(t.parentTaskId) : undefined
    return !(parent && visible(parent)) && (shownAlone(t) || running(t.id))
  }
  const row = (t: Task, depth: number, seen: Set<string>): SidebarRow => {
    const kids = depth < 12 ? (kidsOf.get(t.id) ?? []).filter((k) => !seen.has(k.id)) : []
    const base: SidebarRow = { task: t, dim: t.status === "idle" || (depth > 0 && t.status === "done"), meta: rowMeta(t) }
    if (!kids.length) return base
    for (const k of kids) seen.add(k.id)
    const rows = kids.map((k) => row(k, depth + 1, seen))
    const tree: TreeCount = { running: 0, total: 0, asks: 0 }
    for (const r of rows) {
      tree.total += 1 + (r.tree?.total ?? 0)
      tree.running += (SUBTASK_RUNNING.has(r.task.status) ? 1 : 0) + (r.tree?.running ?? 0)
      tree.asks += (r.task.status === "needs_input" ? 1 : 0) + (r.tree?.asks ?? 0)
    }
    return { ...base, kids: rows, tree }
  }
  return { top, row: (t: Task) => row(t, 0, new Set([t.id])) }
}

/**
 * The sidebar's projects. `shown`: the pinned ones, the ones with open tasks (unless Cody unpinned them) and `current`
 * (the Captain the chat is talking to), in the order the server lists projects, so a group never jumps as statuses
 * change. Each has its live tasks and its idle ones (dim): only Cody marks a task done, so a task its agent finished
 * stays here, ready for review, until Cody does. Done ones only come back through the palette (⌘K).
 * `others`: every other project, for the folded "More projects" list.
 */
export function sidebarGroups(
  projects: readonly Project[],
  tasks: readonly Task[],
  pins: BarPins,
  opts: { now?: number; current?: string | null; closing?: ReadonlySet<string> },
): { shown: SidebarGroup[]; others: SidebarGroup[] } {
  const groups = new Map<string, SidebarGroup>()
  for (const p of projects) groups.set(p.id, { project: p, pin: pins[p.id] ?? null, rows: [], needs: 0, running: 0 })
  const byProject = new Map<string, Task[]>()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  /** Being marked done here, or under a task that is: Mark done on a parent closes its tree, so it all leaves at once. */
  const closing = (t: Task | undefined, depth = 0): boolean =>
    Boolean(t && opts.closing?.size && depth < 12 && (opts.closing.has(t.id) || closing(t.parentTaskId ? byId.get(t.parentTaskId) : undefined, depth + 1)))
  const listed = tasks.filter((t) => groups.has(t.projectId) && !isQuietRun(t) && !closing(t))
  const shownAlone = (t: Task) => LIVE.has(t.status) || t.status === "idle"
  const trees = subtaskTrees(listed, shownAlone)
  for (const t of listed) {
    const g = groups.get(t.projectId)!
    if (t.status === "needs_input") g.needs++
    if (t.status === "working" || t.status === "starting") g.running++
    if (!trees.top(t)) continue
    const list = byProject.get(t.projectId) ?? []
    list.push(t)
    byProject.set(t.projectId, list)
  }
  const shown: SidebarGroup[] = []
  const others: SidebarGroup[] = []
  for (const g of groups.values()) {
    g.rows = (byProject.get(g.project.id) ?? []).sort(byAttention).map(trees.row)
    if (g.project.id === opts.current || g.pin === "pinned" || (g.pin === null && g.rows.length > 0)) shown.push(g)
    else others.push(g)
  }
  return { shown, others }
}

/** "Waiting on you": tasks asking, failed or with a PR to review, in that order, newest first within each. */
export function inboxRows(tasks: readonly Task[], inInbox: (t: Task) => boolean): SidebarRow[] {
  return tasks
    .filter(inInbox)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || lastActive(b) - lastActive(a))
    .map((t) => ({ task: t, dim: false, meta: rowMeta(t) }))
}

// --- Keeping what didn't change: a task update re-renders only its own row ------------------------------------------

/**
 * `next`, with every row that didn't change taken from `prev`: the same task object (the cache replaces only the task
 * an event names), dim and meta. The whole list is `prev` when nothing in it changed. The sidebar's rows are memo'd,
 * so with these one task's update re-renders one row, not all of them.
 */
export function keepRows(prev: readonly SidebarRow[] | undefined, next: SidebarRow[]): SidebarRow[] {
  if (!prev) return next
  const old = new Map(prev.map((r) => [r.task.id, r]))
  let same = prev.length === next.length
  const out = next.map((r, i) => {
    const o = old.get(r.task.id)
    // A tree's rows are kept the same way, so a sub-task's update re-renders its own row and its parents' counts.
    const kids = r.kids && o?.kids ? keepRows(o.kids, r.kids) : r.kids
    const sameTree = o?.kids === kids && sameCount(o?.tree, r.tree)
    const kept = o && o.task === r.task && o.dim === r.dim && o.meta === r.meta && sameTree ? o : kids === r.kids ? r : { ...r, kids }
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? (prev as SidebarRow[]) : out
}

const sameCount = (a: TreeCount | undefined, b: TreeCount | undefined) => a === b || (a !== undefined && b !== undefined && a.running === b.running && a.total === b.total && a.asks === b.asks)

/** `next`, with every group whose project, pin, counts and rows didn't change taken from `prev` (rows by keepRows). */
export function keepGroups(prev: readonly SidebarGroup[] | undefined, next: SidebarGroup[]): SidebarGroup[] {
  if (!prev) return next
  const old = new Map(prev.map((g) => [g.project.id, g]))
  let same = prev.length === next.length
  const out = next.map((g, i) => {
    const o = old.get(g.project.id)
    const rows = keepRows(o?.rows, g.rows)
    const kept = o && o.project === g.project && o.pin === g.pin && o.needs === g.needs && o.running === g.running && o.rows === rows ? o : rows === g.rows ? g : { ...g, rows }
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? (prev as SidebarGroup[]) : out
}

/** `next`, or `prev` when it marks the same rows. */
export const keepSelection = (prev: Selection | undefined, next: Selection): Selection =>
  prev && prev.selected === next.selected && prev.behind === next.behind && prev.inside === next.inside ? prev : next

/** How many "Waiting on you" rows show before "Show n more", so a long list doesn't push the projects away. */
export const WAITING_CAP = 5

/**
 * The "Waiting on you" rows on screen: the first `cap`, or all once Cody asked for them. The open task (`keep`) always
 * stays, so the row drawn selected is never one hidden behind "Show n more".
 */
export function cappedRows(rows: readonly SidebarRow[], opts: { expanded: boolean; keep?: string | null }): { shown: SidebarRow[]; hidden: number } {
  if (opts.expanded || rows.length <= WAITING_CAP) return { shown: [...rows], hidden: 0 }
  const shown = rows.filter((r, i) => i < WAITING_CAP || r.task.id === opts.keep)
  return { shown, hidden: rows.length - shown.length }
}

// --- Selection: exactly one row looks selected ----------------------------------------------------------------------

/** Where a task row sits: in "Waiting on you" or under its project. A task can be in both. */
export type RowSpot = "waiting" | "project"

/** The fold key of the "Waiting on you" section, beside the project ids in the same store. */
export const WAITING_FOLD = "waiting"

/** A row's key: "coordinator", "captain:<projectId>", or "task:<taskId>@<spot>". */
export const coordinatorKey = "coordinator"
export const captainKey = (projectId: string) => `captain:${projectId}`
export const taskKey = (taskId: string, spot: RowSpot) => `task:${taskId}@${spot}`

export interface SelectionInput {
  /** The centre chat: null is the Coordinator, otherwise the project whose Captain it is. */
  centre: string | null
  /** The side panel's view (lib/overlays.ts), if one is open. */
  panel: { kind: string; id: string } | null
  /** Where Cody last picked a task row from, so of a task's two rows it's the one clicked that's marked. */
  picked: { taskId: string; spot: RowSpot } | null
  /** Task ids on screen in "Waiting on you" (after its cap). */
  waiting: ReadonlySet<string>
  /** Each listed task's project group, for the tasks under a project. */
  projectOf: ReadonlyMap<string, string>
  /** Folded groups: project ids, and WAITING_FOLD. */
  folds: Readonly<Record<string, true>>
  /** Sub-tasks hidden in a folded tree, each with the folded task row it's under (treeHidden). */
  hiddenIn?: ReadonlyMap<string, string>
}

export interface Selection {
  /** The one row drawn selected (fill and bar, aria-current="page"), or none: a schedule in the panel, say. */
  selected: string | null
  /** The centre chat while a panel covers it: a small mark, no fill. */
  behind: string | null
  /** A folded group holding the selected task (a project id or WAITING_FOLD): a faint bar, so it isn't lost. */
  inside: string | null
}

/**
 * Which row looks selected: the open task while the panel shows one, a Captain opened in the panel, otherwise the
 * centre chat. Only one row ever gets the selected look; the chat behind a panel gets a mark instead. Of a task's two
 * rows (Waiting on you and its project), the one Cody clicked wins, then the one under its project, if it's unfolded.
 */
export function sidebarSelection(s: SelectionInput): Selection {
  const centre = s.centre ? captainKey(s.centre) : coordinatorKey
  if (!s.panel) return { selected: centre, behind: null, inside: null }
  if (s.panel.kind === "captain") {
    const key = captainKey(s.panel.id)
    return { selected: key, behind: key === centre ? null : centre, inside: null }
  }
  if (s.panel.kind !== "session") return { selected: null, behind: centre, inside: null }
  const id = s.panel.id
  const project = s.projectOf.get(id)
  const inWaiting = s.waiting.has(id)
  const shown: Record<RowSpot, boolean> = {
    waiting: inWaiting && !s.folds[WAITING_FOLD],
    project: project !== undefined && !s.folds[project],
  }
  const wanted = s.picked?.taskId === id ? s.picked.spot : null
  const spot = wanted && shown[wanted] ? wanted : shown.project ? "project" : shown.waiting ? "waiting" : null
  // A sub-task in a folded tree: the folded row it's under gets the faint bar.
  const under = spot === "project" ? s.hiddenIn?.get(id) : undefined
  if (under && shown.waiting) return { selected: taskKey(id, "waiting"), behind: centre, inside: null }
  if (under) return { selected: null, behind: centre, inside: taskKey(under, "project") }
  if (spot) return { selected: taskKey(id, spot), behind: centre, inside: null }
  const inside = wanted === "waiting" && inWaiting ? WAITING_FOLD : project ?? (inWaiting ? WAITING_FOLD : null)
  return { selected: null, behind: centre, inside }
}

// --- Layout: full column, rail, or drawer ----------------------------------------------------------------------------

/** From this width the sidebar stays a full column beside an open panel; under it, a panel turns it into the rail. */
export const SIDEBAR_WIDE = 1280
/** Under this width there's no room for a column: the chat header's menu button opens it as a drawer. */
export const SIDEBAR_INLINE = 768

const COLLAPSED_KEY = "box-yard:sidebar-collapsed"
const FOLDS_KEY = "box-yard:sidebar-folds"

type Store<T> = { get: () => T; set: (v: T) => void; use: () => T }
function store<T>(initial: () => T, persist?: (v: T) => void): Store<T> {
  let value: T | undefined
  const listeners = new Set<() => void>()
  const get = () => (value === undefined ? (value = initial()) : value)
  const subscribe = (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  return {
    get,
    set(v) {
      if (Object.is(v, get())) return
      value = v
      persist?.(v)
      for (const l of listeners) l()
    },
    use: () => useSyncExternalStore(subscribe, get, get),
  }
}

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

/** Cody folded the sidebar to its rail (this browser remembers). */
const collapsed = store<boolean>(() => readJson<unknown>(COLLAPSED_KEY, false) === true, (v) => writeJson(COLLAPSED_KEY, v))
export const useSidebarCollapsed = collapsed.use
export const setSidebarCollapsed = collapsed.set

/** The sidebar as a drawer over the chat: on a phone, or opened from the rail. */
const drawer = store(() => false)
export const useSidebarDrawer = drawer.use
export const openSidebarDrawer = () => drawer.set(true)
export const closeSidebarDrawer = () => drawer.set(false)

/** Where Cody last picked a task row from: of a task's two rows, the clicked one is drawn selected. */
const picked = store<{ taskId: string; spot: RowSpot } | null>(() => null)
export const usePickedRow = picked.use
/** The task a click on its row just opened, until the next task opened takes it (takeRowClick). */
let clicked: string | null = null
export function setPickedRow(taskId: string, spot: RowSpot) {
  clicked = taskId
  picked.set({ taskId, spot })
}
/** The task a row click opened last, once: a task opened from its own row is in view already, so nothing scrolls to it. */
export function takeRowClick() {
  const id = clicked
  clicked = null
  return id
}

/**
 * Sub-task trees Cody folded, by the task they're under. In memory only: a reload shows every tree open again, and
 * nothing about them is stored in the browser.
 */
const treeFolds = store<Readonly<Record<string, true>>>(() => ({}))
export const useTreeFolds = treeFolds.use
export const toggleTreeFold = (taskId: string) => treeFolds.set(withFold(treeFolds.get(), taskId, !treeFolds.get()[taskId]))
export const setTreeFolds = treeFolds.set

/** Each sub-task hidden in a folded tree, with the outermost folded row it's under (the one on screen). */
export function treeHidden(groups: readonly Pick<SidebarGroup, "rows">[], folds: Readonly<Record<string, true>>): Map<string, string> {
  const out = new Map<string, string>()
  const hide = (rows: readonly SidebarRow[] | undefined, under: string | null) => {
    for (const r of rows ?? []) {
      if (under) out.set(r.task.id, under)
      hide(r.kids, under ?? (folds[r.task.id] ? r.task.id : null))
    }
  }
  for (const g of groups) hide(g.rows, null)
  return out
}

/** Projects whose task list Cody folded (this browser remembers). */
const folds = store<Readonly<Record<string, true>>>(() => readJson(FOLDS_KEY, {}), (v) => writeJson(FOLDS_KEY, v))
export const useSidebarFolds = folds.use
/** Fold or unfold a group: a project's task list, or WAITING_FOLD. Only its chevron does this, never its name. */
export function toggleSidebarFold(key: string) {
  folds.set(withFold(folds.get(), key, !folds.get()[key]))
}
/** Unfold a group: the rail's "Waiting on you" widens the sidebar on it. */
export const unfoldSidebarGroup = (key: string) => folds.set(withFold(folds.get(), key, false))

/**
 * What the sidebar brings into view once it's a full list again: a group, unfolded, or a task's row with its sub-tasks.
 * A group: a project (a double click on its rail icon asks) or WAITING_FOLD (the rail's "Waiting on you" does);
 * `focus`: its head takes the focus there, for a rail button the keyboard pressed, which goes away with the rail. A
 * task's row: a double click on it that took it off screen asks. `opened`: a task opened from anywhere but its own row
 * (a link, the palette, Back): its row, unfolded out of its project and the trees above it, as soon as the list shows
 * (the drawer opens on it). In memory only; a new object each time, so asking again scrolls again.
 */
export type SidebarReveal = { group: string; focus: boolean } | { taskId: string; focus?: never } | { opened: string; focus?: never }
const reveal = store<SidebarReveal | null>(() => null)
export const useSidebarReveal = reveal.use
export function revealSidebarGroup(group: string, focus = false) {
  unfoldSidebarGroup(group)
  reveal.set({ group, focus })
}
export const revealSidebarTask = (taskId: string) => reveal.set({ taskId })
export const revealOpenedTask = (taskId: string) => reveal.set({ opened: taskId })
export const clearSidebarReveal = () => reveal.set(null)
/** The opened task's reveal, if it's still waiting for the list: another page opened since. */
export function dropOpenedReveal() {
  const r = reveal.get()
  if (r && "opened" in r) reveal.set(null)
}

/** Where a task's row sits under a project: the project, and the tasks it's nested under, outermost first. */
export function rowPath(groups: readonly Pick<SidebarGroup, "project" | "rows">[], taskId: string): { project: string; parents: string[] } | null {
  const find = (rows: readonly SidebarRow[] | undefined, parents: string[]): string[] | null => {
    for (const r of rows ?? []) {
      if (r.task.id === taskId) return parents
      const below = find(r.kids, [...parents, r.task.id])
      if (below) return below
    }
    return null
  }
  for (const g of groups) {
    const parents = find(g.rows, [])
    if (parents) return { project: g.project.id, parents }
  }
  return null
}

/** Unfold what hides a row at `path` (rowPath): its project's list and the sub-task trees above it. Whether any was folded. */
export function unfoldRowPath(path: { project: string; parents: readonly string[] }): boolean {
  const before = { groups: folds.get(), trees: treeFolds.get() }
  unfoldSidebarGroup(path.project)
  let trees = before.trees
  for (const id of path.parents) trees = withFold(trees, id, false)
  treeFolds.set(trees)
  return folds.get() !== before.groups || trees !== before.trees
}

/** Two taps on one row this close together are a double tap: a touch screen doesn't fire dblclick reliably. */
export const DOUBLE_TAP_MS = 350
/** The longest a double click usually takes (a desktop's default), for one whose first click took away what it clicked. */
export const DOUBLE_CLICK_MS = 500

/**
 * How far to scroll a list whose box is `list` so `item` is in view: none when it already is, enough to show all of it
 * when it fits, else to its top (its head, then as much of it as fits).
 */
export function revealScroll(list: { top: number; bottom: number }, item: { top: number; bottom: number }): number {
  if (item.top >= list.top && item.bottom <= list.bottom) return 0
  const fits = item.bottom - item.top <= list.bottom - list.top
  return item.top < list.top || !fits ? item.top - list.top : item.bottom - list.bottom
}

/** `folds` with `key` folded or not; the same object when nothing changes, so no one re-renders. */
export function withFold(folds: Readonly<Record<string, true>>, key: string, folded: boolean): Readonly<Record<string, true>> {
  if (Boolean(folds[key]) === folded) return folds
  const next = { ...folds }
  if (folded) next[key] = true
  else delete next[key]
  return next
}

/** The window is at least `px` wide, live. */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query)
      m.addEventListener("change", cb)
      return () => m.removeEventListener("change", cb)
    },
    () => matchMedia(query).matches,
    () => true,
  )
}
