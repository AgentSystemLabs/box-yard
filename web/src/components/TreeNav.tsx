// The way up the tree (lib/treeNav.ts says how each move goes in history). In a task's header the levels above it are
// crumbs, laid out as the Captain's header (CaptainTab.tsx CentreCaptainHeader) so going between the two moves nothing: on
// a phone the sidebar's ☰ and the Coordinator, then on any screen the Captain's icon and its project's name, then each
// task above as its icon. A desktop's title follows on the same row; a phone's whole title is the row under them
// (TaskHeader.tsx). A Captain's header gets the Coordinator's crumb before its name.
import { memo, type ComponentProps, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import type { Project, Task } from "../../../shared/types"
import { crumbTo, goChat, goTask, useTaskPath } from "../lib/treeNav"
import { chatRef } from "../lib/columns"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"
import { useProjectColor } from "../lib/taskTiles"
import { useCaptainState, useCoordinatorStatus, useTask } from "../lib/queries"
import { ProjectAvatar, TaskStatusIcon, agentIconLabel, iconCue } from "./TaskIcon"
import { useCaptainMark } from "./CaptainIcon"
import { AgentIcon, STATUS, cx } from "./ui"

const Sep = () => <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
function CoordinatorMark() {
  const state = useCoordinatorStatus()
  return <AgentIcon announce={false} kind="coordinator" {...state} error={Boolean(state.error)} />
}

/** Under 22rem (a 320px phone) a crumb is 36px wide, still 44 tall, with no › before it, so the row keeps its room. */
const TIGHT = "@max-[22rem]/head:w-9 @max-[22rem]/head:[&>svg]:hidden"
/** From 36rem (a wide phone held sideways, a small tablet) a crumb with `name` shows it beside its icon. */
const NAMED = "@min-[36rem]/head:w-auto @min-[36rem]/head:max-w-[13rem] @min-[36rem]/head:pr-2"

/** Keep the path's quiet list subscription; only the ancestor whose status changes needs to redraw. */
const AncestorTaskCrumb = memo(function AncestorTaskCrumb({ task, children, ...props }: { task: Task; children?: ReactNode } & Omit<ComponentProps<typeof Crumb>, "children">) {
  const current = useTask(task.id).data ?? task
  const status = iconCue(current.status) ? STATUS[current.status].label : undefined
  return <Crumb {...props} label={`${props.label}${status ? `, ${status}` : ""}`}><TaskStatusIcon task={current} size="lg" />{children}</Crumb>
})

function Crumb({ label, name, onClick, first = false, className, children }: { label: string; name?: string; onClick: () => void; first?: boolean; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "flex h-11 w-11 min-w-0 shrink-0 items-center justify-center rounded-lg hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
        !first && "-ml-0.5",
        TIGHT,
        name && NAMED,
        className,
      )}
    >
      {!first && <Sep />}
      <span className="grid h-7 w-7 shrink-0 place-items-center">{children}</span>
      {name && <span className="hidden min-w-0 truncate text-sm font-medium text-zinc-300 @min-[36rem]/head:inline">{name}</span>}
    </button>
  )
}

/**
 * The Captain, as its header draws it: its icon (16px, in its project's colour, where AgentIcon puts it) and its
 * project's name in the title's place, so the icon and the name stay put going between the Captain and its task. One
 * crumb: a tap goes to the Captain. The button reaches 8px past the icon on the left, into the gap before it.
 */
function CaptainCrumb({ projectId, project, wide, onClick }: { projectId: string; project: Project | undefined; wide: boolean; onClick: () => void }) {
  const color = useProjectColor(projectId)
  const state = useCaptainState(projectId).data
  // As in the Captain's header: the project's image beside the name unless it's already the Captain's icon.
  const imageMark = useCaptainMark(projectId).kind === "image"
  const label = project ? `${project.name} Captain` : "Captain"
  const status = agentIconLabel(state)
  return (
    <button
      type="button"
      aria-label={`${label}${status ? `, ${status}` : ""}`}
      title={`${label}${status ? `, ${status}` : ""}`}
      onClick={onClick}
      data-testid="captain-crumb"
      className="-ml-2 flex h-11 min-w-0 items-center gap-2 rounded-lg pr-1.5 pl-2 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
    >
      <AgentIcon announce={false} projectId={projectId} color={color} busy={Boolean(state?.busy)} compacting={state?.compacting} error={Boolean(state?.error)} />
      {project && (
        // The task's title shares a desktop's row: the name takes at most a quarter of it. A phone's has the row.
        <span className={cx("flex min-w-0 items-center gap-1.5 text-sm font-semibold", wide && "max-w-[25cqw]")}>
          <ProjectAvatar src={imageMark ? null : project.iconUrl} className="h-4 w-4 rounded-[4px]" />
          <span className="min-w-0 truncate">{project.name}</span>
        </span>
      )}
    </button>
  )
}

/**
 * The crumbs in a task's header, in Back's place. Under 25rem the tasks between the Captain and the parent fold into
 * the parent's crumb, which says how many it holds (Up shows each in turn; ☰'s tree names them).
 */
export function TaskCrumbs({ task, project, className }: { task: Task; project: Project | undefined; className?: string }) {
  const path = useTaskPath(task.id)
  const chat = project ?? path.project
  const above = path.chain.slice(0, -1)
  const folded = above.length - 1
  // A desktop opens the level (or goes Back to it); a phone goes up in its own way (lib/treeNav.ts).
  const desktop = useMinWidth(SIDEBAR_INLINE)
  const toChat = (projectId: string | null) => (desktop ? crumbTo(chatRef(projectId), task.id) : goChat(projectId))
  const toTask = (id: string) => (desktop ? crumbTo(id, task.id) : goTask(id, path.tasks))
  return (
    <nav aria-label="Breadcrumb" data-testid="task-crumbs" className={cx("relative z-10 flex min-w-0 items-center", className)}>
      {/* The Captain's header's own row (CaptainTab.tsx): on a phone the Coordinator first, gone under 280px (a 320px
          phone at 125% zoom) so the project's name keeps its room; a desktop's sidebar has the Coordinator. */}
      <span className="flex min-w-0 items-center gap-2">
        {!desktop && <CoordinatorCrumb className="@max-[17.5rem]:hidden" />}
        <CaptainCrumb projectId={task.projectId} project={chat} wide={desktop} onClick={() => toChat(task.projectId)} />
      </span>
      {above.map((t, i) => {
        const parent = i === above.length - 1
        return (
          <AncestorTaskCrumb task={t} key={t.id} label={parent ? `Up to ${t.title}` : t.title} name={parent && !desktop ? t.title : undefined} onClick={() => toTask(t.id)} className={parent ? "relative" : "@max-[25rem]/head:hidden"}>
            {parent && folded > 0 && (
              <span aria-hidden className="absolute top-1 right-0 hidden h-3.5 min-w-3.5 place-items-center rounded-full bg-zinc-700 px-0.5 text-[9px] font-semibold text-zinc-100 tabular-nums @max-[25rem]/head:grid">
                +{folded}
              </span>
            )}
          </AncestorTaskCrumb>
        )
      })}
      {/* On a desktop the title follows on the same row; a phone's is the row below. */}
      {desktop && (
        <span className="flex">
          <Sep />
        </span>
      )}
    </nav>
  )
}

/**
 * In a Captain's header, before its name, and so in its task's: the Coordinator, one tap up. 44px wide where a task's
 * crumbs tighten too, as the Captain's header keeps every button, so the Captain's icon after it stays put.
 */
export function CoordinatorCrumb({ className }: { className?: string }) {
  const status = agentIconLabel(useCoordinatorStatus())
  return (
    <span className={cx("-mr-1 -ml-1.5 flex shrink-0 items-center", className)}>
      <Crumb first label={`Coordinator${status ? `, ${status}` : ""}`} onClick={() => goChat(null)} className="min-w-11">
        <CoordinatorMark />
      </Crumb>
      <Sep />
    </span>
  )
}
