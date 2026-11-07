// Reads deletion guards from the cache when invoked, then rechecks after confirmation.
import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { CaptainState, Project, Task } from "../../../shared/types"
import { keys, useDeleteProject, useDeleteTask } from "./queries"
import { confirmDialog } from "./confirm"
import { sidebarDeleteBlocked, sidebarDeleteQueued, sidebarDeleteTasks, type SidebarDeleteTarget } from "./sidebarDelete"
import { chatProjectFilter, setChatProjectFilter } from "./projectBar"
import { panelsAt, panelsHref, viewOf } from "./panelStack"
import { chatRef, setPinned } from "./columns"
import { navigateApp } from "./navigation"

export function useRestingDelete(target: SidebarDeleteTarget, close?: () => void) {
  const qc = useQueryClient()
  const deleteTask = useDeleteTask()
  const deleteProject = useDeleteProject()
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const remove = async () => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    const project = target.kind === "project"
    const blockedDialog = (body: string) => confirmDialog({ title: `Can't delete ${project ? "project" : "task"}`, body, confirmLabel: "OK" })
    try {
      const tasks = qc.getQueryData<Task[]>(keys.tasks)
      const projects = qc.getQueryData<Project[]>(keys.projects)
      const captain = qc.getQueryData<CaptainState>(keys.captain(target.projectId))
      if (!tasks || (project && (!projects || !captain))) {
        await blockedDialog("Wait for the task list and running work to load, then try deleting again.")
        return
      }
      const blocked = sidebarDeleteBlocked(target, tasks, Boolean(captain?.busy || captain?.compacting || captain?.compactQueued))
      if (blocked) { await blockedDialog(blocked); return }
      const queued = sidebarDeleteQueued(target, tasks)
      const descendants = Math.max(0, sidebarDeleteTasks(target, tasks).length - 1)
      const body = descendants ? `Delete this task and its ${descendants} sub-task${descendants === 1 ? "" : "s"}, their workspaces and archives?` : "Delete this task, its workspace and its archive?"
      const ok = await confirmDialog(project
        ? { title: "Delete project?", body: `Delete ${target.name} and all its tasks? This can't be undone.`, confirmLabel: "Delete project", danger: true }
        : { title: "Delete task?", body: body + (queued ? ` This also permanently deletes ${queued} queued message${queued === 1 ? "" : "s"}. They won't be sent.` : ""), confirmLabel: "Delete task", danger: true })
      if (!ok) { close?.(); return }
      const latest = qc.getQueryData<Task[]>(keys.tasks)
      const owner = qc.getQueryData<CaptainState>(keys.captain(target.projectId))
      if (!latest || (project && !owner)) { await blockedDialog("Wait for the task list and running work to load, then try deleting again."); return }
      if (project ? !qc.getQueryData<Project[]>(keys.projects)?.some((p) => p.id === target.id) : !latest.some((t) => t.id === target.id)) { close?.(); return }
      const reason = sidebarDeleteBlocked(target, latest, Boolean(owner?.busy || owner?.compacting || owner?.compactQueued))
      if (reason) { await blockedDialog(reason); return }
      if (sidebarDeleteQueued(target, latest) !== queued) { await blockedDialog("Queued messages changed. Review them and confirm deletion again."); return }
      const removed = new Set(sidebarDeleteTasks(target, latest).map((t) => t.id))
      // Wait for success before moving the current view; mutation hooks restore optimistic rows and toast errors.
      try {
        await (project ? deleteProject : deleteTask).mutateAsync({ id: target.id, ifResting: true, ...(queued ? { discardQueued: queued } : {}) })
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
      } catch (error) {
        // The shared mutation restores rows; a dialog stays visible above a phone's navigation drawer.
        await blockedDialog(error instanceof Error ? error.message : "Deletion failed. Try again.")
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { pending, remove }
}
