// The cleanup toasts, and a cleanup's progress in the boxes list.
import { cleanupSummary, formatBytes } from "../../../shared/disk"
import type { BoxCleanup, BoxInfo } from "../../../shared/types"
import { toast } from "./toast"

/** Workspaces a Clear box run archived and took off the box. */
const clearedCount = (c: BoxCleanup) => c.steps.find((s) => s.key === "archive")?.removed.length ?? 0
const workspaces = (n: number) => `${n} ${n === 1 ? "workspace" : "workspaces"}`

/** The toast for a finished cleanup, or null while it's still running. */
export function cleanupToast(c: BoxCleanup): { kind: "info" | "error"; title: string; body: string } | null {
  // Routine upkeep is Box Yard's own housekeeping: no toast.
  if (c.status === "running" || c.reason === "routine") return null
  const clear = c.reason === "clear"
  if (c.status === "failed") return { kind: "error", title: `${clear ? "Clearing" : "Cleanup on"} ${c.boxId} failed`, body: c.error ?? "Unknown error" }
  const free = c.freeAfter !== null ? ` ${formatBytes(c.freeAfter)} free now.` : ""
  const short = c.targetFreeBytes !== null && !c.enough ? " Still low: tasks that can't go elsewhere wait for room." : ""
  const summary = cleanupSummary(c)
  const kept = clear ? c.steps.find((s) => s.key === "archive")?.skipped : null
  const lead = clear ? `Archived and removed ${workspaces(clearedCount(c))}; ${summary}` : `${summary[0]!.toUpperCase()}${summary.slice(1)}`
  const note = kept?.startsWith("kept ") ? ` ${kept[0]!.toUpperCase()}${kept.slice(1)}.` : ""
  return { kind: (c.enough || c.targetFreeBytes === null) && !note ? "info" : "error", title: `${clear ? "Cleared" : "Cleaned up"} ${c.boxId}`, body: `${lead}.${free}${short}${note}` }
}

/** Toast a finished cleanup (SSE box.cleanup). */
export function announceCleanup(c: BoxCleanup) {
  const t = cleanupToast(c)
  if (!t) return
  if (t.kind === "error") toast.error(t.title, t.body)
  else toast.info(t.title, t.body, { duration: 6000 })
}

/** The boxes list with one box's cleanup replaced; the same list when the box isn't in it. */
export function withCleanup(list: BoxInfo[] | undefined, c: BoxCleanup): BoxInfo[] | undefined {
  if (!list?.some((b) => b.id === c.boxId)) return list
  return list.map((b) => (b.id === c.boxId ? { ...b, cleanup: c } : b))
}
