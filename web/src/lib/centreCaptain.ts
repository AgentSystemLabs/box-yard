// The Captain the centre shows. On a desktop it's the chat last opened (lib/columns.ts arrangement): a task opened
// hides an unpinned chat rather than switching it, so it never follows the task. On a phone (no pins there, and the
// panels a sheet over the chat) it does: with a Captain in the centre, a task opening in a panel brings its own
// project's Captain, however it opened: the sidebar, the palette, a card, a link, Back/Forward or a deep link all end in
// the panels' URL, so the Captain is derived from that, never synced per entry point. It follows the rightmost task
// (lib/columns.ts followedTask). The other way round, picking another project's Captain closes the tasks
// (setChatProjectFilter in lib/projectBar.ts). The Coordinator oversees every project, so a task opens beside it as it is.
import { useCallback, useLayoutEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Task } from "../../../shared/types"
import { fetchTasks, keys } from "./queries"
import { setChatProjectFilter, useChatProjectFilter } from "./projectBar"
import { setTaskProbe } from "./overlays"
import { followedTask } from "./columns"
import { usePanels } from "./panelStack"
import { SIDEBAR_INLINE, useMinWidth } from "./sidebar"

/** The centre's Captain: the picked one, but with one picked and a task it follows beside it, the task's project's. */
export const centreCaptain = (picked: string | null, taskProject: string | null): string | null => (picked !== null && taskProject ? taskProject : picked)

/**
 * Mounted once (App): the Captain the centre shows (null: the Coordinator). Derived while rendering, so no frame
 * pairs a task with another project's Captain on a phone; App re-renders only when the open task's project changes.
 */
export function useCentreCaptain(): string | null {
  const qc = useQueryClient()
  const picked = useChatProjectFilter()
  const panels = usePanels()
  const desktop = useMinWidth(SIDEBAR_INLINE)
  const taskId = desktop ? null : followedTask(panels)
  const select = useCallback((list: Task[]) => (taskId && list.find((t) => t.id === taskId)?.projectId) || null, [taskId])
  // Only reads the list (the sidebar and live updates keep it fresh), and only with a Captain picked: never before sign-in.
  const taskProject = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select, enabled: picked !== null, staleTime: Infinity }).data ?? null
  const captain = centreCaptain(picked, taskProject)
  useLayoutEffect(() => {
    setTaskProbe((id) => {
      const t = qc.getQueryData<Task[]>(keys.tasks)?.find((x) => x.id === id)
      return t ? { projectId: t.projectId, parentTaskId: t.parentTaskId ?? null } : null
    })
    return () => setTaskProbe(() => null)
  }, [qc])
  // The switch sticks: closing the task leaves its Captain in the centre, and the sidebar marks it.
  useLayoutEffect(() => {
    if (captain !== picked) setChatProjectFilter(captain)
  }, [captain, picked])
  return captain
}
