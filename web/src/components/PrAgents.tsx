// "Worked on by" in a pull request's details: one row per task that worked on it (opened it, pushed to it, worked
// on its branch, was asked to merge it), with its harness and model, where it runs and its status. A row is a link
// to the task. The title gets the row's whole width; the facts go on the line below and wrap.
import { useId, useMemo, type MouseEvent } from "react"
import { ChevronRight } from "lucide-react"
import { AGENT_CLI_LABEL } from "../../../shared/agentCli"
import { placementView } from "../../../shared/placement"
import type { Project } from "../../../shared/types"
import { isPlainClick } from "../lib/filePreview"
import { badgeStatus } from "../lib/prState"
import { prAgentRows, rolesText, usePrTasks, type PrAgentRow } from "../lib/prTasks"
import { useProjects, useTasks } from "../lib/queries"
import { navigateApp, taskSessionHref } from "../lib/navigation"
import { Loading } from "./Loading"
import { placementTitle } from "./PlacementChip"
import { TaskTile } from "./TaskIcon"
import { StatusDot, cx } from "./ui"

const NO_TASKS: never[] = []

/** `onOpenTask` replaces the plain-click navigation, e.g. to close the dialog first; other clicks open a tab. */
export function PrAgents({ prUrl, onOpenTask, className }: { prUrl: string; onOpenTask?: (taskId: string) => void; className?: string }) {
  const answer = usePrTasks(prUrl)
  const tasks = useTasks().data ?? NO_TASKS
  const projects = useProjects().data
  const rows = useMemo(() => prAgentRows(prUrl, answer.data, tasks), [prUrl, answer.data, tasks])
  const heading = useId()
  const open = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    if (onOpenTask) onOpenTask(id)
    else navigateApp(taskSessionHref(id))
  }
  return (
    <section aria-labelledby={heading} data-testid="pr-agents" className={cx("@container/agents", className)}>
      <h2 id={heading} className="text-sm font-medium text-zinc-200">
        Worked on by {rows.length > 0 && <span className="font-normal text-zinc-500">{rows.length}</span>}
      </h2>
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
          {rows.map((row) => (
            <li key={row.task.id}>
              <a
                href={taskSessionHref(row.task.id)}
                data-testid="pr-agent"
                onClick={(e) => open(e, row.task.id)}
                className="flex min-h-11 items-start gap-2.5 px-3 py-2.5 text-sm leading-5 hover:bg-zinc-800/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-500"
              >
                <span className="flex h-5 shrink-0 items-center">
                  <TaskTile id={row.task.id} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium wrap-anywhere text-yard-400">{row.task.title}</span>
                  <AgentFacts row={row} project={projects?.find((p) => p.id === row.task.projectId)} />
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 self-center text-zinc-500" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {answer.isPending && rows.length === 0 ? (
        <Loading kind="line" label="Finding the tasks that worked on it" className="mt-2" />
      ) : answer.isError ? (
        <p className="mt-1 text-xs text-zinc-500">Couldn't check for other tasks on its branch. These are the tasks linked to it now.</p>
      ) : (
        rows.length === 0 && <p className="mt-1 text-xs text-zinc-500">No task in Box Yard opened it, pushed to its branch or was asked to merge it.</p>
      )}
    </section>
  )
}

/** What it did, its harness and model, where it runs, and its status. The full place shows when the panel is wide. */
function AgentFacts({ row, project }: { row: PrAgentRow; project: Project | undefined }) {
  const { task } = row
  const place = placementView(task, project?.runner)
  const harness = [AGENT_CLI_LABEL[task.agentCli ?? "claude"], row.model].filter(Boolean).join(" · ")
  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-400">
      {row.roles.length > 0 && <span className="text-zinc-300">{rolesText(row.roles)}</span>}
      <span className="min-w-0 wrap-anywhere" title="Harness and model">
        {harness}
      </span>
      <span className="min-w-0 wrap-anywhere" title={placementTitle(place)}>
        <span className="@min-[34rem]/agents:hidden">{place.short}</span>
        <span className="hidden @min-[34rem]/agents:inline">{place.label}</span>
      </span>
      <StatusDot status={badgeStatus(task)} className="font-normal" />
    </span>
  )
}
