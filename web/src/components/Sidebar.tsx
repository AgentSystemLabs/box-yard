// The left sidebar: the Coordinator (home), "Waiting on you", then each project and its live tasks. A
// project's name opens its Captain as the centre chat; only its chevron folds its tasks. Picking a task opens it in the
// side panel. Exactly one row looks selected (lib/sidebar.ts sidebarSelection); keyboard focus is an outline with no
// fill. A full column on a wide screen, a rail while a panel needs the room, a drawer on a phone. A project's tasks sit
// one step in from it, beside a faint guide line (NEST_PAD). A task's sub-tasks nest under it as a tree, each level one
// step in from its parent within a width budget (nestAt; its chevron folds them, in memory only; so does a double click on its
// row); picking one opens its chain of panels. A double click on a project's rail icon (two taps, to a finger) opens
// its Captain and also expands the sidebar on its tasks; the rail's "Waiting on you", there only while something
// waits, expands it on that section. Search is the palette (⌘K): on a desktop the top row's 🔍 opens it, on a phone the
// chats' headers do.
import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { Link } from "wouter"
import { AlarmClock, BarChart3, Check, ChevronDown, ChevronRight, Inbox, Keyboard, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Pin, Plus, Settings as SettingsIcon } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useCaptainState, useCoordinatorStatus, useProjects, useTasks } from "../lib/queries"
import { inInbox, usePendingCloses } from "../lib/inbox"
import { useMarkDone } from "../lib/markDone"
import { readyForReview } from "../lib/taskActions"
import { pinProject, unpinProject, useBarPins, useChatProjectFilter } from "../lib/projectBar"
import {
  DOUBLE_CLICK_MS,
  DOUBLE_TAP_MS,
  WAITING_CAP,
  WAITING_FOLD,
  cappedRows,
  captainKey,
  clearSidebarReveal,
  closeSidebarDrawer,
  coordinatorKey,
  dropOpenedReveal,
  inboxRows,
  keepGroups,
  keepRows,
  keepSelection,
  openSidebarDrawer,
  revealOpenedTask,
  revealScroll,
  revealSidebarGroup,
  revealSidebarTask,
  rowPath,
  setPickedRow,
  setSidebarCollapsed,
  sidebarGroups,
  sidebarSelection,
  takeRowClick,
  taskKey,
  toggleSidebarFold,
  toggleTreeFold,
  treeHidden,
  unfoldRowPath,
  unfoldSidebarGroup,
  usePickedRow,
  useSidebarFolds,
  useSidebarReveal,
  useTreeFolds,
  type RowSpot,
  type Selection,
  type SidebarGroup,
  type SidebarRow,
  type TreeCount,
} from "../lib/sidebar"
import { usePanels, viewOf } from "../lib/panelStack"
import { TREE_OPEN, TREE_TOGGLE, treeItems, useTreeView } from "../lib/treeView"
import { useSidebarReorder } from "./SidebarReorder"
import { FOCUS_SIDEBAR, focusSidebar } from "../lib/sidebarFocus"
import { chatRef, useChatHidden, useFocus } from "../lib/columns"
import { DismissButton, isDialogOpen } from "./Modal"
import { reducedMotion, scrollListTo } from "./StickyScroll"
import { APP_HOME, navigateApp, openChat, taskSessionHref } from "../lib/navigation"
import { focusComposer, keepFocusForPick, pickFocusesComposer } from "../lib/chatSwitch"
import { isTouchDevice } from "../lib/composer"
import { COORDINATOR_CHAT } from "../lib/threads"
import { useTiles } from "../lib/taskTiles"
import { useOpenSettings } from "./SettingsHost"
import { useOpenUsage, usePrefetchUsage } from "./UsageHost"
import { useOpenProjectSettings } from "../lib/projectSettings"
import { NewProjectDialog } from "./NewProjectDialog"
import { openShortcuts } from "./ShortcutsHelp"
import { BrandLogo } from "./BrandLogo"
import { SearchButton } from "./CommandPalette"
import { TaskStatusIcon, agentIconLabel, projectColorStyle } from "./TaskIcon"
import { TaskRowTitle } from "./TaskRowTitle"
import { AgentIcon, PrChip, STATUS, TAP_AREA, cx } from "./ui"

/** Keyboard focus: a white outline and no fill, so it's never mistaken for the selected row (or a hover). */
const FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-100"
/** The one selected row: a fill and a yellow bar on its left edge. Hover is a fainter fill and no bar. */
const SELECTED = "bg-zinc-800 text-zinc-50 shadow-[inset_3px_0_0_var(--color-yard-400)]"
/** A folded group holding the selected task: the bar, faint, and no fill. */
const INSIDE = "shadow-[inset_3px_0_0_color-mix(in_oklab,var(--color-yard-400)_40%,transparent)]"
/** One row's box, without its layout: 36px to a mouse, 44px to a finger. */
const ROW_BOX = cx("w-full min-h-9 rounded-lg px-2 text-left text-sm transition pointer-coarse:min-h-11", FOCUS)
const ROW = cx("flex items-center gap-2.5", ROW_BOX)
const ICON_BUTTON = cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)
/** A project row's small buttons (settings, pin): shown on hover, on focus anywhere in the row, on the selected row, and
 * always to a finger (there's no hover on a touch screen). They appear and go at once, with no fade (like the message
 * actions toolbar): only their hover colours ease. */
const ROW_TOOL = cx("grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100 focus-visible:opacity-100", FOCUS)

/*
 * The column and the drawer are a tree to the keyboard and a screen reader (lib/treeView.ts): the Coordinator, "Waiting
 * on you", each project and More projects at the top level; a project's tasks, the waiting rows and the other projects
 * one level in; each sub-task level one more. A row is a treeitem, one tab stop for the whole tree, holding the buttons a
 * mouse or a finger uses as before: the one its Enter clicks (it names the row), its chevron, and its tools (pin,
 * settings, Mark done), which the keyboard reaches elsewhere (the palette's Pin and Unpin, the Captain's and the task's
 * headers). A group's children follow it in a role="group" beside it, not inside it, so the row's name and its focus
 * ring are its own. Between the tree and a row there are only plain divs: Chromium shows a treeitem under anything else
 * (a section, say) as a generic. The rail's tree (Rails.tsx) draws the same rows as plain buttons. PR numbers are
 * separate links with their own tab stops.
 */
const InTree = createContext(false)

/**
 * A row's treeitem attributes: its key, its level, whether it's unfolded (none: it has no children), whether it's the
 * page on screen, and its open button's id, which names it. The tree writes its place among its siblings and the tab
 * stop.
 */
function treeItem(key: string, level: number, label: string, { expanded, current }: { expanded?: boolean | null; current?: boolean } = {}) {
  return {
    role: "treeitem",
    "data-tree-key": key,
    "aria-level": level,
    "aria-expanded": expanded ?? undefined,
    "aria-current": current ? ("page" as const) : undefined,
    "aria-labelledby": label,
    tabIndex: -1,
  }
}
/** A treeitem's open button: what Enter clicks, and the row's name. Out of the Tab order, as is every button in a row. */
const openPart = (id: string) => ({ id, tabIndex: -1, [TREE_OPEN]: "" })
/** A treeitem's chevron: what →, ← and Space click. */
const TOGGLE_PART = { tabIndex: -1, [TREE_TOGGLE]: "" }
/** "Waiting on you" and More projects: their head only folds, so Enter and the arrows click the same button. */
const OPEN_TOGGLE_PART = { ...TOGGLE_PART, [TREE_OPEN]: "" }
/** The tree's keys for rows that aren't a chat or a task. */
const WAITING_HEAD = "group:waiting"
const WAITING_MORE = "waiting:more"
const MORE_HEAD = "group:more"

/** Where Tab enters the tree: the row selected, else the folded group or tree row that holds it. */
function currentTreeKey(selection: Selection) {
  if (selection.selected) return selection.selected
  const inside = selection.inside
  if (!inside) return null
  if (inside === WAITING_FOLD) return WAITING_HEAD
  return inside.startsWith("task:") ? inside : captainKey(inside)
}

/**
 * `value`, sharing with the last one whatever `keep` finds unchanged (lib/sidebar.ts keepGroups), so the memo'd rows
 * and groups below skip a render when a task update isn't theirs. `keep` runs only when `value` itself changed.
 */
function useKept<T>(value: T, keep: (prev: T | undefined, next: T) => T): T {
  const last = useRef<{ value: T; kept: T } | null>(null)
  if (!last.current || last.current.value !== value) last.current = { value, kept: keep(last.current?.kept, value) }
  return last.current.kept
}

/** The Inbox's count ("Waiting on you"), and whether anything in it asks Cody (the badge goes amber). */
function useInboxCount() {
  const tasks = useTasks()
  const closing = usePendingCloses()
  return useMemo(() => {
    let count = 0
    let asks = false
    for (const t of tasks.data ?? []) {
      if (!inInbox(t, closing)) continue
      count++
      if (t.status === "needs_input") asks = true
    }
    return { count, asks }
  }, [tasks.data, closing])
}

function Badge({ count, asks, className }: { count: number; asks: boolean; className?: string }) {
  if (!count) return null
  return (
    <span className={cx("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tracking-normal tabular-nums", asks ? "bg-amber-400 text-zinc-950" : "bg-zinc-700 text-zinc-100", className)}>
      {count}
    </span>
  )
}

/** Where the chat header's menu button opens the sidebar on a phone. Its badge counts what's waiting on Cody. */
export function SidebarMenuButton({ className }: { className?: string }) {
  const inbox = useInboxCount()
  return (
    <button
      type="button"
      onClick={openSidebarDrawer}
      aria-label={inbox.count ? `Projects and tasks, ${inbox.count} waiting on you` : "Projects and tasks"}
      title="Projects and tasks"
      className={cx("relative -ml-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-300 hover:bg-zinc-900", className)}
    >
      <Menu className="h-5 w-5" />
      <Badge count={inbox.count} asks={inbox.asks} className="absolute top-0.5 right-0 h-4 min-w-4 px-1 text-[10px] ring-2 ring-zinc-950" />
    </button>
  )
}

/** The click that picked a row: Enter on a focused row clicks it too. */
type PickEvent = MouseEvent<HTMLElement>
type Pick = { coordinator: (e?: PickEvent) => void; captain: (projectId: string, e?: PickEvent) => void; task: (taskId: string, spot: RowSpot, e?: PickEvent) => void }

/** A click from a finger or a pen, whose double tap fires no dblclick to count on; not a mouse's, nor a key's (detail 0). */
function isTap(e: PickEvent) {
  if (e.detail === 0) return false
  const type = (e.nativeEvent as Partial<PointerEvent>).pointerType
  return type ? type !== "mouse" : isTouchDevice()
}
/** How far apart a double click's two clicks may land, in px: a finger's taps wander more than a mouse's. */
const CLICK_SLOP = 24

/**
 * A tree row's double click: the first click opens its task as any click does, never waiting to see if a second
 * follows; the double click (two taps within DOUBLE_TAP_MS, to a finger) also folds or unfolds its sub-tasks. `on`: the
 * row has sub-tasks.
 */
function useTreeDoubleClick(taskId: string, on: boolean) {
  /** This row's last click; `toggled` when it was the second tap, which folded the tree already. */
  const last = useRef<{ at: number; toggled: boolean } | null>(null)
  return {
    onClick: (e: PickEvent) => {
      if (!on || e.detail === 0) return
      const tap = isTap(e)
      const before = last.current
      const second = tap && before !== null && !before.toggled && e.timeStamp - before.at <= DOUBLE_TAP_MS
      last.current = { at: e.timeStamp, toggled: second }
      if (second) toggleTreeFold(taskId)
      // The click may take the row off screen, so a second one would land on whatever is there (useStrayTreeClicks).
      treeClick = second ? null : { taskId, row: e.currentTarget, at: e.timeStamp, x: e.clientX, y: e.clientY, within: tap ? DOUBLE_TAP_MS : DOUBLE_CLICK_MS }
    },
    onDoubleClick: () => {
      if (!on) return
      // A browser that fires dblclick on a double tap too: the second tap folded it already.
      if (last.current?.toggled) return void (last.current = null)
      toggleTreeFold(taskId)
    },
  }
}

/** The last click on a tree row with sub-tasks, for a double click whose first click took the row off screen. */
let treeClick: { taskId: string; row: Element; at: number; x: number; y: number; within: number; taken?: true } | null = null

/**
 * A double click on a tree row whose first click took the row off screen (the drawer closed on the pick, or the column
 * gave way to the rail beside the panel it opened): the second click lands on whatever is there now. It doesn't act
 * there, nor does its press take the focus; it folds or unfolds the tree and opens the drawer on it, in view. Mounted
 * once, by the app's shell, so it outlives the drawer.
 */
export function useStrayTreeClicks() {
  useEffect(() => {
    const near = (e: globalThis.MouseEvent, last: NonNullable<typeof treeClick>) =>
      e.timeStamp - last.at <= last.within && Math.abs(e.clientX - last.x) <= CLICK_SLOP && Math.abs(e.clientY - last.y) <= CLICK_SLOP
    const stray = (e: globalThis.MouseEvent) => {
      const last = treeClick
      return last && !last.taken && !last.row.isConnected && near(e, last) ? last : null
    }
    const swallow = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const press = (e: globalThis.MouseEvent) => {
      if (stray(e)) e.preventDefault()
    }
    const click = (e: globalThis.MouseEvent) => {
      const last = stray(e)
      if (!last) return
      swallow(e)
      last.taken = true
      toggleTreeFold(last.taskId)
      revealSidebarTask(last.taskId)
      openSidebarDrawer()
    }
    // The dblclick after it goes too: a rail icon under it would expand the sidebar on its own project.
    const double = (e: globalThis.MouseEvent) => {
      const last = treeClick
      if (!last?.taken || !near(e, last)) return
      swallow(e)
      treeClick = null
    }
    window.addEventListener("mousedown", press, true)
    window.addEventListener("click", click, true)
    window.addEventListener("dblclick", double, true)
    return () => {
      window.removeEventListener("mousedown", press, true)
      window.removeEventListener("click", click, true)
      window.removeEventListener("dblclick", double, true)
      treeClick = null
    }
  }, [])
}

/**
 * What a click does, the same in the column, the rail and the drawer (which closes after it). On a desktop the
 * Coordinator, a Captain, a task or a sub-task shows on its own, beside the pins (lib/navigation.ts showOnly); on a
 * phone a task opens in the rightmost panel's place and a chat as openChat says.
 */
function usePick(drawer: boolean): Pick {
  return useMemo(() => {
    // The picked chat's box takes the focus, so Cody can type to it at once: the centre's for the Coordinator or a
    // Captain, the side panel's for a task, as soon as it mounts. Not on a touch screen, where the keyboard would cover
    // what was just picked, nor on a modified click (lib/chatSwitch.ts pickFocusesComposer). Until then the press
    // leaves the focus where it is (keepFocusForPick on each row).
    const done = (chat: string, e?: PickEvent) => {
      if (drawer) closeSidebarDrawer()
      if (pickFocusesComposer(e?.nativeEvent)) focusComposer(chat)
    }
    return {
      coordinator: (e) => {
        openChat(null)
        done(COORDINATOR_CHAT, e)
      },
      captain: (projectId, e) => {
        openChat(projectId)
        done(projectId, e)
      },
      task: (taskId, spot, e) => {
        setPickedRow(taskId, spot)
        navigateApp(taskSessionHref(taskId))
        done(taskId, e)
      },
    }
  }, [drawer])
}

/**
 * The centre chat's project (null: the Coordinator), whether the panels hide it, and the panel Cody looks at: the item
 * opened last, else the rightmost; none when it's the chat (lib/columns.ts).
 */
function useLookedAt() {
  const current = useChatProjectFilter()
  const panels = usePanels()
  const focus = useFocus()
  const chatHidden = useChatHidden() && panels.length > 0
  const lookedAt = focus !== null && panels.includes(focus) ? focus : focus === chatRef(current) && !chatHidden ? undefined : panels.at(-1)
  const overlay = useMemo(() => (lookedAt ? viewOf(lookedAt) : null), [lookedAt])
  return { current, chatHidden, overlay }
}

/**
 * A task opened from anywhere but its own row (a link in a chat, a notice, the palette, the Inbox, a PR chip, Back or
 * Forward, the address bar): the sidebar unfolds to its row and brings it into view, at once in the column, or when the
 * list next shows (the drawer opening, the rail widening). Mounted once, by the app's shell, so it sees what opens
 * while the drawer is shut.
 */
export function RevealOpenedTask() {
  const { overlay } = useLookedAt()
  const taskId = overlay?.kind === "session" ? overlay.id : null
  const last = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (taskId === last.current) return
    last.current = taskId
    const clicked = takeRowClick()
    if (taskId && taskId !== clicked) revealOpenedTask(taskId)
    else dropOpenedReveal()
  }, [taskId])
  return null
}

/**
 * The sidebar. `rail`: the narrow strip of icons (Cody folded it, or a panel needs the room); `onExpand` widens it
 * again. `drawer`: drawn inside the phone drawer, which a pick closes.
 */
export const Sidebar = memo(function Sidebar({ rail = false, drawer = false, onExpand }: { rail?: boolean; drawer?: boolean; onExpand?: () => void }) {
  const projects = useProjects()
  const tasks = useTasks()
  const pins = useBarPins()
  const closing = usePendingCloses()
  const { current, chatHidden, overlay } = useLookedAt()
  const folds = useSidebarFolds()
  const treeFolds = useTreeFolds()
  const picked = usePickedRow()
  const inbox = useInboxCount()
  const pick = usePick(drawer)
  const openSettings = useOpenSettings()
  const openUsage = useOpenUsage()
  const prefetchUsage = usePrefetchUsage()
  const [creating, setCreating] = useState(false)
  const [allWaiting, setAllWaiting] = useState(false)
  const coordinatorId = useId()
  const emptyId = useId()

  const all = useMemo(
    () => sidebarGroups(projects.data ?? [], tasks.data ?? [], pins, { current, closing }),
    [projects.data, tasks.data, pins, current, closing],
  )
  // A task update changes one task: everything else stays the same objects, so only its row re-renders.
  const groups = { shown: useKept(all.shown, keepGroups), others: useKept(all.others, keepGroups) }
  const openTask = overlay?.kind === "session" ? overlay.id : null
  const waitingAll = useKept(
    useMemo(() => inboxRows(tasks.data ?? [], (t) => inInbox(t, closing)), [tasks.data, closing]),
    keepRows,
  )
  const waiting = useMemo(() => cappedRows(waitingAll, { expanded: allWaiting, keep: openTask }), [waitingAll, allWaiting, openTask])
  const computed = useMemo(() => {
    const projectOf = new Map<string, string>()
    const add = (rows: readonly SidebarRow[] | undefined, project: string) => {
      for (const r of rows ?? []) {
        projectOf.set(r.task.id, project)
        add(r.kids, project)
      }
    }
    for (const g of groups.shown) add(g.rows, g.project.id)
    // The rail lists no tasks, so there an open task's project is where it is "inside". A hidden chat isn't behind.
    const selection = sidebarSelection({
      centre: current,
      panel: overlay,
      picked,
      waiting: new Set(rail ? [] : waiting.shown.map((r) => r.task.id)),
      projectOf,
      folds: rail ? Object.fromEntries(groups.shown.map((g) => [g.project.id, true as const])) : folds,
      hiddenIn: rail ? undefined : treeHidden(groups.shown, treeFolds),
    })
    return chatHidden ? { ...selection, behind: null } : selection
  }, [current, overlay, picked, rail, waiting.shown, groups.shown, folds, treeFolds, chatHidden])
  const selection = useKept(computed, keepSelection)
  const { focusCurrent, ...tree } = useTreeView(currentTreeKey(selection))
  const reorder = useSidebarReorder(tree, groups)
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    const take = (e: Event) => {
      const nav = navigation.current
      if (e.defaultPrevented || !nav || !nav.checkVisibility() || (isDialogOpen() && !drawer)) return
      if (focusCurrent()) e.preventDefault()
      else if (rail && onExpand && (e as CustomEvent<{ expand: boolean }>).detail.expand) {
        e.preventDefault()
        onExpand()
        requestAnimationFrame(() => focusSidebar(false))
      }
    }
    window.addEventListener(FOCUS_SIDEBAR, take)
    return () => {
      window.removeEventListener(FOCUS_SIDEBAR, take)
    }
  }, [focusCurrent, rail, drawer, onExpand])

  // A double click on a project's rail icon opens its Captain (the first click does that at once, never waiting to see
  // if a second follows) and expands the sidebar, that project's tasks unfolded and in view.
  const expand = useRef(onExpand)
  expand.current = onExpand
  /** The rail's last Captain click, for the double click it may start. */
  const railClick = useRef<{ projectId: string; at: number; x: number; y: number } | null>(null)
  const expandTo = useCallback((projectId: string) => {
    railClick.current = null
    revealSidebarGroup(projectId)
    expand.current?.()
  }, [])
  // A finger's double tap is two clicks on one icon, close together.
  const railPick = useCallback(
    (projectId: string, e: PickEvent) => {
      const last = railClick.current
      railClick.current = { projectId, at: e.timeStamp, x: e.clientX, y: e.clientY }
      pick.captain(projectId, e)
      if (isTap(e) && last?.projectId === projectId && e.timeStamp - last.at <= DOUBLE_TAP_MS) expandTo(projectId)
    },
    [pick, expandTo],
  )
  /**
   * When the first click took the rail away (it closed the task panel that needed the room, so the column came back),
   * the second lands on whatever row is there now: it only brings the project into view, and the press keeps the focus.
   */
  const secondClick = (e: PickEvent) => {
    const last = railClick.current
    const near = last && e.timeStamp - last.at <= DOUBLE_CLICK_MS && Math.abs(e.clientX - last.x) <= CLICK_SLOP && Math.abs(e.clientY - last.y) <= CLICK_SLOP
    return near ? last.projectId : null
  }

  // A group asked to be revealed (a project, or Waiting on you), or a tree row: it scrolls into view once the full list is
  // on screen (this column, or the drawer opened in the rail's place). A group's head row takes the focus when the keyboard pressed the rail button that asked, since that
  // button went with the rail; a click leaves the focus where it was (in the drawer, the drawer's own first stop).
  // A task opened elsewhere than its row (RevealOpenedTask): its project and the trees above it unfold, then its row
  // scrolls just into view, gliding unless Cody prefers reduced motion. Only the list moves, never the page or a panel,
  // and the focus stays where it is. A list that has just come (the column back from the rail, the drawer opening)
  // shows its current row, and anything it reveals before its first paint, at once: there's nothing to glide from.
  const reveal = useSidebarReveal()
  const list = useRef<HTMLDivElement>(null)
  /** The list was on screen at the last commit; `fresh`: its current row isn't revealed yet; `painted`: it has been. */
  const shown = useRef({ list: false, fresh: false, painted: false })
  useLayoutEffect(() => {
    const box = list.current
    const s = shown.current
    if (box && !s.list) {
      Object.assign(s, { fresh: true, painted: false })
      requestAnimationFrame(() => (s.painted = true))
    }
    s.list = box !== null
    if (!box) return
    if (reveal && !("opened" in reveal)) {
      clearSidebarReveal()
      s.fresh = false
      const [attr, id] = "taskId" in reveal ? ["data-tree-node", reveal.taskId] : ["data-sidebar-group", reveal.group]
      const target = [...box.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.getAttribute(attr) === id)
      if (target) box.scrollTop += revealScroll(box.getBoundingClientRect(), target.getBoundingClientRect())
      if (reveal.focus) target?.querySelector<HTMLElement>("[role=treeitem]")?.focus({ preventScroll: true })
      return
    }
    let key: string | null
    if (reveal) {
      const id = reveal.opened
      // A task the list doesn't know yet (still loading, or just started) waits for it.
      if (!tasks.data?.some((t) => t.id === id)) return
      const isRow = (k: string | null) => k === taskKey(id, "project") || k === taskKey(id, "waiting")
      if (!isRow(selection.selected)) {
        // Unfolded, the list draws again and this runs again, its row on screen.
        const path = rowPath(groups.shown, id)
        if (path && unfoldRowPath(path)) return
        // Under no project the list shows (one moved to More projects), only in Waiting on you.
        if (!path && selection.inside === WAITING_FOLD) {
          unfoldSidebarGroup(WAITING_FOLD)
          return
        }
      }
      clearSidebarReveal()
      key = isRow(selection.selected) ? selection.selected : null
    } else if (s.fresh) key = currentTreeKey(selection)
    else return
    s.fresh = false
    const row = treeItems(box).find((el) => el.getAttribute("data-tree-key") === key)
    if (row) scrollListTo(box, row, { block: "nearest", behavior: s.painted && !reducedMotion() ? "smooth" : "auto" })
  })

  if (rail)
    return (
      <nav ref={navigation} aria-label="Projects and tasks" className="flex h-full w-14 flex-col items-center gap-1 bg-zinc-950 py-2">
        <button type="button" onClick={onExpand} title="Show the sidebar" aria-label="Show the sidebar" className={ICON_BUTTON}>
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <CoordinatorRailButton mark={mark(selection, coordinatorKey)} onClick={pick.coordinator} />
        {/* Only while something waits: the section it opens is gone when nothing does. It widens the sidebar the way
            "Show the sidebar" does (the column, or the drawer while a panel needs the room), on that section. */}
        {inbox.count > 0 && (
          <RailButton
            label={`Waiting on you, ${inbox.count} ${inbox.count === 1 ? "task" : "tasks"}`}
            onClick={(e) => {
              revealSidebarGroup(WAITING_FOLD, e.currentTarget === document.activeElement)
              onExpand?.()
            }}
          >
            <Inbox className="h-4 w-4" />
            <Badge count={inbox.count} asks={inbox.asks} className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[10px] ring-2 ring-zinc-950" />
          </RailButton>
        )}
        <div className="my-1 h-px w-6 bg-zinc-800" />
        <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {groups.shown.map((g) => (
            <RailProject key={g.project.id} group={g} mark={mark(selection, captainKey(g.project.id), g.project.id)} onPick={railPick} onExpand={expandTo} />
          ))}
        </div>
        <button type="button" onClick={() => openSettings("orchestrator")} title="Settings" aria-label="Settings" className={ICON_BUTTON}>
          <SettingsIcon className="h-4 w-4" />
        </button>
      </nav>
    )

  const coordinator = mark(selection, coordinatorKey)
  /** Why the list has no project: none yet, or none pinned or busy (the rest are under More projects). */
  const empty = groups.shown.length || !projects.data ? null : projects.data.length ? "unpinned" : "none"
  return (
    <nav
      ref={navigation}
      aria-label="Projects and tasks"
      className={cx("@container/side flex h-full w-full flex-col bg-zinc-950", drawer && "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]")}
      onMouseDownCapture={(e) => {
        if (secondClick(e)) e.preventDefault()
      }}
      onClickCapture={(e) => {
        const projectId = secondClick(e)
        if (!projectId) return
        e.preventDefault()
        e.stopPropagation()
        expandTo(projectId)
      }}
    >
      <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-zinc-900 pr-1.5 pl-3.5">
        {/* The logo goes home: the Coordinator, picked as its row below picks it (the drawer closes too). A ⌘/Ctrl or
            middle click opens the app's home, the Coordinator, in a new tab: wouter's Link leaves those to the browser. */}
        <Link
          href={APP_HOME}
          onClick={(e) => {
            e.preventDefault()
            pick.coordinator(e)
          }}
          onMouseDown={keepFocusForPick}
          aria-label="Box Yard: go to Coordinator"
          title="Box Yard: go to Coordinator"
          className={cx(TAP_AREA, "-ml-1.5 flex h-9 min-w-0 flex-1 items-center rounded-lg px-1.5 hover:bg-zinc-900", FOCUS)}
        >
          <BrandLogo className="min-w-0 flex-1" />
        </Link>
        {drawer ? (
          <DismissButton kind="close" onClick={closeSidebarDrawer} label="Close the sidebar" title="Close (Esc)" />
        ) : (
          <>
            {/* Search is the palette; on a phone the chats' headers have its 🔍. */}
            <SearchButton className={ICON_BUTTON} />
            <button type="button" onClick={() => setSidebarCollapsed(true)} title="Fold the sidebar" aria-label="Fold the sidebar" className={ICON_BUTTON}>
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {/* With no project yet, the tree is the Coordinator alone; what to do about it is under it, not one of its rows. */}
      <InTree.Provider value>
        <div
          {...reorder.tree}
          role="tree"
          aria-label="Projects and tasks"
          aria-describedby={empty === "unpinned" ? emptyId : undefined}
          className={cx("flex min-h-0 flex-col", empty !== "none" && "flex-1")}
        >
          <div className="shrink-0 px-2 pt-2">
            <div {...treeItem(coordinatorKey, 1, coordinatorId, { current: coordinator === "selected" })} className={cx("rounded-lg", FOCUS)}>
              <button
                type="button"
                onClick={pick.coordinator}
                onMouseDown={keepFocusForPick}
                {...openPart(coordinatorId)}
                className={cx(ROW, "font-medium", coordinator === "selected" ? SELECTED : "text-zinc-300 hover:bg-zinc-900")}
              >
                <CoordinatorIcon />
                <span className="min-w-0 flex-1 truncate">Coordinator</span>
                {coordinator === "behind" && <BehindMark />}
              </button>
            </div>
          </div>

          <div ref={list} className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto px-2", empty !== "none" && "pb-3")}>
            <WaitingOnYou
              rows={waiting.shown}
              total={waitingAll.length}
              hidden={waiting.hidden}
              asks={inbox.asks}
              folded={Boolean(folds[WAITING_FOLD])}
              expanded={allWaiting}
              onExpand={setAllWaiting}
              selection={selection}
              onPick={pick.task}
            />
            {groups.shown.map((g) => (
              <ProjectGroup key={g.project.id} group={g} folded={Boolean(folds[g.project.id])} treeFolds={treeFolds} selection={selection} pick={pick} />
            ))}
            {empty === "unpinned" && (
              <p id={emptyId} role="none" className="px-2 pt-4 text-xs text-zinc-500">
                No project is pinned or busy. Pin one below.
              </p>
            )}
            <MoreProjects groups={groups.others} selection={selection} onPick={pick.captain} />
          </div>
        </div>
      </InTree.Provider>
      {reorder.layer}
      {empty === "none" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <NoProjects onCreate={() => setCreating(true)} />
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-t border-zinc-900 px-2 py-1.5">
        <button type="button" onClick={() => setCreating(true)} title="New project" aria-label="New project" className={ICON_BUTTON}>
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            navigateApp("/schedules")
            if (drawer) closeSidebarDrawer()
          }}
          title="Schedules"
          aria-label="Schedules"
          className={ICON_BUTTON}
        >
          <AlarmClock className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            openUsage()
            if (drawer) closeSidebarDrawer()
          }}
          onPointerEnter={() => prefetchUsage()}
          onPointerDown={() => prefetchUsage()}
          onFocus={() => prefetchUsage()}
          title="Usage"
          aria-label="Usage"
          className={ICON_BUTTON}
          data-testid="sidebar-usage"
        >
          <BarChart3 className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => openSettings("orchestrator")} title="Settings" aria-label="Settings" className={cx(ICON_BUTTON, "ml-auto")}>
          <SettingsIcon className="h-4 w-4" />
        </button>
        {/* A keyboard's list, so not on a touch screen; the palette's "Keyboard shortcuts" command still opens it there. */}
        <button type="button" onClick={openShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" className={cx(ICON_BUTTON, "pointer-coarse:hidden")}>
          <Keyboard className="h-4 w-4" />
        </button>
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </nav>
  )
})

/** How a row is marked: the one selected row, the chat behind the panel, a folded group holding the selection. */
type Mark = "selected" | "behind" | "inside" | null
function mark(selection: Selection, key: string, group?: string): Mark {
  if (selection.selected === key) return "selected"
  if (selection.behind === key) return "behind"
  if (group && selection.inside === group) return "inside"
  return null
}

/** The chat still open in the centre, behind the side panel: a small mark, never the selected fill. */
function BehindMark() {
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center text-zinc-500" title="Open in the centre, behind the panel">
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only">, open behind the panel</span>
    </span>
  )
}

/** The Coordinator's actual state, shared by the expanded row, collapsed rail and chat header. */
function CoordinatorIcon() {
  const state = useCoordinatorStatus()
  return <AgentIcon announce={false} kind="coordinator" {...state} error={Boolean(state.error)} tile />
}

function CoordinatorRailButton({ mark, onClick }: { mark: Mark; onClick: (e: PickEvent) => void }) {
  const state = useCoordinatorStatus()
  const status = agentIconLabel(state)
  return (
    <RailButton label={`Coordinator${status ? `, ${status}` : ""}`} mark={mark} onClick={onClick}>
      <AgentIcon announce={false} kind="coordinator" {...state} error={Boolean(state.error)} tile />
    </RailButton>
  )
}

/** `captain`: the project whose Captain it opens, so a press starts rendering its chat (lib/captainPrerender.ts). */
function RailButton({ label, title = label, mark, captain, onClick, onDoubleClick, children }: {
  label: string
  title?: string
  mark?: Mark
  captain?: string
  onClick: (e: PickEvent) => void
  onDoubleClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseDown={keepFocusForPick}
      data-open-captain={captain}
      title={title}
      aria-label={mark === "behind" ? `${label}, open behind the panel` : label}
      aria-current={mark === "selected" ? "page" : undefined}
      className={cx(
        "relative grid h-10 w-10 shrink-0 place-items-center rounded-lg transition pointer-coarse:h-11 pointer-coarse:w-11",
        FOCUS,
        mark === "selected" ? SELECTED : cx("text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200", mark === "inside" && INSIDE, mark === "behind" && "text-zinc-200"),
      )}
    >
      {children}
    </button>
  )
}

/**
 * A Captain on the rail: the same icon and status as its expanded row. A click opens its Captain; a double click (or tap) also expands the sidebar on its tasks.
 */
const RailProject = memo(function RailProject({ group, mark, onPick, onExpand }: { group: SidebarGroup; mark: Mark; onPick: (projectId: string, e: PickEvent) => void; onExpand: (projectId: string) => void }) {
  const color = useTiles().colors.get(group.project.id)
  const state = useCaptainState(group.project.id).data
  const status = agentIconLabel(state)
  const label = `${group.project.name} Captain${status ? `, ${status}` : ""}`
  return (
    <RailButton
      label={label}
      title={`${label} (double-click to expand)`}
      mark={mark}
      captain={group.project.id}
      onClick={(e) => onPick(group.project.id, e)}
      onDoubleClick={() => onExpand(group.project.id)}
    >
      <AgentIcon announce={false} projectId={group.project.id} color={color} busy={Boolean(state?.busy)} compacting={state?.compacting} error={Boolean(state?.error)} tile />
    </RailButton>
  )
})

/**
 * A project: one row that is its Captain (the name opens it as the centre chat), with a chevron that only folds its
 * tasks, its settings and its pin; then its live tasks. Folded, the row counts them, with an amber dot if one asks.
 */
const ProjectGroup = memo(function ProjectGroup({ group, folded, treeFolds, selection, pick }: { group: SidebarGroup; folded: boolean; treeFolds: Readonly<Record<string, true>>; selection: Selection; pick: Pick }) {
  const color = useTiles().colors.get(group.project.id)
  const captain = useCaptainState(group.project.id).data
  const busy = Boolean(captain?.busy)
  const { project, rows } = group
  const state = mark(selection, captainKey(project.id), project.id)
  const tasksId = `sidebar-tasks-${project.id}`
  const nameId = useId()
  return (
    <div data-sidebar-group={project.id} className="pt-1">
      <div
        {...treeItem(captainKey(project.id), 1, nameId, { expanded: rows.length ? !folded : null, current: state === "selected" })}
        className={cx("group/head flex items-center rounded-lg transition", FOCUS, state === "selected" ? SELECTED : cx("hover:bg-zinc-900", state === "inside" && INSIDE))}
      >
        <button
          type="button"
          onClick={() => toggleSidebarFold(project.id)}
          {...TOGGLE_PART}
          aria-expanded={!folded}
          aria-controls={folded ? undefined : tasksId}
          aria-label={`${folded ? "Show" : "Hide"} ${project.name} tasks`}
          title={folded ? "Show its tasks" : "Hide its tasks"}
          className={cx("grid h-9 w-6 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:text-zinc-100 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)}
        >
          {folded ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={(e) => pick.captain(project.id, e)}
          onMouseDown={keepFocusForPick}
          // A press starts rendering its chat, hidden, so the click only shows it (lib/captainPrerender.ts).
          data-open-captain={project.id}
          {...openPart(nameId)}
          title={`Talk to the ${project.name} Captain${busy ? " (working)" : ""}`}
          className={cx("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pr-1.5 text-left text-sm font-medium pointer-coarse:min-h-11", FOCUS, state === "selected" ? "text-zinc-50" : "text-zinc-200")}
        >
          <AgentIcon announce={false} projectId={project.id} color={color} busy={busy} compacting={captain?.compacting} error={Boolean(captain?.error)} tile />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="sr-only">, Captain</span>
          {folded && rows.length > 0 && (
            <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-zinc-800/80 px-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">
              {group.needs > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
              {rows.length}
              <span className="sr-only"> {rows.length === 1 ? "task" : "tasks"}{group.needs > 0 ? `, ${group.needs} asking you` : ""}</span>
            </span>
          )}
          {state === "behind" && <BehindMark />}
        </button>
        <ProjectSettingsButton id={project.id} name={project.name} reveal="group-hover/head:opacity-100 group-focus-within/head:opacity-100" shown={state === "selected"} />
        <PinButton id={project.id} name={project.name} pinned={group.pin === "pinned"} reveal="group-hover/head:opacity-100 group-focus-within/head:opacity-100" shown={state === "selected"} />
      </div>
      {!folded && rows.length > 0 && (
        <div id={tasksId} role="group" aria-label={`${project.name} tasks`} className={cx("space-y-px pt-px", PROJECT_TASKS)}>
          {rows.map((r) =>
            r.kids ? (
              <TreeNode key={r.task.id} row={r} depth={0} folds={treeFolds} selection={selection} onPick={pick.task} guides />
            ) : (
              <TaskRow key={r.task.id} row={r} spot="project" selected={selection.selected === taskKey(r.task.id, "project")} onPick={pick.task} />
            ),
          )}
        </div>
      )}
    </div>
  )
})

/** Pin keeps a quiet project in the list; unpinned, it moves to More projects. Drawn like the settings button. */
function PinButton({ id, name, pinned, reveal, shown }: { id: string; name: string; pinned: boolean; reveal: string; shown?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => (pinned ? unpinProject(id) : pinProject(id))}
      title={pinned ? `Unpin ${name}: it moves to More projects` : `Pin ${name}: it stays here when it's quiet`}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      aria-pressed={pinned}
      tabIndex={-1}
      className={cx(ROW_TOOL, !shown && cx("opacity-0", reveal))}
    >
      <Pin className={cx("h-3.5 w-3.5", pinned && "fill-current")} aria-hidden />
    </button>
  )
}

const META_TONE: Partial<Record<Task["status"], string>> = { needs_input: "text-amber-300", failed: "text-red-300", working: "text-sky-300", starting: "text-sky-300", pr_ready: "text-emerald-300" }

/**
 * A task: opens it in the side panel. `spot` says which list it's in (a task can be in "Waiting on you" and under its
 * project), so the copy Cody clicked is the one drawn selected. `project` adds context to the tooltip. One
 * ready for Cody's review, or failed, ends with Mark done's ✓. Its icon names the state, with a still dot when it
 * asks or failed. Working titles carry the motion. A PR number links to
 * GitHub beside the task button, so each action has its own keyboard target.
 */
export const TaskRow = memo(function TaskRow({ row, spot, selected, onPick, project }: { row: SidebarRow; spot: RowSpot; selected: boolean; onPick: Pick["task"]; project?: { name: string; color: Parameters<typeof projectColorStyle>[0]; icon?: string | null } }) {
  const { task, dim, meta } = row
  const label = stateLabel(task)
  const prMeta = Boolean(task.prUrl)
  const tree = useContext(InTree)
  const id = useId()
  return (
    <div
      {...(tree ? treeItem(taskKey(task.id, spot), 2, id, { current: selected }) : undefined)}
      className={cx("flex items-center rounded-lg transition", tree && FOCUS, selected ? SELECTED : dim ? "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300" : "text-zinc-300 hover:bg-zinc-900")}
    >
      <button
        type="button"
        onClick={(e) => onPick(task.id, spot, e)}
        onMouseDown={keepFocusForPick}
        data-open-task={task.id}
        {...(tree ? openPart(id) : { "aria-current": selected ? ("page" as const) : undefined })}
        title={`${task.title} · ${label}${project ? ` · ${project.name}` : ""}`}
        className={cx(
          // One line at every width; the title gives space to the separate PR and check targets.
          ROW_BOX,
          "grid min-w-0 flex-1 content-center items-center gap-x-2.5 py-1",
          prMeta || !meta ? "grid-cols-[1.25rem_minmax(0,1fr)]" : "grid-cols-[1.25rem_minmax(0,1fr)_auto]",
          // Under a project, a task's icon sits past the chevron's column and its list's indent (NEST_PAD): in the
          // sidebar, under the project's name; in the rail's tree, which sets none, under its tile.
          spot === "project" && NEST_PAD,
        )}
      >
        <TaskRowTitle title={task.title} status={task.status} />
        <RowIcon task={task} label={label} dim={dim} />
        {!prMeta && meta && <span aria-hidden={saysState(meta, label)} className={cx("col-start-3 row-start-1 text-xs leading-5 tabular-nums @max-[13rem]/side:hidden", (!dim && META_TONE[task.status]) || "text-zinc-500")}>{meta}</span>}
      </button>
      {prMeta && <PrChip task={task} variant="number" className={cx(FOCUS, "mr-2 shrink-0 text-xs leading-5 tabular-nums pointer-coarse:min-h-11")} />}
      {(readyForReview(task.status) || task.status === "failed") && <DoneButton task={task} />}
    </div>
  )
})

/** The rail's indentation step. TreeRow caps its total indent against the popover's actual width. */
export const TREE_STEP = "[--tree-step:0.75rem] pointer-coarse:[--tree-step:0.875rem] @max-[16rem]/side:[--tree-step:0.5rem]"
/** The rail's tree's chevron column: the width of a project row's, so a top task's icon sits under the Captain's tile. */
const TWISTIE = "w-6 shrink-0 pointer-coarse:w-11"

/*
 * How the sidebar nests a project's tasks (Cody's design): a task sits one 20px step in from its project, its icon under
 * the project's name, beside a faint guide line from under the project's tile; each sub-task one step in from its
 * parent, at every depth, beside a guide from under its parent's icon. A list sets `--nest`, its rows' indent past the
 * chevron's column (24px, 44px to a finger); its guide, its rows' chevrons and their boxes follow from it. A project's
 * task keeps the list's full width; a tree row's box starts one step left of its icon, so its fill and its selected
 * bar move in with its level. Every row keeps its 44px target and its right-hand column. The rail's tree (Rails.tsx)
 * sets none of this.
 */
/** A project's task's padding: past the chevron's column, then its list's `--nest`. */
const NEST_PAD = "pl-[calc(1.5rem+var(--nest,0rem))] pointer-coarse:pl-[calc(2.75rem+var(--nest,0rem))]"
/**
 * How far each tree level steps in. The first `--tree-full` levels step a full 20px, so their guide runs from under the
 * middle of the parent's icon; deeper levels step `--tree-deep`, so a fifth level's title still reads on a 320px phone.
 * Their guide runs under the left of the parent's icon (at 10px, its edge), still clear of the chevron. Under 20rem the
 * deep step is 10px, and only two levels step in fully on a touch screen (its chevron column is 20px wider); under 16rem
 * (a phone at 125% zoom) only a project's tasks do, with either pointer (the touch rule would outrank a plain one). From
 * 20rem the deep step is 14px, and from 26rem the step is 20px. nestAt caps the total indent to keep actions and
 * titles visible. Container queries follow the resizable sidebar and phone drawer.
 */
const TREE_STEPS = cx(
  "[--tree-full:3] [--tree-deep:0.625rem] @max-[16rem]/side:[--tree-deep:0.375rem] @min-[20rem]/side:[--tree-deep:0.875rem] @min-[26rem]/side:[--tree-deep:1.25rem]",
  "pointer-coarse:@max-[20rem]/side:[--tree-full:2] @max-[16rem]/side:[--tree-full:1] pointer-coarse:@max-[16rem]/side:[--tree-full:1]",
)
/**
 * Budget the indent against the actual sidebar container, including its gutters. Leave 13rem for the chevron,
 * icon, readable title and non-shrinking Mark done target, even at arbitrary depth. The groups remain full width,
 * so this bounds each absolute indent rather than accumulating padding through the recursive wrappers.
 */
export const nestAt = (level: number) => `min(calc(min(${level}, var(--tree-full)) * 1.25rem + max(${level} - var(--tree-full), 0) * var(--tree-deep)), max(1.25rem, calc(100cqw - 13rem)))`
/**
 * A nested list's guide: a still, faint 1px line in the border colour, 10px left of its rows' icons (under the middle
 * of their parent's icon at a full step), down to the list's last row. It's drawn over every row's fill, so a hover
 * never moves it, and only a chevron on it breaks it.
 */
const GUIDE = cx(
  "relative before:pointer-events-none before:absolute before:bottom-0 before:z-1 before:w-px before:bg-zinc-800",
  "before:left-[calc(1.5rem+var(--nest)-0.625rem-0.5px)] pointer-coarse:before:left-[calc(2.75rem+var(--nest)-0.625rem-0.5px)]",
)
/** A project's tasks: one step in, beside a guide from under the Captain's tile. Its trees' steps are set here. */
const PROJECT_TASKS = cx(GUIDE, TREE_STEPS, "[--nest:1.25rem] before:top-0")
/** A task's sub-tasks: one step in from it (`--nest`, nestAt), beside a guide that starts in its row, just under its icon. */
const SUBTASKS = cx(GUIDE, "before:-top-3")
/** A tree row's box: from one step left of its icon, so a project's top task's spans the list and a sub-task's moves in. */
const TREE_BOX = "ml-[calc(var(--nest)-1.25rem)]"
/** A tree row's content: past the chevron's column and one step, wherever its box starts (NEST_PAD at the first level). */
const TREE_PAD = "pl-[2.75rem] pointer-coarse:pl-[4rem]"
/**
 * A tree row's chevron in the sidebar: on its parent's guide, level with its icon, the guide broken behind it by a
 * patch of the row's fill. Its target reaches left over the indent, clear of the icon: 24px wide to a mouse, 44px to a
 * finger.
 */
const NESTED_CHEVRON = "absolute top-0 left-[17px] z-2 flex h-7 w-6 items-start justify-end rounded-lg pt-1 pointer-coarse:h-11 pointer-coarse:w-11"

/** "2 of 5 running": a folded tree's count, with an amber dot when one of them asks. */
function TreeCountChip({ tree }: { tree: TreeCount }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full bg-zinc-800/80 px-1.5 text-[10px] text-zinc-400 tabular-nums">
      {tree.asks > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
      <span aria-hidden>
        {tree.running}/{tree.total}
      </span>
      <span className="sr-only">
        {tree.running} of {tree.total} sub-tasks running{tree.asks ? `, ${tree.asks} asking you` : ""}
      </span>
    </span>
  )
}

/**
 * A task in a sub-task tree, and below it its sub-tasks, to any depth. Its chevron folds them (lib/sidebar.ts
 * treeFolds, in memory), and so does a double click on its row; folded, it counts them. Every row is one line: its title truncates to
 * reserve room for the PR and check. A fold shows or hides at once. `twice`: false where a pick closes the list and nothing brings it back on the second click (the strip's tree,
 * Rails.tsx), so only the chevron folds. `guides`: the sidebar's nesting, each level one step in (nestAt) beside its
 * parent's guide; without it (the strip's tree) each level moves in by TREE_STEP. Both stop indenting when the
 * content needs the room; the tree's true ARIA level preserves the depth.
 */
export const TreeNode = memo(function TreeNode({ row, depth, folds, selection, onPick, twice = true, guides = false }: { row: SidebarRow; depth: number; folds: Readonly<Record<string, true>>; selection: Selection; onPick: Pick["task"]; twice?: boolean; guides?: boolean }) {
  const kids = row.kids ?? []
  const folded = Boolean(folds[row.task.id])
  const key = taskKey(row.task.id, "project")
  const groupId = `sidebar-subtasks-${row.task.id}`
  return (
    <div data-tree-node={row.task.id} data-depth={depth}>
      <TreeRow
        row={row}
        depth={depth}
        folded={kids.length ? folded : null}
        controls={kids.length && !folded ? groupId : undefined}
        selected={selection.selected === key}
        inside={selection.inside === key}
        onPick={onPick}
        twice={twice}
        guides={guides}
      />
      {kids.length > 0 && !folded && (
        // One step in from this row, at every depth: `depth` 0 is a project's task, level 1, so its sub-tasks are level 2.
        <div
          id={groupId}
          role="group"
          aria-label={`${row.task.title} sub-tasks`}
          style={guides ? ({ "--nest": nestAt(depth + 2) } as CSSProperties) : undefined}
          className={cx("space-y-px pt-px", guides && SUBTASKS)}
        >
          {kids.map((k) => (
            <TreeNode key={k.task.id} row={k} depth={depth + 1} folds={folds} selection={selection} onPick={onPick} twice={twice} guides={guides} />
          ))}
        </div>
      )}
    </div>
  )
})

const TreeRow = memo(function TreeRow({ row, depth, folded, controls, selected, inside, onPick, twice: foldTwice, guides }: {
  row: SidebarRow
  depth: number
  /** null: no sub-tasks, so no chevron. */
  folded: boolean | null
  controls?: string
  selected: boolean
  inside: boolean
  onPick: Pick["task"]
  twice: boolean
  /** The sidebar's nesting: the row moves in by its list's `--nest`, not by `depth`, and its chevron sits on a guide. */
  guides: boolean
}) {
  const { task, dim, meta, tree } = row
  const label = stateLabel(task)
  const prMeta = Boolean(task.prUrl)
  const twice = useTreeDoubleClick(task.id, foldTwice && folded !== null)
  const inTree = useContext(InTree)
  const id = useId()
  const glyph = folded ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />
  return (
    <div
      // A project's task is level 2, so a sub-task at `depth` is one level in from its parent's.
      {...(inTree ? treeItem(taskKey(task.id, "project"), depth + 2, id, { expanded: folded === null ? null : !folded, current: selected }) : undefined)}
      // The rail popover has a narrower chevron column and no sidebar guide padding. Reserve its content/actions too.
      style={depth && !guides ? { "--rail-indent": `calc(${depth} * var(--tree-step))` } as CSSProperties : undefined}
      className={cx("flex items-stretch rounded-lg transition", inTree && FOCUS, guides ? cx("group/tree relative", TREE_BOX) : "ml-[min(var(--rail-indent,0rem),max(0rem,calc(100cqw-12rem)))]", selected ? SELECTED : cx(dim ? "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300" : "text-zinc-300 hover:bg-zinc-900", inside && INSIDE))}
    >
      {folded === null ? (
        !guides && <span aria-hidden className={TWISTIE} />
      ) : (
        <button
          type="button"
          onClick={() => toggleTreeFold(task.id)}
          aria-expanded={!folded}
          aria-controls={controls}
          aria-label={`${folded ? "Show" : "Hide"} the sub-tasks of ${task.title}`}
          title={folded ? "Show its sub-tasks" : "Hide its sub-tasks"}
          {...(inTree ? TOGGLE_PART : undefined)}
          className={cx(guides ? NESTED_CHEVRON : cx("grid min-h-9 place-items-center rounded-lg pointer-coarse:min-h-11", TWISTIE), "text-zinc-500 hover:text-zinc-100", FOCUS)}
        >
          {guides ? (
            <span className={cx("grid h-5 w-3.5 place-items-center transition-colors", selected ? "bg-zinc-800" : "bg-zinc-950 group-hover/tree:bg-zinc-900")}>{glyph}</span>
          ) : (
            glyph
          )}
        </button>
      )}
      <div className={cx("flex min-h-9 min-w-0 flex-1 items-center gap-x-2 py-1 pr-2 text-sm pointer-coarse:min-h-11", "@max-[14rem]/side:gap-x-0.5 @max-[14rem]/side:pr-0", guides && TREE_PAD)}>
        <button
          type="button"
          onClick={(e) => {
            onPick(task.id, "project", e)
            twice.onClick(e)
          }}
          onDoubleClick={twice.onDoubleClick}
          onMouseDown={keepFocusForPick}
          data-open-task={task.id}
          {...(inTree ? openPart(id) : { "aria-current": selected ? ("page" as const) : undefined })}
          title={`${task.title} · ${label}${folded === null || !foldTwice ? "" : folded ? " (double-click to expand)" : " (double-click to collapse)"}`}
          className={cx(folded && tree ? "grid-cols-[1.25rem_minmax(0,1fr)_auto]" : "grid-cols-[1.25rem_minmax(0,1fr)]", "grid min-h-7 min-w-0 flex-1 items-center gap-x-2.5 rounded-lg text-left @max-[14rem]/side:gap-x-0.5 pointer-coarse:min-h-9", FOCUS)}
        >
          <TaskRowTitle title={task.title} status={task.status} />
          <RowIcon task={task} label={label} dim={dim} />
          {folded && tree && <span className="col-start-3 row-start-1"><TreeCountChip tree={tree} /></span>}
        </button>
        {prMeta && <PrChip task={task} variant="number" className={cx(FOCUS, "shrink-0 text-[11px] pointer-coarse:min-h-11")} />}
        {!prMeta && meta && <span aria-hidden={saysState(meta, label)} className={cx("shrink-0 text-[11px] @max-[13rem]/side:hidden", (!dim && META_TONE[task.status]) || "text-zinc-500")}>{meta}</span>}
      </div>
      {(readyForReview(task.status) || task.status === "failed") && !tree?.running && !tree?.asks && <DoneButton task={task} subtasks={tree?.total} />}
    </div>
  )
})

/**
 * ✓ at the end of a failed row or one ready for Cody's review: Mark done without opening the
 * task, done at once with an Undo toast (lib/markDone.ts). Always drawn, with a 44px touch target.
 * On a tree's row it closes the whole tree (`subtasks`), so a tree with a
 * sub-task running or asking has none. Search results have none: they list finished work, and the task's header has it.
 */
function DoneButton({ task, subtasks = 0 }: { task: Task; subtasks?: number }) {
  const markDone = useMarkDone()
  const tree = useContext(InTree)
  const kids = subtasks ? ` and its ${subtasks} sub-task${subtasks === 1 ? "" : "s"}` : ""
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void markDone(task)
      }}
      tabIndex={tree ? -1 : undefined}
      aria-label={`Mark ${task.title}${kids} done`}
      title={`Mark done${kids ? `, with its ${subtasks} sub-task${subtasks === 1 ? "" : "s"}` : ""}. Messaging it picks it back up.`}
      data-testid="sidebar-mark-done"
      className={cx("mr-0.5 grid h-8 w-8 shrink-0 place-items-center self-center rounded-md text-zinc-500 transition-colors hover:bg-emerald-500/10 hover:text-emerald-300 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)}
    >
      <Check className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/** A row's state in words: the icon's name to a screen reader, and the tooltip's. */
const stateLabel = (task: Task) => (task.status === "done" && task.prMergedAt ? "Merged" : STATUS[task.status].label)
/** The meta is the state's own word ("working", "failed"): the icon already says it to a screen reader. */
const saysState = (meta: string, label: string) => meta === label.toLowerCase() || undefined

/**
 * A row's icon, in the first column of its first line: the task's tile, which says its state (TaskStatusIcon), neutral
 * on a resting (dim) row so live work stands out. It comes after the title in the DOM, so a screen reader reads the
 * task, then its state.
 */
function RowIcon({ task, label, dim }: { task: Task; label: string; dim: boolean }) {
  return (
    <span className="col-start-1 row-start-1 grid h-5 w-5 place-items-center">
      <TaskStatusIcon task={task} label={label} muted={dim} />
    </span>
  )
}

/**
 * A project row's way to its settings (the dialog over the chat; on a phone, over the drawer, which stays open
 * beneath it). Like the pin it shows on hover or focus, always on a touch screen, and always for the open project.
 */
function ProjectSettingsButton({ id, name, reveal, shown }: { id: string; name: string; reveal: string; shown?: boolean }) {
  const open = useOpenProjectSettings()
  return (
    <button
      type="button"
      onClick={() => open(id)}
      title={`${name} project settings`}
      aria-label={`${name} project settings`}
      data-testid="sidebar-project-settings"
      tabIndex={-1}
      className={cx(ROW_TOOL, !shown && cx("opacity-0", reveal))}
    >
      <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/**
 * "Waiting on you": what asks Cody, failed, or has a PR to review, above the projects. It isn't a mode: it folds like
 * any group, says how many it holds, and is gone when nothing waits. Long lists stop at WAITING_CAP with "Show n more".
 */
const WaitingOnYou = memo(function WaitingOnYou({ rows, total, hidden, asks, folded, expanded, onExpand, selection, onPick }: {
  rows: SidebarRow[]
  total: number
  hidden: number
  asks: boolean
  folded: boolean
  expanded: boolean
  onExpand: (all: boolean) => void
  selection: Selection
  onPick: Pick["task"]
}) {
  const projects = useProjects()
  const colors = useTiles().colors
  // Each row's project line, the same object across renders so the memo'd rows can skip.
  const lines = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, { name: p.name, color: colors.get(p.id), icon: p.iconUrl }])), [projects.data, colors])
  const headId = useId()
  const moreId = useId()
  if (!total) return null
  const inside = selection.inside === WAITING_FOLD
  return (
    <div data-sidebar-group={WAITING_FOLD} className="mt-1 mb-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.03]">
      <div {...treeItem(WAITING_HEAD, 1, headId, { expanded: !folded })} className={cx("rounded-lg", FOCUS)}>
        <button
          type="button"
          onClick={() => toggleSidebarFold(WAITING_FOLD)}
          aria-expanded={!folded}
          {...OPEN_TOGGLE_PART}
          id={headId}
          className={cx("flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] font-semibold tracking-wider text-amber-200/80 uppercase hover:text-amber-100 pointer-coarse:min-h-11", FOCUS, inside && INSIDE)}
        >
          <Inbox className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">Waiting on you</span>
          <Badge count={total} asks={asks} className="h-4 min-w-4 px-1 text-[10px]" />
          <span className="ml-auto text-amber-200/50" aria-hidden>{folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
        </button>
      </div>
      {!folded && (
        <div role="group" aria-label="Waiting on you" className="space-y-px px-1 pb-1">
          {rows.map((r) => (
            <TaskRow
              key={r.task.id}
              row={r}
              spot="waiting"
              selected={selection.selected === taskKey(r.task.id, "waiting")}
              onPick={onPick}
              project={lines.get(r.task.projectId) ?? NO_PROJECT}
            />
          ))}
          {(hidden > 0 || (expanded && total > WAITING_CAP)) && (
            <div {...treeItem(WAITING_MORE, 2, moreId)} className={cx("rounded-lg", FOCUS)}>
              <button type="button" onClick={() => onExpand(!expanded)} {...openPart(moreId)} className={cx(ROW, "text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")}>
                <span className="w-5 shrink-0" aria-hidden />
                {expanded ? "Show fewer" : `Show ${hidden} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

const NO_PROJECT = { name: "", color: undefined }

/** The sidebar's empty states: what happened, then the one thing to do about it. */
const EMPTY = "px-2 pt-4 text-xs leading-relaxed text-zinc-500"
const EMPTY_ACTION = cx("mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-zinc-800 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-700 pointer-coarse:min-h-11", FOCUS)

function NoProjects({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={EMPTY}>
      <p className="text-zinc-300">No projects yet.</p>
      <p className="mt-1">A project is a repo (or any other work) with its own Captain and agents.</p>
      <button type="button" onClick={onCreate} className={EMPTY_ACTION}>
        <Plus className="h-4 w-4" aria-hidden /> New project
      </button>
    </div>
  )
}

/** The projects that aren't pinned or busy, folded away: each one's Captain is a click, and a pin brings it up top. */
const MoreProjects = memo(function MoreProjects({ groups, selection, onPick }: { groups: SidebarGroup[]; selection: Selection; onPick: Pick["captain"] }) {
  const [open, setOpen] = useState(false)
  const toggle = useCallback(() => setOpen((o) => !o), [])
  const colors = useTiles().colors
  const headId = useId()
  if (!groups.length) return null
  return (
    <div className="pt-4">
      <div {...treeItem(MORE_HEAD, 1, headId, { expanded: open })} className={cx("rounded-md", FOCUS)}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          {...OPEN_TOGGLE_PART}
          id={headId}
          className={cx("flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] font-semibold tracking-wider text-zinc-500 uppercase hover:text-zinc-300 pointer-coarse:min-h-11", FOCUS)}
        >
          More projects
          <span className="font-normal tracking-normal text-zinc-600">{groups.length}</span>
          <span className="ml-auto text-zinc-600">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        </button>
      </div>
      {open && (
        <div role="group" aria-label="More projects" className="space-y-px">
          {groups.map((g) => (
            <MoreProject key={g.project.id} group={g} color={colors.get(g.project.id)} selected={selection.selected === captainKey(g.project.id)} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  )
})

function MoreProject({ group: g, color, selected, onPick }: { group: SidebarGroup; color: Parameters<typeof projectColorStyle>[0]; selected: boolean; onPick: Pick["captain"] }) {
  const id = useId()
  return (
    <div {...treeItem(captainKey(g.project.id), 2, id, { current: selected })} className={cx("group/more flex items-center rounded-lg transition", FOCUS, selected ? SELECTED : "hover:bg-zinc-900")}>
      <button
        type="button"
        onClick={(e) => onPick(g.project.id, e)}
        onMouseDown={keepFocusForPick}
        data-open-captain={g.project.id}
        {...openPart(id)}
        title={`Talk to the ${g.project.name} Captain`}
        className={cx(ROW, "min-w-0 flex-1", selected ? "text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden>
          <span style={projectColorStyle(color)} className="h-2 w-2 rounded-[3px] bg-(--pc)" />
        </span>
        <span className="min-w-0 flex-1 truncate">{g.project.name}</span>
        {g.needs > 0 && <span className="shrink-0 text-xs text-amber-300">{g.needs} asks</span>}
        {!g.needs && g.running > 0 && <span className="shrink-0 text-xs text-sky-300">{g.running} running</span>}
      </button>
      <ProjectSettingsButton id={g.project.id} name={g.project.name} reveal="group-hover/more:opacity-100 group-focus-within/more:opacity-100" shown={selected} />
      <PinButton id={g.project.id} name={g.project.name} pinned={false} reveal="group-hover/more:opacity-100 group-focus-within/more:opacity-100" shown={selected} />
    </div>
  )
}
