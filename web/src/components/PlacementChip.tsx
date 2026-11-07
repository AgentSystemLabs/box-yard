// Where a task actually runs, on its card (compact) and in the task's ⓘ details (full).
// The wording is shared/placement.ts's; the icons are the Boxes page's and Settings' for each provider.
import { memo } from "react"
import { Boxes, Container, Cpu, Laptop, Pin, Server, ShieldAlert, type LucideIcon } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import { LOCAL_UNSANDBOXED } from "../../../shared/runner"
import { placementView, type PlaceKind, type PlacementView } from "../../../shared/placement"
import { LineIcon, cx, timeAgo } from "./ui"

/** Laptop for this computer (the Boxes page's), Boxes for worker boxes, Cpu for RunPod (Settings' RunPod GPU), Container for Docker, Server for SSH machines. */
export const PLACE_ICON: Record<PlaceKind, LucideIcon> = { local: Laptop, box: Boxes, gpu: Cpu, docker: Container, ssh: Server }

/** Local is amber like the unsandboxed warning; the rest are calm. Muted while it's only where it will go or went. */
export const placeTone = (v: PlacementView) => (v.state !== "here" ? "text-zinc-500" : v.kind === "local" ? "text-amber-200" : "text-zinc-300")

/** The full tooltip: every line the details show. */
export const placementTitle = (v: PlacementView) => [v.label, v.setting, v.pinned ? "Pinned: this task overrides its project" : "", v.reason ?? "", v.kind === "local" ? LOCAL_UNSANDBOXED : ""].filter(Boolean).join("\n")

/**
 * The card's mark: just the provider's icon (muted while it's only where it will go or went), and a pin when the
 * task overrides its project. The full label and why are in the tooltip; the task's ⓘ details have the words.
 */
export const PlacementCardChip = memo(function PlacementCardChip({ task }: { task: Task }) {
  const v = placementView(task)
  const Icon = PLACE_ICON[v.kind]
  return (
    <span
      role="img"
      aria-label={`Runs on: ${v.label}${v.pinned ? ", pinned" : ""}`}
      data-testid="card-placement"
      data-state={v.state}
      className={cx("inline-flex shrink-0 items-center gap-0.5", placeTone(v))}
      title={placementTitle(v)}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {v.pinned && <Pin className="h-3 w-3 text-zinc-500" aria-hidden />}
    </span>
  )
})

/** Where it runs in full: the box and its size, the setting that chose it and why. The task's ⓘ details show it. */
export function PlacementDetails({ task, project, className }: { task: Task; project: Project | undefined; className?: string }) {
  const v = placementView(task, project?.runner)
  const Icon = PLACE_ICON[v.kind]
  return (
    <div className={className}>
      <p className={cx("flex items-start gap-2 text-sm font-medium wrap-anywhere", v.kind === "local" && v.state === "here" ? "text-amber-200" : "text-zinc-100")}>
        <LineIcon icon={Icon} className="h-4 w-4" />
        <span>{v.state === "next" ? `Goes to ${v.label.slice(2)}` : v.label}</span>
      </p>
      <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        {v.place && v.place.kind !== "local" && (
          <>
            <dt className="text-zinc-500">{v.place.kind === "gpu" ? "Pod" : v.place.kind === "docker" ? "Container" : "Box"}</dt>
            <dd className="min-w-0 font-mono text-[11px] wrap-anywhere text-zinc-300">
              {v.place.kind === "box" && v.state === "here" ? v.place.boxId : (v.place.podId ?? v.place.container ?? v.place.boxId)}
            </dd>
            {v.place.size && (
              <>
                <dt className="text-zinc-500">Size</dt>
                <dd className="text-zinc-300">
                  {BOX_SIZE_SPECS[v.place.size].label} · {BOX_SIZE_SPECS[v.place.size].cpu} CPU, {BOX_SIZE_SPECS[v.place.size].ramGb} GB
                </dd>
              </>
            )}
            {v.place.gpu && (
              <>
                <dt className="text-zinc-500">GPU</dt>
                <dd className="text-zinc-300">{v.place.gpu}</dd>
              </>
            )}
          </>
        )}
        {v.state === "last" && task.placement?.last && (
          <>
            <dt className="text-zinc-500">Left</dt>
            <dd className="text-zinc-300">{timeAgo(task.placement.last.leftAt)}</dd>
          </>
        )}
        <dt className="text-zinc-500">Chosen by</dt>
        <dd className="text-zinc-300">
          {v.setting}
          {v.pinned && <span className="text-zinc-500"> (pinned: overrides the project)</span>}
        </dd>
      </dl>
      {v.reason && <p className="mt-2 leading-snug">{v.reason}</p>}
      {v.kind === "local" && (
        <p id="local-warning-note" role="note" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-200">
          <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
          <span>{LOCAL_UNSANDBOXED}</span>
        </p>
      )}
    </div>
  )
}
