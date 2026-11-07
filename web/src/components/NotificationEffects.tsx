import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { useNotifications, useTasks } from "../lib/queries"
import { markRead, viewingTaskId } from "../lib/notifications"
import { inInbox, usePendingCloses } from "../lib/inbox"
import { browserNotificationsOn, listenForNotificationClicks, registerNotificationWorker } from "../lib/browserNotifications"
import { navigateApp } from "../lib/navigation"

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb)
  return () => document.removeEventListener("visibilitychange", cb)
}
const isVisible = () => document.visibilityState === "visible"

/**
 * Side effects with no UI: the Waiting on you count in the tab title, opening a task (in a visible
 * tab) marks its notifications read, and clicking a browser notification opens what it's about.
 */
export function NotificationEffects() {
  const qc = useQueryClient()
  const [location] = useLocation()
  const { data } = useNotifications()
  const tasks = useTasks()
  const closing = usePendingCloses()
  const visible = useSyncExternalStore(subscribeVisibility, isVisible)
  const waiting = tasks.data?.filter((t) => inInbox(t, closing)).length ?? 0

  useEffect(() => {
    document.title = waiting ? `(${waiting}) Box Yard` : "Box Yard"
  }, [waiting])

  useEffect(() => {
    // Keeps the notification worker current once Cody has turned browser notifications on.
    if (browserNotificationsOn()) void registerNotificationWorker()
    return listenForNotificationClicks(({ href, taskId }) => {
      navigateApp(href)
      if (taskId) void markRead(qc, { taskId })
    })
  }, [qc])

  const viewing = visible ? viewingTaskId(location) : null
  const viewingHasUnread = Boolean(viewing && data?.some((n) => n.taskId === viewing && !n.readAt))
  useEffect(() => {
    if (viewing && viewingHasUnread) void markRead(qc, { taskId: viewing })
  }, [qc, viewing, viewingHasUnread])

  return null
}
