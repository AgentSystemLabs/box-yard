// A task-linked PR overview. All context comes from the existing task queries;
// checks/reviews and the full PR description remain on GitHub until fresh data is available.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, GitPullRequest, Globe } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { fetchTasks, keys, useProjects, useTasks } from "../lib/queries"
import { useChatProjectFilter } from "../lib/projectBar"
import { comparePullRequests, isPrHistory, taskPullRequests, type TaskPullRequest } from "../lib/taskPullRequests"
import { useStableOrder } from "../lib/useStableOrder"
import { navigateApp, taskSessionHref } from "../lib/navigation"
import { prNumber } from "../lib/prState"
import { Modal, ModalStep } from "./Modal"
import { ComposerMenuItem } from "./ComposerMenu"
import { MergePrCardButton } from "./MergePr"
import { PrAgents } from "./PrAgents"
import { ResortPill } from "./ResortPill"
import { Button, InRepo, Markdown, NewTabLink, PrChip, cx } from "./ui"
import type { Task } from "../../../shared/types"

const NO_TASKS: never[] = []
const TOUCH = "min-h-11! min-w-11!"

/** The chat's pull requests: an icon in its box's row of buttons (DockComposer), with how many are still open beside it
 * so it says something before it's opened. Sized like the box's other buttons: 44px, 32px with a mouse in a wide box.
 * `projectId` names the project for a chat that isn't the centre's (a Captain's side panel). */
export function PullRequestsButton({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false)
  const count = useOpenPullRequests(projectId)
  const label = count ? `Pull requests, ${count} open` : "Pull requests"
  return (
    <>
      <Button size="sm" variant="ghost" className="h-11 min-w-11! shrink-0 gap-1.5 px-2.5! text-zinc-400 hover:text-zinc-100 pointer-fine:@min-[32rem]/composer:h-8 pointer-fine:@min-[32rem]/composer:min-w-8! pointer-fine:@min-[32rem]/composer:px-2!" aria-label={label} title={label} data-testid="pull-requests-button" onClick={(e) => { e.currentTarget.focus(); setOpen(true) }}>
        <GitPullRequest className="h-4 w-4" aria-hidden />
        {count > 0 && <span aria-hidden className="text-xs font-medium tabular-nums">{count}</span>}
      </Button>
      {open && <PullRequestsDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The same as a line of the composer's More menu, for a box too narrow to show it on the row. */
export function PullRequestsMenuItem({ className, projectId }: { className?: string; projectId?: string }) {
  const [open, setOpen] = useState(false)
  const count = useOpenPullRequests(projectId)
  return (
    <>
      <ComposerMenuItem
        data-testid="more-pull-requests"
        icon={GitPullRequest}
        label="Pull requests"
        detail={count ? `${count} open` : "None open"}
        className={className}
        onClick={(e) => {
          e.currentTarget.focus()
          setOpen(true)
        }}
      />
      {open && <PullRequestsDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  )
}

/** The chat's open PRs: the picked Captain's project, or every project for the Coordinator. */
function useOpenPullRequests(project?: string): number {
  const picked = useChatProjectFilter()
  const projectId = project ?? picked
  // Only the count: a task update that opens or closes no PR doesn't re-render the button.
  const select = useCallback((list: Task[]) => taskPullRequests(list, projectId).filter((pr) => !isPrHistory(pr)).length, [projectId])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? 0
}

export function PullRequestsDialog({ onClose, projectId: project }: { onClose: () => void; projectId?: string }) {
  const picked = useChatProjectFilter()
  const projectId = project ?? picked
  const tasks = useTasks()
  const projects = useProjects()
  const prs = useMemo(() => taskPullRequests(tasks.data ?? NO_TASKS, projectId), [tasks.data, projectId])
  const [history, setHistory] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(40)
  const detail = useRef<HTMLHeadingElement>(null)
  const lastPick = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    // Without scrolling: the PR's state and who worked on it stay in view above.
    if (selected) detail.current?.focus({ preventScroll: true })
    else lastPick.current?.focus({ preventScroll: true })
  }, [selected])
  const stable = useStableOrder(prs, {
    key: (pr) => pr.url,
    compare: comparePullRequests,
    include: (pr) => isPrHistory(pr) === history,
    resetKey: `${projectId}:${history}`,
  })
  const pr = prs.find((pr) => pr.url === selected)
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "Project unavailable"
  const scope = projectId ? projectName(projectId) : "All projects"
  const activeCount = prs.filter((p) => !isPrHistory(p)).length
  const historyCount = prs.length - activeCount
  const openTask = (id: string) => {
    onClose()
    navigateApp(taskSessionHref(id))
  }
  return (
    <Modal title="Pull requests" description={scope} size="lg" onClose={onClose}
      className="@container h-[90dvh] [&_button]:min-h-11"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {/* A PR's detail is a level inside the dialog: the header's Back (in place of ×) and Esc return to the list. */}
      <ModalStep active={selected !== null} back={() => setSelected(null)} label="Back to pull requests" />
      {/* Keep the list mounted, so its scroll position survives opening a PR and returning. */}
      <div hidden={selected !== null} className="min-h-0 flex-1 overflow-y-auto p-3 @min-[40rem]:p-5">
        <div role="group" aria-label="Pull request filter" className="mb-3 flex flex-wrap gap-2">
          <Button variant={history ? "ghost" : "subtle"} aria-label="Open work" aria-pressed={!history} onClick={() => { setHistory(false); setLimit(40) }}>Open work <span className="text-zinc-300">{activeCount}</span></Button>
          <Button variant={history ? "subtle" : "ghost"} aria-label="History" aria-pressed={history} onClick={() => { setHistory(true); setLimit(40) }}>History <span className="text-zinc-300">{historyCount}</span></Button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Task-linked PRs · last reported state. Check GitHub for current reviews and checks.</p>
        {tasks.isLoading ? <p role="status">Loading pull requests…</p> : tasks.isError ? (
          <div role="alert"><p>Couldn't load pull requests.</p><Button onClick={() => void tasks.refetch()}>Retry</Button></div>
        ) : (
          <div ref={stable.listRef} className="space-y-2">
            <ResortPill newCount={stable.newCount} changedCount={stable.changedCount} onResort={stable.resort} />
            {stable.entries.slice(0, limit).map(({ item, stale }) => (
              <article key={item.url} data-stable-key={item.url} data-testid="pr-row" className={cx("rounded-xl border border-zinc-800 bg-zinc-900/40 p-3", stale && "border-dashed bg-zinc-900/20")}>
                <button type="button" aria-label={`View pull request: ${item.tasks[0]!.title}`} onClick={(e) => { lastPick.current = e.currentTarget; setSelected(item.url) }} className="flex w-full min-w-0 items-start gap-2 rounded-md text-left text-sm font-medium text-zinc-100 focus-visible:outline-2 focus-visible:outline-yard-500">
                  <span className="min-w-0 flex-1 wrap-anywhere">{item.tasks[0]!.title}</span><ArrowRight aria-hidden className="h-4 w-4 shrink-0 self-center text-zinc-500" />
                </button>
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                  <span className="min-w-0 wrap-anywhere">{[...new Set(item.tasks.map((t) => projectName(t.projectId)))].join(" · ")} · {item.tasks.length} {item.tasks.length === 1 ? "task" : "tasks"}</span>
                  <PrState pr={item} />
                </div>
              </article>
            ))}
            {stable.entries.length === 0 && <p className="py-6 text-sm text-zinc-400">{history ? "No merged or closed pull requests." : "No open work here. Pull requests linked to tasks appear here; merged and closed work is in History."}</p>}
            {stable.entries.length > limit && <Button className="w-full" onClick={() => setLimit((n) => n + 40)}>Show more pull requests</Button>}
          </div>
        )}
      </div>
      {selected && <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 @min-[40rem]:p-5">
        {!pr ? <p>This pull request is no longer linked to a task in this project.</p> : <>
          <div className="flex flex-wrap items-center gap-3 text-sm"><PrState pr={pr} />
            {/* Unknown/draft/conflicting states never inherit prStateOf's open fallback. */}
            {pr.state === "open" && <MergePrCardButton task={pr.tasks.find((task) => task.mergeRequest) ?? pr.tasks[0]!} />}
          </div>
          <PrAgents prUrl={pr.url} onOpenTask={openTask} />
          <h2 ref={detail} tabIndex={-1} className="text-sm font-medium text-zinc-200 focus:outline-none">Task summaries</h2>
          <p className="text-xs text-zinc-500">Last reported state. See GitHub for the PR description, reviews and checks.</p>
          <NewTabLink href={pr.url} mark="end" className="inline-flex min-h-11 items-center gap-1 text-sm text-sky-400">Review on GitHub</NewTabLink>
          {pr.tasks.map((task) => <section key={task.id} className="space-y-3 rounded-xl border border-zinc-800 p-3">
            <div><p className="text-xs text-zinc-500 wrap-anywhere">{projectName(task.projectId)}</p><h3 className="text-sm font-medium text-zinc-100 wrap-anywhere">{task.title}</h3></div>
            <InRepo taskId={task.id}><div className="text-sm text-zinc-300 wrap-anywhere">{task.summary ? <Markdown>{task.summary}</Markdown> : <p className="text-zinc-500">No task summary yet. Open the conversation for the latest update.</p>}</div></InRepo>
            <div className="flex flex-wrap gap-2">
              <Button className={TOUCH} aria-label={`Open task conversation: ${task.title}`} onClick={() => openTask(task.id)}>Task conversation <ArrowRight className="h-4 w-4" /></Button>
              {task.previews.map((preview) => <NewTabLink key={preview.port} href={preview.url} mark="end" className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-sm text-sky-400"><Globe className="h-4 w-4 shrink-0" /><span className="min-w-0 wrap-anywhere">{preview.label || `Preview :${preview.port}`}</span></NewTabLink>)}
            </div>
          </section>)}
        </>}
      </div>}
    </Modal>
  )
}

function PrState({ pr }: { pr: TaskPullRequest }) {
  return pr.state ? <PrChip task={{ ...pr.tasks[0]!, prUrl: pr.url, prState: pr.state }} className="min-h-11!" /> : (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-zinc-500"><NewTabLink href={pr.url} mark="end" className="inline-flex min-h-11 items-center gap-1 text-sky-400"><GitPullRequest className="h-3.5 w-3.5" />PR #{prNumber(pr.url)}</NewTabLink><span>Status unconfirmed</span></span>
  )
}
