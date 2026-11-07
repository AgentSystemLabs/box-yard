import { useEffect, useId, useRef, useState, useSyncExternalStore, type HTMLAttributes, type PointerEvent } from "react"
import { ArrowLeftRight } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useCaptainState, useProjects, useTasks } from "../lib/queries"
import { currentConfirm } from "../lib/confirm"
import { useMarkDone } from "../lib/markDone"
import { sidebarDeleteBlocked, type SidebarDeleteTarget } from "../lib/sidebarDelete"
import { useRestingDelete } from "../lib/restingDelete"
import { cx } from "./ui"

// One reveal across both copies of a task and the sidebar/drawer. Per-row snapshots keep unchanged rows memo'd.
let revealed: string | null = null
let side: "left" | "right" = "right"
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
function reveal(id: string | null, edge = side) {
  if (id === revealed && edge === side) return
  revealed = id
  side = edge
  for (const cb of listeners) cb()
}
const ACTION_WIDTH = 88
const INTENT = 12
const COMMIT = 36

type Drag = { id: number; x: number; y: number; start: number; offset: number; axis: "x" | "y" | null }

/** A still reveal: pan-y leaves vertical scrolling to the browser; only a deliberate horizontal drag captures it.
 * The treeitem stays in place, with its original name, focus and controls. Its content alone slides under the clip.
 * Shift+F10 / the context menu key (or a context click) reveals and focuses Delete; Escape returns to the tree row.
 */
export function SidebarDeleteRow({ target, enabled = true, doneTask, subtasks = 0, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { target: SidebarDeleteTarget; enabled?: boolean; doneTask?: Task; subtasks?: number }) {
  const id = useId()
  const edge = useSyncExternalStore(subscribe, () => enabled && revealed === id ? side : null, () => null)
  const open = edge !== null
  const row = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppress = useRef(false)
  const swipedAt = useRef(-Infinity)
  const [offset, setOffset] = useState<number | null>(null)
  const width = ACTION_WIDTH * (doneTask ? 2 : 1)
  // Positive offsets reveal actions on the left, negative ones on the right. Either swipe direction can open them.
  const shown = offset ?? (open ? (edge === "left" ? width : -width) : 0)

  useEffect(() => () => { if (revealed === id) reveal(null) }, [id])
  useEffect(() => {
    if (!open) return
    const outside = (e: Event) => { if (!row.current?.contains(e.target as Node)) reveal(null) }
    const scroll = (e: Event) => { if (e.target instanceof Node && row.current && e.target.contains(row.current)) reveal(null) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229 || currentConfirm() || !row.current?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopPropagation()
      if (row.current?.contains(document.activeElement)) row.current.focus({ preventScroll: true })
      reveal(null)
    }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", key)
    document.addEventListener("scroll", scroll, true)
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", key)
      document.removeEventListener("scroll", scroll, true)
    }
  }, [open])

  if (!enabled) return <div {...props} className={className}>{children}</div>

  const finish = (e: PointerEvent<HTMLDivElement>, cancel = false) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.axis === "x") {
      const keep = cancel ? Boolean(d.start) : Math.abs(d.offset) >= (d.start ? width - COMMIT : COMMIT)
      reveal(keep ? id : null, (cancel ? d.start : d.offset) > 0 ? "left" : "right")
      // The compatibility click is swallowed in capture, before navigation, double-tap or nested actions see it.
      suppress.current = true
      swipedAt.current = performance.now()
    }
    setOffset(null)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const show = (focus = true) => {
    reveal(id, "right")
    if (focus) requestAnimationFrame(() => row.current?.querySelector<HTMLButtonElement>("[data-sidebar-delete]")?.focus({ preventScroll: true }))
  }
  return (
    <div
      {...props}
      ref={row}
      aria-keyshortcuts="Shift+F10"
      aria-description="Swipe left or right, tap Actions, or press Shift+F10 to reveal actions."
      data-delete-revealed={open || undefined}
      className={cx(className, "relative", shown !== 0 && "overflow-hidden min-h-11")}
      style={{ ...props.style, touchAction: "pan-y" }}
      onContextMenu={(e) => {
        if ((e.target as Element).closest("a,button:not([data-tree-open])")) return
        e.preventDefault()
        show()
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault()
          e.stopPropagation()
          show()
        }
      }}
      onPointerDownCapture={(e) => {
        if (e.button !== 0 || e.isPrimary === false) return
        suppress.current = false
        if ((e.target as Element).closest("a,button:not([data-tree-open]),input,[draggable=true]")) return
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: shown, offset: shown, axis: null }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= INTENT) {
          d.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? "x" : "y"
          if (d.axis === "x") {
            e.currentTarget.setPointerCapture?.(e.pointerId)
            if (revealed !== id) reveal(null)
          }
        }
        if (d.axis !== "x") return
        e.preventDefault()
        // An open row reverses back to closed; crossing it doesn't immediately open the opposite edge.
        d.offset = Math.max(d.start > 0 ? 0 : -width, Math.min(d.start < 0 ? 0 : width, d.start + dx))
        setOffset(d.offset)
      }}
      onPointerUp={(e) => finish(e)}
      onPointerCancel={(e) => finish(e, true)}
      // Touch starts with implicit capture on its hit target. Losing that child capture while we take it is expected.
      onLostPointerCapture={(e) => { if (e.target === e.currentTarget) finish(e, true) }}
      onClickCapture={(e) => {
        if (suppress.current && e.detail !== 0) {
          suppress.current = false
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (open && !(e.target as Element).closest("[data-sidebar-actions], [data-delete-task], [data-row-actions]")) {
          e.preventDefault()
          e.stopPropagation()
          reveal(null)
        }
      }}
      onDoubleClickCapture={(e) => { if (open || performance.now() - swipedAt.current < 500) { e.preventDefault(); e.stopPropagation() } }}
    >
      <div className="relative flex min-w-0 flex-1 self-stretch items-center rounded-[inherit]" style={{ transform: shown ? `translateX(${shown}px)` : undefined, minHeight: shown ? 44 : undefined }}>
        {children}
        <button
          type="button"
          data-row-actions
          tabIndex={props.role === "treeitem" ? -1 : undefined}
          aria-label={`Actions for ${target.name}`}
          aria-expanded={open}
          aria-controls={open ? `${id}-actions` : undefined}
          title="Swipe left or right, or tap for actions"
          className="mr-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-100 pointer-coarse:flex"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (open) reveal(null); else show(e.detail === 0) }}
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      {open && (
        <div id={`${id}-actions`} data-sidebar-actions role="group" aria-label={`Actions for ${target.name}`} className={cx("absolute inset-y-0 z-3 flex overflow-hidden rounded-lg", edge === "left" ? "left-0" : "right-0")}>
          {doneTask && <DoneAction task={doneTask} subtasks={subtasks} close={() => reveal(null)} />}
          <DeleteAction target={target} close={() => reveal(null)} />
        </div>
      )}
    </div>
  )
}

function DeleteAction({ target, close }: { target: SidebarDeleteTarget; close: () => void }) {
  const tasks = useTasks()
  const projects = useProjects()
  const captain = useCaptainState(target.projectId)
  const { pending, remove } = useRestingDelete(target, close)
  const blocked = !tasks.data || (target.kind === "project" && (!projects.data || !captain.data)) ? "Checking running work…" : sidebarDeleteBlocked(target, tasks.data, Boolean(captain.data?.busy || captain.data?.compacting || captain.data?.compactQueued))
  return (
    <button
      type="button"
      data-sidebar-delete
      aria-label={`Delete ${target.name}`}
      disabled={pending}
      title={blocked ?? `Delete ${target.name}…`}
      className="min-h-11 w-22 bg-red-950 px-2 text-sm font-medium text-red-200 hover:bg-red-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-200 disabled:cursor-not-allowed disabled:text-red-300/60"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void remove()
      }}
    >
      {pending ? "Deleting…" : "Delete"}
      {blocked && <span className="sr-only">: {blocked}</span>}
    </button>
  )
}

function DoneAction({ task, subtasks, close }: { task: Task; subtasks: number; close: () => void }) {
  const markDone = useMarkDone()
  return (
    <button type="button" data-sidebar-done aria-label={`Mark ${task.title}${subtasks ? ` and its ${subtasks} sub-task${subtasks === 1 ? "" : "s"}` : ""} done`}
      className="min-h-11 w-22 bg-emerald-950 px-2 text-sm font-medium text-emerald-200 hover:bg-emerald-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-200"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void markDone(task).then((ok) => { if (ok) close() }) }}
    >Mark done</button>
  )
}
