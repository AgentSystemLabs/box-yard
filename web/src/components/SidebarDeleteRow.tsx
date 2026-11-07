import { useEffect, useId, useRef, useState, useSyncExternalStore, type HTMLAttributes, type PointerEvent } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { CaptainState, Project, Task } from "../../../shared/types"
import { keys, useCaptainState, useDeleteProject, useDeleteTask, useProjects, useTasks } from "../lib/queries"
import { confirmDialog, currentConfirm } from "../lib/confirm"
import { sidebarDeleteBlocked, sidebarDeleteTasks, type SidebarDeleteTarget } from "../lib/sidebarDelete"
import { chatProjectFilter, setChatProjectFilter } from "../lib/projectBar"
import { panelsAt, panelsHref, viewOf } from "../lib/panelStack"
import { chatRef, setPinned } from "../lib/columns"
import { navigateApp } from "../lib/navigation"
import { toast } from "../lib/toast"
import { cx } from "./ui"

// One reveal across both copies of a task and the sidebar/drawer. Per-row snapshots keep unchanged rows memo'd.
let revealed: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
function reveal(id: string | null) {
  if (id === revealed) return
  revealed = id
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
export function SidebarDeleteRow({ target, enabled = true, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { target: SidebarDeleteTarget; enabled?: boolean }) {
  const id = useId()
  const open = useSyncExternalStore(subscribe, () => enabled && revealed === id, () => false)
  const row = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppress = useRef(false)
  const swipedAt = useRef(-Infinity)
  const [offset, setOffset] = useState<number | null>(null)
  const shown = offset ?? (open ? ACTION_WIDTH : 0)

  useEffect(() => () => { if (revealed === id) reveal(null) }, [id])
  useEffect(() => {
    if (!open) return
    const outside = (e: Event) => { if (!row.current?.contains(e.target as Node)) reveal(null) }
    const scroll = (e: Event) => { if (e.target instanceof Node && row.current && e.target.contains(row.current)) reveal(null) }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || currentConfirm()) return
      e.preventDefault()
      e.stopPropagation()
      if (row.current?.contains(document.activeElement)) row.current.focus({ preventScroll: true })
      reveal(null)
    }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", key, true)
    document.addEventListener("scroll", scroll, true)
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", key, true)
      document.removeEventListener("scroll", scroll, true)
    }
  }, [open])

  if (!enabled) return <div {...props} className={className}>{children}</div>

  const finish = (e: PointerEvent<HTMLDivElement>, cancel = false) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.axis === "x") {
      reveal(cancel ? (d.start ? id : null) : d.offset >= (d.start ? ACTION_WIDTH - COMMIT : COMMIT) ? id : null)
      // The compatibility click is swallowed in capture, before navigation, double-tap or nested actions see it.
      suppress.current = true
      swipedAt.current = performance.now()
    }
    setOffset(null)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const show = () => {
    reveal(id)
    requestAnimationFrame(() => row.current?.querySelector<HTMLButtonElement>("[data-sidebar-delete]")?.focus({ preventScroll: true }))
  }
  return (
    <div
      {...props}
      ref={row}
      aria-keyshortcuts="Shift+F10"
      aria-description="Swipe left or press Shift+F10 to reveal Delete."
      data-delete-revealed={open || undefined}
      className={cx(className, "relative", shown > 0 && "overflow-hidden min-h-11")}
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
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: open ? ACTION_WIDTH : 0, offset: open ? ACTION_WIDTH : 0, axis: null }
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
        d.offset = Math.max(0, Math.min(ACTION_WIDTH, d.start - dx))
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
        if (open && !(e.target as Element).closest("[data-sidebar-delete]")) {
          e.preventDefault()
          e.stopPropagation()
          reveal(null)
        }
      }}
      onDoubleClickCapture={(e) => { if (open || performance.now() - swipedAt.current < 500) { e.preventDefault(); e.stopPropagation() } }}
    >
      <div className="relative flex min-w-0 flex-1 self-stretch items-center rounded-[inherit]" style={{ transform: shown ? `translateX(-${shown}px)` : undefined, minHeight: shown ? 44 : undefined }}>
        {children}
      </div>
      {open && <DeleteAction target={target} close={() => reveal(null)} />}
    </div>
  )
}

function DeleteAction({ target, close }: { target: SidebarDeleteTarget; close: () => void }) {
  const qc = useQueryClient()
  const tasks = useTasks()
  const projects = useProjects()
  const captain = useCaptainState(target.projectId)
  const deleteTask = useDeleteTask()
  const deleteProject = useDeleteProject()
  const [confirming, setConfirming] = useState(false)
  const blocked = !tasks.data || !projects.data || (target.kind === "project" && !captain.data) ? "Checking running work…" : sidebarDeleteBlocked(target, tasks.data, Boolean(captain.data?.busy))
  const pending = confirming || deleteTask.isPending || deleteProject.isPending
  return (
    <button
      type="button"
      data-sidebar-delete
      aria-label={`Delete ${target.name}`}
      disabled={Boolean(blocked) || pending}
      title={blocked ?? `Delete ${target.name}…`}
      className="absolute inset-y-0 right-0 z-3 min-h-11 w-22 rounded-r-lg bg-red-950 px-2 text-sm font-medium text-red-200 hover:bg-red-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-red-200 disabled:cursor-not-allowed disabled:text-red-300/60"
      onClick={async () => {
        if (pending || blocked) return
        setConfirming(true)
        const project = target.kind === "project"
        const descendants = Math.max(0, sidebarDeleteTasks(target, tasks.data ?? []).length - 1)
        const ok = await confirmDialog(project
          ? { title: "Delete project?", body: `Delete ${target.name} and all its tasks? This can't be undone.`, confirmLabel: "Delete project", danger: true }
          : { title: "Delete task?", body: descendants ? `Delete this task and its ${descendants} sub-task${descendants === 1 ? "" : "s"}, their workspaces and archives?` : "Delete this task, its workspace and its archive?", confirmLabel: "Delete task", danger: true })
        setConfirming(false)
        if (!ok) { close(); return }
        const latest = qc.getQueryData<Task[]>(keys.tasks)
        const owner = qc.getQueryData<CaptainState>(keys.captain(target.projectId))
        if (!latest || (project && !owner)) return
        if (project ? !qc.getQueryData<Project[]>(keys.projects)?.some((p) => p.id === target.id) : !latest.some((t) => t.id === target.id)) { close(); return }
        const reason = sidebarDeleteBlocked(target, latest, Boolean(owner?.busy))
        if (reason) { toast.info("Delete cancelled", reason); return }
        const removed = new Set(sidebarDeleteTasks(target, latest).map((t) => t.id))
        // Wait for success before moving the current view; mutation hooks restore optimistic rows and toast errors.
        try {
          await (project ? deleteProject : deleteTask).mutateAsync(target.id)
          qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => !removed.has(t.id)))
          const href = location.pathname + location.search + location.hash
          const panels = panelsAt(href)
          const kept = panels.filter((ref) => {
            const view = viewOf(ref)
            return view.kind === "session" ? !removed.has(view.id) : !(project && view.kind === "captain" && view.id === target.id)
          })
          for (const ref of panels) if (!kept.includes(ref)) setPinned(ref, false)
          if (kept.length !== panels.length) navigateApp(panelsHref(href, kept), { replace: true })
          if (project) setPinned(chatRef(target.id), false)
          if (project && chatProjectFilter() === target.id) setChatProjectFilter(null)
          close()
        } catch { /* The shared mutation reports the error and restores the rows. */ }
      }}
    >
      {deleteTask.isPending || deleteProject.isPending ? "Deleting…" : "Delete"}
      {blocked && <span className="sr-only">: {blocked}</span>}
    </button>
  )
}
