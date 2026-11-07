// Shared by sidebar swipe actions and explicit failed-task delete buttons. Reads the cache only when invoked,
// so adding an action to every failed row does not subscribe those rows to the full task list.
import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { CaptainState, Project, Task } from "../../../shared/types"
import { keys, useDeleteProject, useDeleteTask } from "./queries"
import { confirmDialog } from "./confirm"
import { sidebarDeleteBlocked, sidebarDeleteTasks, type SidebarDeleteTarget } from "./sidebarDelete"
import { chatProjectFilter, setChatProjectFilter } from "./projectBar"
import { panelsAt, panelsHref, viewOf } from "./panelStack"
import { chatRef, setPinned } from "./columns"
import { navigateApp } from "./navigation"
import { toast } from "./toast"

export function useRestingDelete(target: SidebarDeleteTarget, close?: () => void) {
  const qc = useQueryClient()
  const deleteTask = useDeleteTask()
  const deleteProject = useDeleteProject()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const remove = async () => {
    if (busy.current) return
    const tasks = qc.getQueryData<Task[]>(keys.tasks)
    const projects = qc.getQueryData<Project[]>(keys.projects)
    const captain = qc.getQueryData<CaptainState>(keys.captain(target.projectId))
    if (!tasks || !projects || (target.kind === "project" && !captain)) {
      toast.info("Delete cancelled", "Checking running work…")
      return
    }
    const blocked = sidebarDeleteBlocked(target, tasks, Boolean(captain?.busy || captain?.compacting || captain?.compactQueued))
    if (blocked) { toast.info("Delete cancelled", blocked); return }
    busy.current = true
    setPending(true)
    try {
      const project = target.kind === "project"
      const descendants = Math.max(0, sidebarDeleteTasks(target, tasks).length - 1)
      const ok = await confirmDialog(project
        ? { title: "Delete project?", body: `Delete ${target.name} and all its tasks? This can't be undone.`, confirmLabel: "Delete project", danger: true }
        : { title: "Delete task?", body: descendants ? `Delete this task and its ${descendants} sub-task${descendants === 1 ? "" : "s"}, their workspaces and archives?` : "Delete this task, its workspace and its archive?", confirmLabel: "Delete task", danger: true })
      if (!ok) { close?.(); return }
      const latest = qc.getQueryData<Task[]>(keys.tasks)
      const owner = qc.getQueryData<CaptainState>(keys.captain(target.projectId))
      if (!latest || (project && !owner)) return
      if (project ? !qc.getQueryData<Project[]>(keys.projects)?.some((p) => p.id === target.id) : !latest.some((t) => t.id === target.id)) { close?.(); return }
      const reason = sidebarDeleteBlocked(target, latest, Boolean(owner?.busy || owner?.compacting || owner?.compactQueued))
      if (reason) { toast.info("Delete cancelled", reason); return }
      const removed = new Set(sidebarDeleteTasks(target, latest).map((t) => t.id))
      // Wait for success before moving the current view; mutation hooks restore optimistic rows and toast errors.
      try {
        await (project ? deleteProject : deleteTask).mutateAsync({ id: target.id, ifResting: true })
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
        close?.()
      } catch { /* The shared mutation reports the error and restores the rows. */ }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { pending, remove }
}
