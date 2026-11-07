// Resize display for the Boxes page: the size table rows, the modal's "what will happen" lines, and the toasts.
import { compareSizes, initiatorLabel, resizeSummary, resizeTitle, type BoxResize } from "../../../shared/boxSizes"
import { type BoxInfo, type BoxSize } from "../../../shared/types"
import { toast } from "./toast"

export const direction = (from: BoxSize, to: BoxSize) => (compareSizes(to, from) > 0 ? "up" : compareSizes(to, from) < 0 ? "down" : "same")

/** The toast for a resize at any stage. */
export function resizeToast(r: BoxResize, projectName?: (id: string) => string): { kind: "progress" | "info" | "error"; title: string; body: string } {
  const who = r.by.kind === "cody" ? "" : `${initiatorLabel(r.by, r.by.kind === "captain" ? projectName?.(r.by.projectId) : undefined)}${r.reason ? `: ${r.reason}` : ""}. `
  if (r.status === "running") {
    const done = r.steps.filter((s) => s.status === "done").length
    return { kind: "progress", title: resizeTitle(r), body: `${who}${resizeSummary(r)} (${done + 1} of ${r.steps.length})` }
  }
  const summary = resizeSummary(r)
  return { kind: r.status === "failed" ? "error" : "info", title: resizeTitle(r), body: `${who}${summary[0]!.toUpperCase()}${summary.slice(1)}${/[.!?]$/.test(summary) ? "" : "."}` }
}

/** Show or update a resize's toast (SSE box.resize). */
export function announceResize(r: BoxResize) {
  const t = resizeToast(r)
  const key = `resize:${r.id}`
  if (t.kind === "progress") toast.progress(key, t.title, t.body)
  else toast.settle(key, t.kind, t.title, t.body)
}

/** The boxes list with a resize's report on its boxes. */
export function withResize(list: BoxInfo[] | undefined, r: BoxResize): BoxInfo[] | undefined {
  if (!list?.some((b) => b.id === r.boxId || b.id === r.newBoxId)) return list
  return list.map((b) =>
    b.id === r.boxId || b.id === r.newBoxId ? { ...b, resize: r, operation: r.status === "running" ? "resize" : b.operation === "resize" ? null : b.operation } : b,
  )
}
