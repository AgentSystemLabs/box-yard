// The way up the tree: the Coordinator › a Captain › a task › its sub-tasks (components/TreeNav.tsx). A task panel's
// header shows the levels above it as crumbs. On a desktop a crumb opens its level as anything opened does (crumbTo),
// or goes Back to it when that's where the task was opened from. The rest of this is a phone's (under SIDEBAR_INLINE),
// where the task's panel covers the chat. A Captain's header gets the Coordinator's crumb there.
//
// History, so Back retraces Cody's steps and never walks through a level Cody didn't visit:
// - Up (a task crumb) never adds an entry. When the level is the entry right behind, it's history's Back
//   (closeStackFrom); otherwise this entry becomes it.
// - A chat crumb (the Coordinator, the Captain) is a return when it's the chat the task opened beside: the task's trail
//   unwinds (closeOverlay), as if Cody had backed out of it. Any other chat is a trip: an entry of its own, so Back
//   brings the task back. A chat crumb in a Captain's header is a trip too.
// - The entries a trip leaves and adds say which chat they show (CHAT), so Back and Forward show each with its chat
//   (the centre chat is otherwise memory only: lib/projectBar.ts).
import { useEffect, useMemo } from "react"
import type { Task } from "../../../shared/types"
import { QUIET, useProjects, useTasks } from "./queries"
import { closeTaskPanel, closeOverlay, overlayAt } from "./overlays"
import { chainHref, closeStackFrom, panelsAt } from "./panelStack"
import { CHAT, FROM, showOnly, type OpenedFrom } from "./navigation"
import { chatProjectFilter, pickProject, setChatProjectFilter, useChatProjectFilter } from "./projectBar"

export { CHAT }
/** History state: the panel trail's mark (lib/overlays.ts). */
const OVERLAY_MARK = "boxyardOverlay"

const currentHref = () => location.pathname + location.search + location.hash

/** The task's chain, its top task first and the task last. */
export function chainOf(tasks: readonly Task[] | undefined, id: string): Task[] {
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]))
  const out: Task[] = []
  for (let t = byId.get(id); t && out.length < 12 && !out.includes(t); t = t.parentTaskId ? byId.get(t.parentTaskId) : undefined) out.unshift(t)
  return out
}

/** Where a task sits: its project and its chain (top task first). */
export function useTaskPath(id: string) {
  const tasks = useTasks(QUIET).data
  const projects = useProjects().data
  return useMemo(() => {
    const chain = chainOf(tasks, id)
    const project = projects?.find((p) => p.id === (chain[0]?.projectId ?? tasks?.find((t) => t.id === id)?.projectId))
    return { tasks, chain, project }
  }, [tasks, projects, id])
}

/**
 * The Coordinator (`chat` null) or a project's Captain. From a task: a return when it's the chat the task opened beside,
 * else a trip. From a chat: a trip.
 */
export function goChat(chat: string | null) {
  const here = chatProjectFilter()
  const task = overlayAt(currentHref())?.kind === "session"
  if (task && chat === here) return closeOverlay()
  if (!task && chat === here) return
  // This entry keeps its chat for Back, and the new one says its own.
  history.replaceState({ ...history.state, [CHAT]: here }, "")
  if (task) closeTaskPanel({ [CHAT]: chat })
  else history.pushState({ [CHAT]: chat }, "", currentHref())
  if (chat === null) setChatProjectFilter(null)
  else pickProject(chat)
}

/**
 * On a desktop, the crumb to level `ref` (the Coordinator's, a Captain's or a task's) in panel `here`'s header: Back,
 * when `here` was opened from a link in that level and is still what this entry opened; else the level opens as
 * anything does (showOnly), a step of its own.
 */
export function crumbTo(ref: string, here: string) {
  const from = history.state?.[FROM] as OpenedFrom | undefined
  if (from && from.opened === here && from.from === ref) return history.back()
  showOnly(ref)
}

/** Up to task `taskId`, one of the shown task's: close the panels past it, or show its chain in this entry. */
export function goTask(taskId: string, tasks: readonly Task[] | undefined) {
  const href = currentHref()
  const panels = panelsAt(href)
  const at = panels.indexOf(taskId)
  if (at >= 0) return at + 1 < panels.length ? closeStackFrom(at + 1) : undefined
  const parents = new Map((tasks ?? []).map((t) => [t.id, t.parentTaskId ?? null]))
  const to = chainHref(taskId, (id) => parents.get(id) ?? null)
  // This entry now opens the chain's top task: its trail's mark says so, so a return to the chat still unwinds it.
  const mark = history.state?.[OVERLAY_MARK]
  const top = overlayAt(to)
  history.replaceState(mark && top ? { ...history.state, [OVERLAY_MARK]: { ...mark, opened: top } } : history.state, "", to)
}

/**
 * Mounted once (App). An entry that says its chat shows it again when Back or Forward returns to it, and keeps saying
 * the chat shown while it's current (a pick in the chat switcher, a task bringing its Captain).
 */
export function useChatHistory() {
  const chat = useChatProjectFilter()
  useEffect(() => {
    const onPop = () => {
      const state = history.state
      if (state && CHAT in state) setChatProjectFilter(state[CHAT] ?? null)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  useEffect(() => {
    const state = history.state
    if (state && CHAT in state && state[CHAT] !== chat) history.replaceState({ ...state, [CHAT]: chat }, "")
  }, [chat])
}
