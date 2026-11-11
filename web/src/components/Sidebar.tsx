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
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { Link } from "wouter"
import { AlarmClock, BarChart3, Check, ChevronDown, ChevronRight, FolderPlus, Inbox, Keyboard, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Pin, Plus, Settings as SettingsIcon } from "lucide-react"
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
  inboxRows,
  keepGroups,
  keepRows,
  keepSelection,
  openSidebarDrawer,
  railInitials,
  revealScroll,
  revealSidebarGroup,
  revealSidebarTask,
  setPickedRow,
  setSidebarCollapsed,
  sidebarGroups,
  sidebarSelection,
  taskKey,
  toggleSidebarFold,
  toggleTreeFold,
  treeHidden,
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
import { TREE_ACTION, TREE_OPEN, TREE_TOGGLE, useTreeView } from "../lib/treeView"
import { FOCUS_SIDEBAR, focusSidebar } from "../lib/sidebarFocus"
import { chatRef, useChatHidden, useFocus } from "../lib/columns"
import { DismissButton, isDialogOpen } from "./Modal"
import { APP_HOME, navigateApp, openChat, taskSessionHref } from "../lib/navigation"
import { focusComposer, keepFocusForPick, pickFocusesComposer } from "../lib/chatSwitch"
import { isTouchDevice } from "../lib/composer"
import { COORDINATOR_CHAT } from "../lib/threads"
import { useProjectCaptainIcon, useTiles } from "../lib/taskTiles"
import { useOpenSettings } from "./SettingsHost"
import { useOpenUsage, usePrefetchUsage } from "./UsageHost"
import { useOpenProjectSettings } from "../lib/projectSettings"
import { NewProjectDialog } from "./NewProjectDialog"
import { openShortcuts } from "./ShortcutsHelp"
import { BrandLogo } from "./BrandLogo"
import { SearchButton } from "./CommandPalette"
import { CUE_DOT, CueDot, ProjectAvatar, TaskStatusIcon, WORKING_PULSE, agentIconCue, agentIconLabel, projectColorStyle } from "./TaskIcon"
import { TaskRowTitle } from "./TaskRowTitle"
import { AgentIcon, PR_STYLE, PrChip, STATUS, TAP_AREA, cx } from "./ui"
import { prLabel, prStateOf } from "../lib/prState"

/**
 * Keyboard focus: a white outline inside the row and no fill, so it's never mistaken for the selected row (or a hover).
 * `!`: the app's own focus ring (styles.css, gold and outside the box) is unlayered, so it beats a plain utility.
 */
const FOCUS = "focus-visible:outline-2! focus-visible:-outline-offset-2! focus-visible:outline-zinc-100!"
/** The one selected row: a fill and a yellow bar on its left edge. Hover is a fainter fill and no bar. */
const SELECTED = "bg-zinc-800 text-zinc-50 shadow-[inset_3px_0_0_var(--color-yard-400)]"
/** A folded group holding the selected task: the bar, faint, and no fill. */
const INSIDE = "shadow-[inset_3px_0_0_color-mix(in_oklab,var(--color-yard-400)_40%,transparent)]"
/** One row's box, without its layout: 36px to a mouse, 44px to a finger. */
const ROW_BOX = cx("w-full min-h-9 rounded-lg px-2 text-left text-sm transition pointer-coarse:min-h-11", FOCUS)
const ROW = cx("flex items-center gap-2.5", ROW_BOX)
/**
 * A footer button: an icon to a mouse, as ICON_BUTTON; to a finger, which has no tooltip, the icon over its name in one
 * 44px target, the four sharing the row.
 */
const FOOTER_BUTTON = cx(
  "flex h-9 w-9 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200",
  // From 44px each, never narrower than its name, sharing what's left of the row.
  "pointer-coarse:h-11 pointer-coarse:w-auto pointer-coarse:grow pointer-coarse:basis-11 pointer-coarse:px-0.5 pointer-coarse:text-zinc-400",
  FOCUS,
)
/** Its name under its icon, on a touch screen only. The button's label says the whole of it ("New project"). */
const FOOTER_CAPTION = "hidden text-[10px] leading-3 font-medium pointer-coarse:block"
const ICON_BUTTON = cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)
/**
 * A project row's small buttons (settings, pin): always there, quiet until the pointer is on one, so nothing waits on a
 * hover. 32px to a mouse (24px wide in a sidebar under 15rem, where the name needs the room), 44px to a finger.
 */
const ROW_TOOL = cx("grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-zinc-800 hover:text-zinc-200 pointer-fine:@max-[15rem]/side:w-6 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)
/** A tool's ink: quiet, a step brighter on the selected row's fill or when it's on (a pinned project's pin). */
const toolInk = (bright: boolean | undefined) => (bright ? "text-zinc-300" : "text-zinc-500")

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
 * page on screen, its open button's id, which names it, and whether it has an action for Shift+Enter (Mark done). The tree writes its place among its siblings and the tab
 * stop.
 */
function treeItem(key: string, level: number, label: string, { expanded, current, action }: { expanded?: boolean | null; current?: boolean; action?: boolean } = {}) {
  return {
    role: "treeitem",
    "data-tree-key": key,
    "aria-level": level,
    "aria-expanded": expanded ?? undefined,
    "aria-current": current ? ("page" as const) : undefined,
    "aria-labelledby": label,
    "aria-keyshortcuts": action ? "Shift+Enter" : undefined,
    tabIndex: -1,
  }
}
/** A treeitem's open button: what Enter clicks, and the row's name. Out of the Tab order, as is every button in a row. */
const openPart = (id: string) => ({ id, tabIndex: -1, [TREE_OPEN]: "" })
/** A treeitem's chevron: what →, ← and Space click. */
const TOGGLE_PART = { tabIndex: -1, [TREE_TOGGLE]: "" }
/** "Waiting on you" and More projects: their head only folds, so Enter and the arrows click the same button. */
const OPEN_TOGGLE_PART = { ...TOGGLE_PART, [TREE_OPEN]: "" }
/** A row's own action (Mark done): what Shift+Enter clicks. */
const ACTION_PART = { [TREE_ACTION]: "" }
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

/** A count. `asks`: on the asks dot's amber (CUE_DOT), with dark figures in either theme (the light one turns zinc over). */
function Badge({ count, asks, className }: { count: number; asks: boolean; className?: string }) {
  if (!count) return null
  return (
    <span className={cx("grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold tracking-normal tabular-nums", asks ? cx(CUE_DOT.asks, "text-zinc-50 dark:text-zinc-950") : "bg-zinc-700 text-zinc-100", className)}>
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
 * The sidebar. `rail`: the narrow strip of icons (Cody folded it, or a panel needs the room); `onExpand` widens it
 * again. `drawer`: drawn inside the phone drawer, which a pick closes.
 */
export const Sidebar = memo(function Sidebar({ rail = false, drawer = false, onExpand }: { rail?: boolean; drawer?: boolean; onExpand?: () => void }) {
  const projects = useProjects()
  const initials = useMemo(() => railInitials(projects.data ?? []), [projects.data])
  const tasks = useTasks()
  const pins = useBarPins()
  const closing = usePendingCloses()
  const current = useChatProjectFilter()
  // The panel Cody looks at: the item opened last, else the rightmost; none when it's the chat (lib/columns.ts).
  const panels = usePanels()
  const focus = useFocus()
  const chatHidden = useChatHidden() && panels.length > 0
  const lookedAt = focus !== null && panels.includes(focus) ? focus : focus === chatRef(current) && !chatHidden ? undefined : panels.at(-1)
  const overlay = useMemo(() => (lookedAt ? viewOf(lookedAt) : null), [lookedAt])
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
  /** "Show all n" and "Show fewer". Back to the first few, the list starts over: it's much shorter than where Cody was. */
  const expandWaiting = useCallback((all: boolean) => {
    setAllWaiting(all)
    if (!all && list.current) list.current.scrollTop = 0
  }, [])
  /** Its tasks are from more than one project: its rows say which (WaitingOnYou). */
  const waitingMixed = useMemo(() => new Set(waitingAll.map((r) => r.task.projectId)).size > 1, [waitingAll])
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
  const reveal = useSidebarReveal()
  const list = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!reveal || rail) return
    clearSidebarReveal()
    const box = list.current
    const [attr, id] = "taskId" in reveal ? ["data-tree-node", reveal.taskId] : ["data-sidebar-group", reveal.group]
    const target = [...(box?.querySelectorAll<HTMLElement>(`[${attr}]`) ?? [])].find((el) => el.getAttribute(attr) === id)
    if (box && target) box.scrollTop += revealScroll(box.getBoundingClientRect(), target.getBoundingClientRect())
    if (reveal.focus) target?.querySelector<HTMLElement>("[role=treeitem]")?.focus({ preventScroll: true })
  }, [reveal, rail])

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
            <RailProject key={g.project.id} group={g} initials={initials.get(g.project.id) ?? ""} mark={mark(selection, captainKey(g.project.id), g.project.id)} onPick={railPick} onExpand={expandTo} />
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
          {...tree}
          role="tree"
          aria-label="Projects and tasks"
          aria-describedby={empty === "unpinned" ? emptyId : undefined}
          className={cx("flex min-h-0 flex-col", empty !== "none" && "flex-1")}
        >
          {/* It stays put above the list, so it has an edge of its own: a row scrolled half out of view ends at a line. */}
          <div className="shrink-0 border-b border-zinc-800/60 bg-zinc-950 px-2 pt-2 pb-1.5">
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
                {coordinator === "behind" && !drawer && <BehindMark />}
              </button>
            </div>
          </div>

          <div ref={list} className={cx("scroll-thin min-h-0 flex-1 overflow-y-auto px-2", empty !== "none" && "pb-3")}>
            <WaitingOnYou
              rows={waiting.shown}
              total={waitingAll.length}
              hidden={waiting.hidden}
              mixed={waitingMixed}
              asks={inbox.asks}
              folded={Boolean(folds[WAITING_FOLD])}
              expanded={allWaiting}
              onExpand={expandWaiting}
              selection={selection}
              onPick={pick.task}
            />
            {groups.shown.map((g) => (
              <ProjectGroup key={g.project.id} group={g} folded={Boolean(folds[g.project.id])} treeFolds={treeFolds} selection={selection} pick={pick} drawer={drawer} />
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
      {empty === "none" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <NoProjects onCreate={() => setCreating(true)} />
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-t border-zinc-900 px-2 py-1.5">
        <button type="button" onClick={() => setCreating(true)} title="New project" aria-label="New project" className={FOOTER_BUTTON}>
          <FolderPlus className="h-4 w-4 shrink-0" />
          <span className={FOOTER_CAPTION}>Project</span>
        </button>
        <button
          type="button"
          onClick={() => {
            navigateApp("/schedules")
            if (drawer) closeSidebarDrawer()
          }}
          title="Schedules"
          aria-label="Schedules"
          className={FOOTER_BUTTON}
        >
          <AlarmClock className="h-4 w-4 shrink-0" />
          <span className={FOOTER_CAPTION}>Schedules</span>
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
          className={FOOTER_BUTTON}
          data-testid="sidebar-usage"
        >
          <BarChart3 className="h-4 w-4 shrink-0" />
          <span className={FOOTER_CAPTION}>Usage</span>
        </button>
        <button type="button" onClick={() => openSettings("orchestrator")} title="Settings" aria-label="Settings" className={cx(FOOTER_BUTTON, "ml-auto")}>
          <SettingsIcon className="h-4 w-4 shrink-0" />
          <span className={FOOTER_CAPTION}>Settings</span>
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

/**
 * The chat still open in the centre, behind the side panel: a small mark, never the selected fill. Not in the drawer:
 * on a phone the panel covers the chat, and a finger gets no tooltip to say what the mark means.
 */
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
 * A Captain on the rail: its project's image, or its project's letters in its colour (lib/sidebar.ts railInitials: every
 * Captain's default icon is the same cap, so the tiles would differ by colour alone), or the icon the project picked for
 * its Captain. It says the Captain's status as its expanded row does, with a dot at its corner for its tasks: amber
 * when one asks Cody (as the folded row's count), else red when one failed. A click opens its Captain; a double click
 * (or tap) also expands the sidebar on its tasks.
 */
const RailProject = memo(function RailProject({ group, initials, mark, onPick, onExpand }: { group: SidebarGroup; initials: string; mark: Mark; onPick: (projectId: string, e: PickEvent) => void; onExpand: (projectId: string) => void }) {
  const { project, needs, failed } = group
  // One dot: what asks Cody comes before what broke.
  const cue = needs ? "asks" : failed ? "failed" : null
  const color = useTiles().colors.get(project.id)
  const picked = useProjectCaptainIcon(project.id)
  const state = useCaptainState(project.id).data
  const status = agentIconLabel(state)
  const working = Boolean(state?.busy || state?.compacting)
  const label = `${project.name} Captain${status ? `, ${status}` : ""}${needs ? `, ${needs} asking you` : ""}${failed ? `, ${failed} failed` : ""}`
  return (
    <RailButton
      label={label}
      title={`${label} (double-click to expand)`}
      mark={mark}
      captain={project.id}
      onClick={(e) => onPick(project.id, e)}
      onDoubleClick={() => onExpand(project.id)}
    >
      {picked ? (
        <AgentIcon announce={false} projectId={project.id} color={color} busy={Boolean(state?.busy)} compacting={state?.compacting} error={Boolean(state?.error)} tile />
      ) : (
        <span data-testid="rail-project-tile" className="relative flex shrink-0" style={projectColorStyle(color)}>
          <span data-busy={working || undefined} className={cx("grid h-6 w-6 place-items-center", working && WORKING_PULSE)}>
            <ProjectAvatar src={project.iconUrl} className="h-6 w-6 rounded-md">
              <span aria-hidden className={cx("grid h-6 w-6 place-items-center rounded-md text-[11px] leading-none font-semibold", color ? "bg-(--pc)/15 text-(--pc)" : "bg-zinc-800 text-zinc-300")}>
                {initials}
              </span>
            </ProjectAvatar>
          </span>
          <CueDot cue={agentIconCue(state)} />
        </span>
      )}
      {cue && <span aria-hidden data-testid="rail-project-cue" data-cue={cue} className={cx("absolute top-1 right-1 h-2 w-2 rounded-full ring-2 ring-zinc-950", CUE_DOT[cue])} />}
    </RailButton>
  )
})

/**
 * A project: one row that is its Captain (the name opens it as the centre chat), with a chevron that only folds its
 * tasks, its settings and its pin; then its live tasks. Folded, the row counts them, with an amber dot if one asks.
 */
const ProjectGroup = memo(function ProjectGroup({ group, folded, treeFolds, selection, pick, drawer }: { group: SidebarGroup; folded: boolean; treeFolds: Readonly<Record<string, true>>; selection: Selection; pick: Pick; drawer: boolean }) {
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
        className={cx("flex items-center rounded-lg transition", FOCUS, state === "selected" ? SELECTED : cx("hover:bg-zinc-900", state === "inside" && INSIDE))}
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
          {folded && <GroupCountChip group={group} />}
          {state === "behind" && !drawer && <BehindMark />}
        </button>
        <ProjectSettingsButton id={project.id} name={project.name} bright={state === "selected"} />
        <PinButton id={project.id} name={project.name} pinned={group.pin === "pinned"} bright={state === "selected"} />
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

/** A project's tasks out of sight (folded, or under More projects): how many, with an amber dot when one asks. */
function GroupCountChip({ group }: { group: SidebarGroup }) {
  const count = group.rows.length
  if (!count) return null
  return (
    <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-zinc-800/80 px-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">
      {group.needs > 0 && <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", CUE_DOT.asks)} />}
      {count}
      <span className="sr-only"> {count === 1 ? "task" : "tasks"}{group.needs > 0 ? `, ${group.needs} asking you` : ""}</span>
    </span>
  )
}

/** Pin keeps a quiet project in the list; unpinned, it moves to More projects. Drawn like the settings button, filled and brighter while it's on. */
function PinButton({ id, name, pinned, bright }: { id: string; name: string; pinned: boolean; bright?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => (pinned ? unpinProject(id) : pinProject(id))}
      title={pinned ? `Unpin ${name}: it moves to More projects` : `Pin ${name}: it stays here when it's quiet`}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      aria-pressed={pinned}
      tabIndex={-1}
      className={cx(ROW_TOOL, toolInk(pinned || bright))}
    >
      <Pin className={cx("h-3.5 w-3.5", pinned && "fill-current")} aria-hidden />
    </button>
  )
}

/** A row's PR without a link yet ("PR"): in an open PR's green, unless the row rests. */
const META_TONE: Partial<Record<Task["status"], string>> = { pr_ready: "text-emerald-300" }
/**
 * A row's PR number: 44px to a finger, both ways. In a sidebar under 15rem (its narrowest, or a phone's drawer zoomed
 * in) it's the number alone, without its ↗: the title needs the room, and its colour and its name still say it's a PR.
 */
const ROW_PR = cx(FOCUS, "shrink-0 tabular-nums pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center @max-[15rem]/side:[&>[data-external-mark]]:hidden")
/**
 * In a zoomed phone's drawer two 44px targets leave a title two letters. Mark done stays, as the row's own action; the
 * PR is one tap away, in the task's header.
 */
const ROW_PR_YIELDS = "pointer-coarse:@max-[15rem]/side:hidden"
/** Only where ROW_PR_YIELDS hides the link. */
const ROW_PR_YIELDED = "hidden pointer-coarse:@max-[15rem]/side:block"

/**
 * In the place of a PR link that ROW_PR_YIELDS hides: the PR's state icon in its state's colour (PR_STYLE), still and
 * not a link, so the row still says it has one. PrName says it in the row's name.
 */
function PrMark({ task }: { task: Task }) {
  const state = prStateOf(task)
  if (!state) return null
  const { icon: Icon, link } = PR_STYLE[state]
  return <Icon aria-hidden data-testid="sidebar-pr-mark" data-pr-state={state} className={cx("mr-1 h-3.5 w-3.5 shrink-0", link, ROW_PR_YIELDED)} />
}
/** ", PR #23" at the end of a row's name, where its PR link is hidden (PrMark). */
function PrName({ task }: { task: Task }) {
  const label = prLabel(task)
  return label ? <span className={cx("sr-only", ROW_PR_YIELDED)}>, {label}</span> : null
}

/**
 * A task: opens it in the side panel. `spot` says which list it's in (a task can be in "Waiting on you" and under its
 * project), so the copy Cody clicked is the one drawn selected. `project` (a "Waiting on you" row's) ends its name
 * and its tooltip with its project. One ready for Cody's review, or failed, ends with Mark done's ✓. Its icon alone
 * says its state, with a still dot when it works, asks or failed. A PR number links to GitHub beside the task button,
 * so each action has its own keyboard target.
 */
export const TaskRow = memo(function TaskRow({ row, spot, selected, onPick, project }: { row: SidebarRow; spot: RowSpot; selected: boolean; onPick: Pick["task"]; project?: { name: string; color: Parameters<typeof projectColorStyle>[0]; icon?: string | null } }) {
  const { task, dim, meta } = row
  const label = stateLabel(task)
  const prMeta = Boolean(task.prUrl)
  const tree = useContext(InTree)
  const id = useId()
  const closable = readyForReview(task.status) || task.status === "failed"
  return (
    <div
      {...(tree ? treeItem(taskKey(task.id, spot), 2, id, { current: selected, action: closable }) : undefined)}
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
        {project?.name && <span className="sr-only">, {project.name}</span>}
        {prMeta && closable && <PrName task={task} />}
        {!prMeta && meta && <span aria-hidden={saysState(meta, label)} className={cx("col-start-3 row-start-1 text-xs leading-5 tabular-nums @max-[13rem]/side:hidden", (!dim && META_TONE[task.status]) || "text-zinc-500")}>{meta}</span>}
      </button>
      {prMeta && <PrChip task={task} variant="number" className={cx(ROW_PR, "mr-2 text-xs leading-5 @max-[15rem]/side:mr-1 pointer-coarse:mr-0", closable && ROW_PR_YIELDS)} />}
      {prMeta && closable && <PrMark task={task} />}
      {closable && <DoneButton task={task} />}
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
/** How many levels below a project's tasks always step in, however narrow the sidebar, and by how much (rem). */
const NEST_KEPT = 3
const NEST_FLOOR = 0.375
/**
 * Budget the indent against the actual sidebar container, including its gutters. Leave 13rem for the chevron,
 * icon, readable title and non-shrinking Mark done target, even at arbitrary depth. The groups remain full width,
 * so this bounds each absolute indent rather than accumulating padding through the recursive wrappers. The budget
 * never flattens the tree: each of the first NEST_KEPT levels of sub-tasks keeps a 6px step of its own (a floor under
 * it, and the budget of the levels above it stops that much short), so the depth still shows in a 200px sidebar, where a row
 * with a PR keeps about six characters of its title. Deeper levels share the last one's indent there.
 */
export const nestAt = (level: number) => {
  const kept = Math.min(Math.max(level - 1, 0), NEST_KEPT)
  const floor = 1.25 + kept * NEST_FLOOR
  const budget = 13 + (NEST_KEPT - kept) * NEST_FLOOR
  return `calc(min(calc(min(${level}, var(--tree-full)) * 1.25rem + max(${level} - var(--tree-full), 0) * var(--tree-deep)), max(${floor}rem, calc(100cqw - ${budget}rem))) - var(--nest-trim, 0rem))`
}
/**
 * A nested list's guide: a still, faint 1px line in the border colour, 10px left of its rows' icons (under the middle
 * of their parent's icon at a full step), down to the list's last row. It's drawn over every row's fill, so a hover
 * never moves it, and only a chevron on it breaks it.
 */
const GUIDE = cx(
  "relative before:pointer-events-none before:absolute before:bottom-0 before:z-1 before:w-px before:bg-zinc-800",
  "before:left-[calc(1.5rem+var(--nest)-0.625rem-0.5px)] pointer-coarse:before:left-[calc(2.75rem+var(--nest)-0.625rem-0.5px)]",
)
/**
 * A project's tasks: one step in, beside a guide from under the Captain's tile. Its trees' steps are set here. In a
 * zoomed phone's drawer (a finger's 44px chevron column, under 16.5rem) that step is 6px, not 20: `--nest-trim` takes the
 * 14px off every level's indent (nestAt), so a row with a PR and Mark done keeps a few letters of its title. The rows'
 * boxes stay put (TREE_BOX); their content and their chevrons move left with it.
 */
const PROJECT_TASKS = cx(GUIDE, TREE_STEPS, "[--nest-trim:0rem] pointer-coarse:@max-[16.5rem]/side:[--nest-trim:0.875rem] [--nest:calc(1.25rem_-_var(--nest-trim))] before:top-0")
/** A task's sub-tasks: one step in from it (`--nest`, nestAt), beside a guide that starts in its row, just under its icon. */
const SUBTASKS = cx(GUIDE, "before:-top-3")
/** A tree row's box: from one step left of its icon, so a project's top task's spans the list and a sub-task's moves in. */
const TREE_BOX = "ml-[calc(var(--nest)-1.25rem+var(--nest-trim,0rem))]"
/** A tree row's content: past the chevron's column and one step, wherever its box starts (NEST_PAD at the first level). */
const TREE_PAD = "pl-[calc(2.75rem-var(--nest-trim,0rem))] pointer-coarse:pl-[calc(4rem-var(--nest-trim,0rem))]"
/**
 * A tree row's chevron in the sidebar: on its parent's guide, level with its icon (the row is one line, so its
 * middle), the guide broken behind it by a patch of the row's fill. Its target is the row's height and reaches left
 * over the indent, clear of the icon: 24px wide to a mouse, 44px to a finger.
 */
const NESTED_CHEVRON = "absolute inset-y-0 left-[calc(17px-var(--nest-trim,0rem))] z-2 flex w-6 items-center justify-end rounded-lg pointer-coarse:w-11"

/** "2 of 5 running": a folded tree's count, with an amber dot when one of them asks. */
function TreeCountChip({ tree }: { tree: TreeCount }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center gap-1 rounded-full bg-zinc-800/80 px-1.5 text-[10px] text-zinc-400 tabular-nums">
      {tree.asks > 0 && <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", CUE_DOT.asks)} />}
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
  // Mark done closes the whole tree, so not while a sub-task runs or asks.
  const closable = (readyForReview(task.status) || task.status === "failed") && !tree?.running && !tree?.asks
  const glyph = folded ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />
  return (
    <div
      // A project's task is level 2, so a sub-task at `depth` is one level in from its parent's.
      {...(inTree ? treeItem(taskKey(task.id, "project"), depth + 2, id, { expanded: folded === null ? null : !folded, current: selected, action: closable }) : undefined)}
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
      <div className={cx("flex min-h-9 min-w-0 flex-1 items-center gap-x-2 py-1 pr-2 text-sm pointer-coarse:min-h-11 pointer-coarse:py-0", "@max-[14rem]/side:gap-x-1 @max-[14rem]/side:pr-0", guides && TREE_PAD)}>
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
          className={cx(folded && tree ? "grid-cols-[1.25rem_minmax(0,1fr)_auto]" : "grid-cols-[1.25rem_minmax(0,1fr)]", "grid min-h-7 min-w-0 flex-1 items-center gap-x-2.5 rounded-lg text-left @max-[14rem]/side:gap-x-1.5 pointer-coarse:min-h-11", FOCUS)}
        >
          <TaskRowTitle title={task.title} status={task.status} />
          <RowIcon task={task} label={label} dim={dim} />
          {folded && tree && <span className="col-start-3 row-start-1"><TreeCountChip tree={tree} /></span>}
          {prMeta && closable && <PrName task={task} />}
        </button>
        {prMeta && <PrChip task={task} variant="number" className={cx(ROW_PR, "text-[11px]", closable && ROW_PR_YIELDS)} />}
        {prMeta && closable && <PrMark task={task} />}
        {!prMeta && meta && <span aria-hidden={saysState(meta, label)} className={cx("shrink-0 text-[11px] @max-[13rem]/side:hidden", (!dim && META_TONE[task.status]) || "text-zinc-500")}>{meta}</span>}
      </div>
      {closable && <DoneButton task={task} subtasks={tree?.total} />}
    </div>
  )
})

/**
 * A circle at the end of a failed row or one ready for Cody's review: Mark done without opening the task, done at once
 * with an Undo toast (lib/markDone.ts). Always drawn, with a 44px touch target and one resting look for a mouse and a
 * finger: its ✓ faint, then whole and green under the pointer or with the keyboard's focus on it or on its row.
 * Shift+Enter on its row in the tree (lib/treeView.ts TREE_ACTION), as its tooltip there says.
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
      title={`Mark done${tree ? " (Shift+Enter)" : ""}${kids ? `, with its ${subtasks} sub-task${subtasks === 1 ? "" : "s"}` : ""}. Messaging it picks it back up.`}
      data-testid="sidebar-mark-done"
      {...(tree ? ACTION_PART : undefined)}
      className={cx("group/done mr-0.5 grid h-8 w-8 shrink-0 place-items-center self-center rounded-md text-zinc-500 transition-colors hover:bg-emerald-500/10 hover:text-emerald-300 focus-visible:text-emerald-300 pointer-coarse:h-11 pointer-coarse:w-11", FOCUS)}
    >
      {/* Faint until it's about to be pressed: a whole check at rest, boxed or bare, reads as "done already". */}
      <span className="grid h-5 w-5 place-items-center rounded-full border border-zinc-600 transition-colors group-hover/done:border-emerald-400/50">
        <Check className="h-3 w-3 opacity-40 group-hover/done:opacity-100 group-focus-visible/done:opacity-100 [[role=treeitem]:focus-visible_&]:text-emerald-300 [[role=treeitem]:focus-visible_&]:opacity-100" aria-hidden />
      </span>
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
 * beneath it). Like the pin it's always there, quiet.
 */
function ProjectSettingsButton({ id, name, bright }: { id: string; name: string; bright?: boolean }) {
  const open = useOpenProjectSettings()
  return (
    <button
      type="button"
      onClick={() => open(id)}
      title={`${name} project settings`}
      aria-label={`${name} project settings`}
      data-testid="sidebar-project-settings"
      tabIndex={-1}
      // A zoomed phone's drawer keeps the row for the name and the pin: the Captain's ⋯ menu has the settings too.
      className={cx(ROW_TOOL, toolInk(bright), "pointer-coarse:@max-[15rem]/side:hidden")}
    >
      <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
    </button>
  )
}

/** "Show fewer", in the head of the whole "Waiting on you" list: quiet, in the head's amber, 44px to a finger. */
const FEWER = cx("relative z-1 mr-1 flex min-h-7 shrink-0 items-center justify-center rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap text-amber-200/80 hover:bg-amber-300/10 hover:text-amber-100 @max-[19rem]/side:mr-0 @max-[19rem]/side:px-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2.5 pointer-coarse:@max-[19rem]/side:px-1", FOCUS)
/** What "Show fewer" does, for its tooltip and its name: back to the capped list. */
const SHOW_CAPPED = `Show only the first ${WAITING_CAP}`
/**
 * The head's " on you" goes where "Waiting", its count and "Fewer" need the row: a sidebar narrower than its default
 * (16rem less its border), a zoomed phone's drawer. A finger's "Fewer" is 44px wide, so it goes a little sooner. By
 * the sidebar's width only, never by what's open.
 */
const HEAD_SHORT = "@max-[15.5rem]/side:sr-only pointer-coarse:@max-[16.5rem]/side:sr-only"
/** The head of the whole list stays in view above its rows, on the section's own tint (opaque: rows pass under it). */
const WAITING_STUCK = "sticky top-0 z-10 rounded-b-none border-b border-amber-300/15 bg-[color-mix(in_oklab,var(--color-amber-300)_3%,var(--color-zinc-950))]"

/**
 * "Waiting on you": what asks Cody, failed, or has a PR to review, above the projects. It isn't a mode: it folds like
 * any group, says how many it holds, and is gone when nothing waits. Long lists stop at WAITING_CAP with "Show all n";
 * the whole list ends with "Show fewer", and its head, which stays in view while it scrolls, has one too, so the
 * projects under it are never a long scroll away. `mixed`: its tasks are from more than one project, so each run of
 * rows from one project sits under that project's name.
 */
const WaitingOnYou = memo(function WaitingOnYou({ rows, total, hidden, mixed, asks, folded, expanded, onExpand, selection, onPick }: {
  rows: SidebarRow[]
  total: number
  hidden: number
  mixed: boolean
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
  /** The whole list is on screen, and it's longer than the cap: "Show fewer" takes it back. */
  const whole = expanded && total > WAITING_CAP
  /** Then its head stays in view while the list scrolls, with a "Show fewer" of its own. */
  const stuck = whole && !folded
  const fewer = () => onExpand(false)
  return (
    <div data-sidebar-group={WAITING_FOLD} className="mt-1 mb-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.03]">
      {/* The fold button covers the whole head (its ::after), under "Show fewer": one row, two targets. */}
      <div {...treeItem(WAITING_HEAD, 1, headId, { expanded: !folded })} className={cx("flex items-center rounded-lg", FOCUS, stuck ? WAITING_STUCK : "relative")}>
        <button
          type="button"
          onClick={() => toggleSidebarFold(WAITING_FOLD)}
          aria-expanded={!folded}
          {...OPEN_TOGGLE_PART}
          id={headId}
          className={cx("flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 text-left text-[11px] font-semibold tracking-wider text-amber-200/80 uppercase after:absolute after:inset-0 after:rounded-lg hover:text-amber-100 @max-[19rem]/side:gap-1.5 @max-[19rem]/side:tracking-wide pointer-coarse:min-h-11", FOCUS, inside && INSIDE)}
        >
          <Inbox className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {/* Narrow, "Waiting" alone fits; the rest stays in its name. */}
          <span className="min-w-0 truncate">
            Waiting<span className={HEAD_SHORT}> on you</span>
          </span>
          <Badge count={total} asks={asks} className="h-4 min-w-4 px-1 text-[10px]" />
        </button>
        {stuck && (
          // It goes with the click, so the press doesn't take the focus to it. Under 19rem it's "Fewer", to fit.
          <button type="button" onClick={fewer} onMouseDown={(e) => e.preventDefault()} tabIndex={-1} title={SHOW_CAPPED} aria-label={`Show fewer: ${SHOW_CAPPED.toLowerCase()}`} className={FEWER}>
            <span className="@max-[19rem]/side:hidden">Show fewer</span>
            <span className="@min-[19rem]/side:hidden">Fewer</span>
          </button>
        )}
        <span className="mr-2 ml-1.5 shrink-0 text-amber-200/50 @max-[19rem]/side:mr-1.5" aria-hidden>{folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
      </div>
      {!folded && (
        <div role="group" aria-label="Waiting on you" className="space-y-px px-1 pb-1">
          {rows.map((r, i) => {
            const project = lines.get(r.task.projectId) ?? NO_PROJECT
            return (
              <Fragment key={r.task.id}>
                {/* The row's own name ends with its project, so this line is for the eye only. */}
                {mixed && project.name && rows[i - 1]?.task.projectId !== r.task.projectId && (
                  <div aria-hidden className={cx("grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2.5 px-2 text-xs leading-4 text-zinc-400", i ? "pt-1.5" : "pt-1")}>
                    {/* The project's square, as under More projects: a round dot here would read as a task's state. */}
                    <span className="grid place-items-center"><span style={projectColorStyle(project.color)} className="h-2 w-2 rounded-[2px] bg-(--pc)" /></span>
                    <span className="min-w-0 truncate">{project.name}</span>
                  </div>
                )}
                <TaskRow row={r} spot="waiting" selected={selection.selected === taskKey(r.task.id, "waiting")} onPick={onPick} project={project} />
              </Fragment>
            )
          })}
          {(hidden > 0 || whole) && (
            <div {...treeItem(WAITING_MORE, 2, moreId)} className={cx("rounded-lg", FOCUS)}>
              <button type="button" onClick={whole ? fewer : () => onExpand(true)} {...openPart(moreId)} title={whole ? SHOW_CAPPED : undefined} className={cx(ROW, "text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200")}>
                <span className="w-5 shrink-0" aria-hidden />
                {whole ? "Show fewer" : `Show all ${total}`}
                {whole && <span className="sr-only">: {SHOW_CAPPED.toLowerCase()}</span>}
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
    <div {...treeItem(captainKey(g.project.id), 2, id, { current: selected })} className={cx("flex items-center rounded-lg transition", FOCUS, selected ? SELECTED : "hover:bg-zinc-900")}>
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
          <span style={projectColorStyle(color)} className="h-2 w-2 rounded-[2px] bg-(--pc)" />
        </span>
        <span className="min-w-0 flex-1 truncate">{g.project.name}</span>
        <GroupCountChip group={g} />
      </button>
      <ProjectSettingsButton id={g.project.id} name={g.project.name} bright={selected} />
      <PinButton id={g.project.id} name={g.project.name} pinned={false} bright={selected} />
    </div>
  )
}
