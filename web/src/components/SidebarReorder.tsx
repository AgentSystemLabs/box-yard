// Rearranging the sidebar's rows: a project among the projects, a task among its project's tasks, a sub-task among its
// parent's (lib/sidebarOrder.ts). Every way in ends in the same move:
//
// - a mouse drags a row past a few pixels; a finger or pen holds it first, so a swipe still scrolls the list;
// - a right click, a hold let go without moving, the Menu key or Shift+F10 open a small menu: Move up, Move down, Move
//   to top, Move to bottom, and Back to automatic order for tasks someone placed;
// - Alt+↑/↓ move the focused row one place, with Shift to the top or bottom.
//
// A task's row (a sub-task's, one in Waiting on you) can also go into a chat as context (lib/taskReference.ts): dragged
// out of the list onto a message box, which says it will take it, or with "Add to …" in the same menu, one line per box
// on screen. A drop in the list still rearranges it.
//
// It listens on the tree's own element, so the memo'd rows get no new props and render as before, and the tree stays
// one tab stop (lib/treeView.ts). Nothing moves on its own: a drag shows a still frame on the row it holds and a line
// where it would land, both placed straight on the DOM, so a drag re-renders nothing until its drop. A screen reader
// hears every move.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { createPortal, flushSync } from "react-dom"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ListRestart, MessageSquareQuote } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { keys } from "../lib/queries"
import { closeSidebarDrawer, type SidebarGroup } from "../lib/sidebar"
import { moved, movedText, moveTarget, orderSpot, resetOrder, saveOrder, slotTarget, type OrderMove, type OrderSpot } from "../lib/sidebarOrder"
import { addTaskReference, openTargets, targetAt, targetName, taskIdOfRowKey, type ContextTarget } from "../lib/taskReference"
import { treeItems } from "../lib/treeView"
import { MessageMenu, type MenuItem } from "./MessageActions"

type Groups = { shown: readonly SidebarGroup[]; others: readonly SidebarGroup[] }

/** How far a mouse moves with its button down before the row comes with it, in px. */
const DRAG_SLOP = 6
/** How long a finger rests on a row to pick it up, in ms, and how far it may wander meanwhile: further is a scroll. */
export const HOLD_MS = 400
const HOLD_SLOP = 10
/** A held row starts to move once the finger does, this far. */
const HELD_SLOP = 4
/** Near the list's top or bottom edge a drag scrolls it, this many px a frame. */
const EDGE = 28
const EDGE_STEP = 10
/** The click a drag's or a hold's release would make is dropped, if it comes this soon. */
const CLICK_MS = 500
/** After a keyboard move, how long the focus is given back to its row if redrawing the list took it. */
const REFOCUS_MS = 600

interface Press {
  pointerId: number
  /** A finger or pen: a hold picks the row up. A mouse: a drag does. */
  touch: boolean
  x0: number
  y0: number
  x: number
  y: number
  key: string
  /** A task's row: it can be dropped on a message box, as context. */
  taskId: string | null
  /** Its name, for the message box's "Add … here". */
  name: string
  /** pressed: nothing yet; held: a finger picked the row up; dragging: it's moving. */
  phase: "pressed" | "held" | "dragging"
  timer: ReturnType<typeof setTimeout> | null
  frame: number | null
  /** Where a drop now would put the row: its new index, or null where it would stay. */
  to: number | null
  /** The message box a drop now would add the task to, out of the list. */
  drop: ContextTarget | null
  stop: () => void
}

/** A message box the menu offers, with its name there. */
type NamedTarget = ContextTarget & { name: string }

interface Layer {
  /** `name`: the row's; `taskId` and `targets`: a task's, and the boxes it can be added to. */
  menu: { key: string; item: HTMLElement; name: string; taskId: string | null; targets: NamedTarget[] } | null
  said: { text: string; n: number }
}

/** The menu and the announcement live outside the sidebar's own state, so showing one re-renders only ReorderLayer. */
function layerStore() {
  let value: Layer = { menu: null, said: { text: "", n: 0 } }
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: Partial<Layer>) {
      value = { ...value, ...next }
      for (const l of listeners) l()
    },
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}

/** A row's own element and the rows drawn under it (a project's tasks, a task's sub-tasks), which move with it. */
function blockOf(item: HTMLElement): HTMLElement {
  const box = item.parentElement
  return box && (box.hasAttribute("data-tree-node") || box.hasAttribute("data-sidebar-group")) ? box : item
}

/** The list that scrolls `el`. */
function scrollerOf(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at && root.contains(at); at = at.parentElement) {
    const flow = getComputedStyle(at).overflowY
    if (flow === "auto" || flow === "scroll") return at
  }
  return null
}

const hide = (el: HTMLElement | null) => {
  if (el) el.style.display = "none"
}

/**
 * The still frame on `item` and the rows that move with it: as wide as the row itself, so a sub-task's sits at its
 * indent, and cut to the part of its list on screen. Returns the row's own left edge and width, for the drop line.
 */
function showMark(el: HTMLElement | null, item: HTMLElement, clip: DOMRect) {
  const block = blockOf(item).getBoundingClientRect()
  const { left, width } = item.getBoundingClientRect()
  const top = Math.max(block.top, clip.top)
  const bottom = Math.min(block.bottom, clip.bottom)
  if (el) Object.assign(el.style, bottom > top ? { display: "block", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${bottom - top}px` } : { display: "none" })
  return { left, width }
}

/** While a row is dragged the rows it passes don't light up as if they'd open, and the pointer shows it holds one. */
function dragLook(tree: HTMLElement | null, on: boolean) {
  if (tree) tree.style.pointerEvents = on ? "none" : ""
  document.documentElement.style.cursor = on ? "grabbing" : ""
}

/** Over a message box, the box says it takes the task: a still outline over it, and the pointer says it copies. */
function showDrop(el: HTMLElement | null, to: ContextTarget | null, name: string) {
  document.documentElement.style.cursor = to ? "copy" : "grabbing"
  if (!el) return
  if (!to) return hide(el)
  const { top, left, width, height } = to.zone.getBoundingClientRect()
  const text = `Add “${name}” here as context`
  const label = el.firstElementChild
  if (label && label.textContent !== text) label.textContent = text
  Object.assign(el.style, { display: "flex", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` })
}

const taskOf = (qc: QueryClient, id: string | null) => (id ? qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === id) : undefined)

/** The boxes a task can be added to, named for the menu; a name two boxes share gets a number. */
function namedTargets(qc: QueryClient, taskId: string): NamedTarget[] {
  const data = { tasks: qc.getQueryData<Task[]>(keys.tasks), projects: qc.getQueryData<Project[]>(keys.projects) }
  const count = new Map<string, number>()
  return openTargets(taskId).map((t) => {
    const name = targetName(t.key, data)
    const n = (count.get(name) ?? 0) + 1
    count.set(name, n)
    return { ...t, name: n > 1 ? `${name} (${n})` : name }
  })
}

interface TreeProps {
  ref: (el: HTMLDivElement | null) => (() => void) | undefined
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}

/**
 * Rearranging for the sidebar's tree. `tree`: useTreeView's props, which come back with the pointer, menu and Alt+arrow
 * handlers added (spread them onto the role="tree" element in its place). `layer`: the drop line, the menu and the
 * announcements, to draw once anywhere in the sidebar. `drawer`: the sidebar is the phone's drawer, which closes when
 * a task is added to a chat, so the chat shows.
 */
export function useSidebarReorder<T extends TreeProps>(tree: T, groups: Groups, { drawer = false }: { drawer?: boolean } = {}) {
  const qc = useQueryClient()
  const root = useRef<HTMLDivElement | null>(null)
  const latest = useRef(groups)
  latest.current = groups
  const press = useRef<Press | null>(null)
  const mark = useRef<HTMLDivElement | null>(null)
  const line = useRef<HTMLDivElement | null>(null)
  const dropZone = useRef<HTMLDivElement | null>(null)
  /** A click to drop: the one a drag's or a hold's release makes. */
  const dropClick = useRef(0)
  const refocus = useRef<{ key: string; until: number } | null>(null)
  const layer = useMemo(layerStore, [])

  const itemOf = useCallback((key: string) => (root.current ? treeItems(root.current).find((i) => i.getAttribute("data-tree-key") === key) : undefined) ?? null, [])
  const say = useCallback((text: string) => layer.set({ said: { text, n: layer.get().said.n + 1 } }), [layer])

  /** Move the row with `key` in its list and save it. `keepFocus`: the keyboard asked, so its row keeps the focus. */
  const move = useCallback(
    (key: string, to: number | OrderMove, keepFocus: boolean) => {
      const spot = orderSpot(latest.current, key)
      if (!spot) return
      const { list, index } = spot
      const target = typeof to === "number" ? (to === index ? null : to) : moveTarget(index, list.ids.length, to)
      if (target === null || target < 0 || target >= list.ids.length) {
        if (typeof to !== "number") say(`${list.names[index]} is already ${to === "up" || to === "top" ? "first" : "last"}`)
        return
      }
      if (keepFocus) refocus.current = { key, until: performance.now() + REFOCUS_MS }
      say(movedText(list.names[index]!, target, list.ids.length))
      void saveOrder(qc, list, moved(list.ids, index, target))
    },
    [qc, say],
  )

  // Redrawing a list in its new order may take a row out of the page and put it back, which drops the focus it had.
  useLayoutEffect(() => {
    const want = refocus.current
    if (!want) return
    if (performance.now() > want.until) return void (refocus.current = null)
    const item = itemOf(want.key)
    const active = document.activeElement
    if (!item || (active && active !== document.body && active !== item)) return
    if (active !== item) item.focus({ preventScroll: true })
    item.scrollIntoView?.({ block: "nearest" })
  })

  /**
   * The row a press, a right click or a key is on that has something to do: a place to move to, or a task to add to a
   * chat. `spot` only when it can move, with somewhere to move to.
   */
  const grab = useCallback((target: EventTarget | null): { key: string; spot: OrderSpot | null; taskId: string | null } | null => {
    const item = target instanceof Element ? target.closest<HTMLElement>("[role=treeitem]") : null
    const key = item && root.current?.contains(item) ? item.getAttribute("data-tree-key") : null
    const found = orderSpot(latest.current, key)
    const spot = found && found.list.ids.length > 1 ? found : null
    const taskId = taskIdOfRowKey(key)
    return key && (spot || taskId) ? { key, spot, taskId } : null
  }, [])
  /** The row a press or key is on that can move, with somewhere to move to. */
  const movable = useCallback((target: EventTarget | null) => {
    const row = grab(target)
    return row?.spot ? { key: row.key, spot: row.spot } : null
  }, [grab])

  /** Open the row's menu, if it has anything in it: its moves, and for a task the chats it can be added to. */
  const openMenu = useCallback(
    (key: string) => {
      const item = itemOf(key)
      const spot = orderSpot(latest.current, key)
      const taskId = taskIdOfRowKey(key)
      const targets = taskId ? namedTargets(qc, taskId) : []
      if (!item || (!targets.length && !(spot && spot.list.ids.length > 1))) return false
      const name = (spot ? spot.list.names[spot.index] : taskOf(qc, taskId)?.title) ?? ""
      layer.set({ menu: { key, item, name, taskId, targets } })
      return true
    },
    [itemOf, layer, qc],
  )

  /** Add the task to the message box `to`, at its caret; the phone's drawer closes so the chat shows. */
  const addTo = useCallback(
    (to: ContextTarget, taskId: string) => {
      const task = taskOf(qc, taskId)
      if (!task) return
      const projects = qc.getQueryData<Project[]>(keys.projects) ?? []
      // At once, so the drawer gives the focus back before the box takes it.
      if (drawer) flushSync(closeSidebarDrawer)
      addTaskReference(to, task, projects)
      say(`${task.title} added to ${targetName(to.key, { tasks: qc.getQueryData<Task[]>(keys.tasks), projects })}`)
    },
    [qc, say, drawer],
  )

  /**
   * Draw the drag where it is now: the frame on its row, and the line where it would land, or, out of the list over a
   * message box, the box's outline. Scrolls the list with the pointer at its top or bottom edge.
   */
  const draw = useCallback(() => {
    const p = press.current
    const tree = root.current
    if (!p || !tree) return
    p.frame = null
    p.to = null
    const items = new Map(treeItems(tree).map((i) => [i.getAttribute("data-tree-key"), i]))
    const item = items.get(p.key)
    if (!item) return void (hide(mark.current), hide(line.current), hide(dropZone.current), (p.drop = null))
    const view = scrollerOf(blockOf(item), tree)
    const clip = (view ?? tree).getBoundingClientRect()
    if (p.phase === "dragging") {
      p.drop = p.taskId ? targetAt(p.x, p.y, p.taskId) : null
      showDrop(dropZone.current, p.drop, p.name)
    }
    // Only beside the list: a message box at the bottom of the chat is no edge of it.
    if (p.phase === "dragging" && view && !p.drop && p.x >= clip.left && p.x <= clip.right) {
      const by = p.y < clip.top + EDGE ? -EDGE_STEP : p.y > clip.bottom - EDGE ? EDGE_STEP : 0
      const before = view.scrollTop
      if (by) view.scrollTop = before + by
      // Still at the edge with the pointer at rest: keep going.
      if (view.scrollTop !== before) p.frame = requestAnimationFrame(draw)
    }
    const { left, width } = showMark(mark.current, item, clip)
    const spot = p.phase === "dragging" && !p.drop ? orderSpot(latest.current, p.key) : null
    const blocks = spot && spot.list.ids.length > 1 ? spot.list.keys.map((k) => items.get(k)).map((i) => (i ? blockOf(i) : null)) : []
    if (!spot || !blocks.length || blocks.includes(null)) return hide(line.current)
    const rects = blocks.map((b) => b!.getBoundingClientRect())
    const slot = rects.filter((r) => (r.top + r.bottom) / 2 < p.y).length
    p.to = slotTarget(spot.index, slot)
    const y = slot === 0 ? rects[0]!.top : slot === rects.length ? rects.at(-1)!.bottom : (rects[slot - 1]!.bottom + rects[slot]!.top) / 2
    if (line.current) Object.assign(line.current.style, p.to !== null && y >= clip.top - 1 && y <= clip.bottom + 1 ? { display: "block", top: `${y - 1}px`, left: `${left}px`, width: `${width}px` } : { display: "none" })
  }, [])

  const end = useCallback(() => {
    const p = press.current
    if (!p) return
    press.current = null
    if (p.timer) clearTimeout(p.timer)
    if (p.frame !== null) cancelAnimationFrame(p.frame)
    p.stop()
    if (p.phase === "dragging") dragLook(root.current, false)
    hide(mark.current)
    hide(line.current)
    hide(dropZone.current)
  }, [])
  useEffect(() => end, [end])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      dropClick.current = 0
      if (layer.get().menu) layer.set({ menu: null })
      if (press.current) return end()
      const target = e.target as Element
      // A link keeps its own drag and long press (a PR's number); a mouse drags with its main button only.
      if (!e.isPrimary || e.button !== 0 || e.ctrlKey || target.closest("a[href], input, textarea, select")) return
      const row = grab(target)
      if (!row) return
      const touch = e.pointerType !== "mouse"
      const name = (row.spot ? row.spot.list.names[row.spot.index] : taskOf(qc, row.taskId)?.title) ?? ""
      const p: Press = { pointerId: e.pointerId, touch, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, key: row.key, taskId: row.taskId, name, phase: "pressed", timer: null, frame: null, to: null, drop: null, stop: () => {} }
      const schedule = () => {
        if (p.frame === null) p.frame = requestAnimationFrame(draw)
      }
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== p.pointerId) return
        p.x = ev.clientX
        p.y = ev.clientY
        const far = Math.hypot(p.x - p.x0, p.y - p.y0)
        if (p.phase === "pressed") {
          // A finger that moves before the hold is scrolling the list.
          if (touch) return void (far > HOLD_SLOP && end())
          if (far <= DRAG_SLOP) return
          p.phase = "dragging"
          dragLook(root.current, true)
        } else if (p.phase === "held" && far > HELD_SLOP) {
          p.phase = "dragging"
          dragLook(root.current, true)
        }
        if (p.phase === "dragging") schedule()
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== p.pointerId) return
        const { phase, key, taskId } = p
        if (phase === "dragging") {
          p.x = ev.clientX
          p.y = ev.clientY
          draw()
        }
        const { to, drop } = p
        end()
        if (phase === "pressed") return
        dropClick.current = performance.now() + CLICK_MS
        if (phase === "held") openMenu(key)
        else if (drop && taskId) addTo(drop, taskId)
        else if (to !== null) move(key, to, false)
      }
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === p.pointerId) end()
      }
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || p.phase === "pressed") return
        // Before the drawer's own Escape, which would close it.
        ev.preventDefault()
        ev.stopPropagation()
        dropClick.current = performance.now() + CLICK_MS
        end()
      }
      // A mouse drag that started beside a row's name would select the text it passes.
      const onSelect = (ev: Event) => {
        if (p.phase !== "pressed") ev.preventDefault()
      }
      // The list takes no pointer while a row is dragged (dragLook), so the wheel is passed on to it.
      const onWheel = (ev: WheelEvent) => {
        const item = p.phase === "dragging" ? itemOf(p.key) : null
        const view = item && root.current ? scrollerOf(item, root.current) : null
        if (!view) return
        view.scrollTop += ev.deltaY
        schedule()
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("wheel", onWheel, { passive: true })
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onCancel)
      window.addEventListener("keydown", onKey, true)
      document.addEventListener("selectstart", onSelect)
      p.stop = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("wheel", onWheel)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onCancel)
        window.removeEventListener("keydown", onKey, true)
        document.removeEventListener("selectstart", onSelect)
      }
      if (touch)
        p.timer = setTimeout(() => {
          p.timer = null
          p.phase = "held"
          draw()
        }, HOLD_MS)
      press.current = p
    },
    [addTo, draw, end, grab, itemOf, layer, move, openMenu, qc],
  )

  // The click a release makes, on the row the drag started on, would open it.
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dropClick.current) return
    const drop = performance.now() <= dropClick.current
    dropClick.current = 0
    if (!drop) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // A finger's long press: the hold above is the menu's way in, so the browser's own stays away.
      if (press.current?.touch) return e.preventDefault()
      if ((e.target as Element).closest("a[href]")) return
      const row = grab(e.target)
      if (!row) return
      end()
      // A row with nothing in its menu (a lone task with no chat open) keeps the browser's own.
      if (openMenu(row.key)) e.preventDefault()
    },
    [end, grab, openMenu],
  )

  const treeKeyDown = tree.onKeyDown
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const onItem = e.target instanceof Element && e.target.matches("[role=treeitem]")
      if (onItem && !e.defaultPrevented && !e.ctrlKey && !e.metaKey) {
        const arrow = e.key === "ArrowUp" || e.key === "ArrowDown"
        const menu = !e.altKey && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        const row = e.altKey && arrow ? movable(e.target) : menu ? grab(e.target) : null
        if (row && (!menu || openMenu(row.key))) {
          e.preventDefault()
          if (!menu) move(row.key, e.key === "ArrowUp" ? (e.shiftKey ? "top" : "up") : e.shiftKey ? "bottom" : "down", true)
          return
        }
      }
      treeKeyDown(e)
    },
    [treeKeyDown, grab, movable, move, openMenu],
  )

  // React's touchmove is passive, and Safari only lets a listener that was there when the touch began stop the scroll.
  const treeRef = tree.ref
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el
      const done = treeRef(el)
      if (!el) return
      const hold = (e: TouchEvent) => {
        if (press.current && press.current.phase !== "pressed" && e.cancelable) e.preventDefault()
      }
      el.addEventListener("touchmove", hold, { passive: false })
      return () => {
        el.removeEventListener("touchmove", hold)
        root.current = null
        done?.()
      }
    },
    [treeRef],
  )

  const run = useCallback((key: string, to: OrderMove) => move(key, to, true), [move])
  const reset = useCallback(
    (key: string) => {
      const spot = orderSpot(latest.current, key)
      if (!spot || spot.list.kind === "projects") return
      refocus.current = { key, until: performance.now() + REFOCUS_MS }
      say(`${spot.list.kind === "tasks" ? "Tasks" : "Sub-tasks"} back in automatic order`)
      void resetOrder(qc, spot.list)
    },
    [qc, say],
  )
  const spotOf = useCallback((key: string) => orderSpot(latest.current, key), [])

  return {
    tree: { ...tree, ref, onKeyDown, onPointerDown, onClickCapture, onContextMenu },
    layer: <ReorderLayer store={layer} mark={mark} line={line} drop={dropZone} spotOf={spotOf} onMove={run} onReset={reset} onAdd={addTo} />,
  }
}

const OVERLAY = "pointer-events-none fixed z-60 hidden"

function ReorderLayer({ store, mark, line, drop, spotOf, onMove, onReset, onAdd }: {
  store: ReturnType<typeof layerStore>
  mark: { current: HTMLDivElement | null }
  line: { current: HTMLDivElement | null }
  drop: { current: HTMLDivElement | null }
  spotOf: (key: string) => OrderSpot | null
  onMove: (key: string, to: OrderMove) => void
  onReset: (key: string) => void
  onAdd: (to: ContextTarget, taskId: string) => void
}): ReactNode {
  const { menu, said } = useSyncExternalStore(store.subscribe, store.get, store.get)
  const trigger = useRef<HTMLElement | null>(null)
  trigger.current = menu?.item ?? null
  // While the menu is open its row keeps the frame, so it's plain which row the moves are for. It follows the row as
  // the menu does.
  const item = menu?.item
  useLayoutEffect(() => {
    const el = mark.current
    const tree = item?.closest<HTMLElement>("[role=tree]")
    if (!item || !tree || !el) return
    const place = () => void showMark(el, item, (scrollerOf(item, tree) ?? tree).getBoundingClientRect())
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
      hide(el)
    }
  }, [item, mark])
  const spot = menu ? spotOf(menu.key) : null
  const items: MenuItem[] = []
  // A task's chats first: what a long press on a phone, where it can't be dragged to one, is most likely for.
  for (const to of menu?.taskId ? menu.targets : []) items.push({ icon: MessageSquareQuote, label: `Add to ${to.name}`, run: () => onAdd(to, menu!.taskId!) })
  if (menu && spot) {
    const { list, index } = spot
    const last = list.ids.length - 1
    if (index > 0) items.push({ icon: ArrowUp, label: "Move up", run: () => onMove(menu.key, "up") })
    if (index < last) items.push({ icon: ArrowDown, label: "Move down", run: () => onMove(menu.key, "down") })
    if (index > 0) items.push({ icon: ArrowUpToLine, label: "Move to top", run: () => onMove(menu.key, "top") })
    if (index < last) items.push({ icon: ArrowDownToLine, label: "Move to bottom", run: () => onMove(menu.key, "bottom") })
    if (list.placed) items.push({ icon: ListRestart, label: "Back to automatic order", run: () => onReset(menu.key) })
  }
  return (
    <>
      {/* Read out after every move; a new element each time, so the same words twice are said twice. */}
      <div role="status" aria-live="polite" className="sr-only">
        {said.text && <span key={said.n}>{said.text}</span>}
      </div>
      {createPortal(
        <>
          <div ref={mark} aria-hidden data-reorder-mark className={`${OVERLAY} rounded-lg border border-yard-400/80 bg-yard-400/10`} />
          <div ref={line} aria-hidden data-reorder-line className={`${OVERLAY} h-0.5 rounded-full bg-yard-400`} />
          {/* Over the message box a dragged task would go into: solid ink on a dimmed box, so it reads in both themes. */}
          <div ref={drop} aria-hidden data-context-drop className={`${OVERLAY} items-center justify-center rounded-xl border-2 border-dashed border-yard-400 bg-zinc-950/85 px-3 text-sm font-medium text-yard-300`}>
            <span className="min-w-0 truncate" />
          </div>
        </>,
        document.body,
      )}
      {menu && items.length > 0 && (
        <MessageMenu trigger={trigger} items={items} onClose={() => store.set({ menu: null })} label={menu.targets.length ? `Actions for ${menu.name}` : `Move ${menu.name}`} className="z-60!" />
      )}
    </>
  )
}
