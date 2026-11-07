// Project snapshots in the UI (shared/snapshots.ts): the toasts a snapshot job shows as it runs.
import { initiatorLabel } from "../../../shared/boxSizes"
import { snapshotJobLine, type SnapshotJob } from "../../../shared/snapshots"
import { toast } from "./toast"

/** The toast for a snapshot job at any stage. */
export function snapshotToast(job: SnapshotJob, projectName?: string): { kind: "progress" | "info" | "error"; title: string; body: string } {
  const name = projectName ?? job.projectId
  const who = job.by.kind === "cody" ? "" : `${initiatorLabel(job.by, job.by.kind === "captain" ? projectName : undefined)}${job.reason ? `: ${job.reason}` : ""}. `
  if (job.status === "running") return { kind: "progress", title: `Taking ${name}'s snapshot from ${job.boxId}`, body: `${who}${snapshotJobLine(job)}` }
  if (job.status === "failed") return { kind: "error", title: `${name}'s snapshot failed`, body: `${who}${job.error ?? "Unknown error"}. ${job.boxId} wasn't changed.` }
  return { kind: "info", title: `Saved ${name}'s snapshot`, body: `${who}New ${name} boxes start from ${job.snapshotId ?? "it"}. ${job.boxId} wasn't changed.` }
}

/** Show or update a snapshot job's toast (SSE project.snapshot). */
export function announceSnapshot(job: SnapshotJob, projectName?: string) {
  const t = snapshotToast(job, projectName)
  const key = `snapshot:${job.id}`
  if (t.kind === "progress") toast.progress(key, t.title, t.body)
  else toast.settle(key, t.kind, t.title, t.body)
}
