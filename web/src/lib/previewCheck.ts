// While a task's page shows a preview, the server looks now and then whether its server still answers, and drops the
// preview (a live task update) once it doesn't (server/previewWatch.ts). Only while the page is in view: a hidden tab
// asks nothing, and coming back to it asks at once. The server rate-limits the looks per task and never wakes a
// sleeping box for one, so several open pages or a flurry of tab switches cost no more.
import { useEffect } from "react"
import { api } from "./api"

/** How often an open page asks (the server's PREVIEW_CHECK_MS). */
export const PREVIEW_CHECK_EVERY_MS = 60_000

export function usePreviewCheck(taskId: string, showsPreview: boolean) {
  useEffect(() => {
    if (!showsPreview) return
    const ask = () => {
      if (document.visibilityState !== "visible") return
      api(`/api/tasks/${encodeURIComponent(taskId)}/previews/check`, { method: "POST", priority: "low" }).catch(() => {})
    }
    ask()
    const timer = setInterval(ask, PREVIEW_CHECK_EVERY_MS)
    document.addEventListener("visibilitychange", ask)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", ask)
    }
  }, [taskId, showsPreview])
}
