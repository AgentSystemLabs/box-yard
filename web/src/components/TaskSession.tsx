// A task's panel: its full history in TaskView's memoized, paged transcript (TaskThread), without the task page.
// The box's "Side question" swaps the transcript for the task's side questions to the Coordinator (TaskAsk.tsx).
// Text highlighted in the transcript has Ask and Create task (SelectionToTask.tsx): both go to the project's Captain.
// An Ask is a thread of the Captain's chat about that passage, which opens over the panel as a level of its own
// (TaskQuestion), and the questions asked so far stay as chips above the box (TaskQuestions).
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useArtifacts, useProjects, useSchedules, useSendTaskMessage, useTask } from "../lib/queries"
import { taskContext, type SelectionTaskSource } from "../lib/selectionTask"
import type { SelectionAsk } from "./SelectionToTask"
import { ThreadChip, ThreadView } from "./SideThread"
import { Button, InRepo, TAP_AREA, cx } from "./ui"
import { TaskThread, workingLabel } from "./TaskView"
import { CHAT_COLUMN, TaskHeader } from "./TaskHeader"
import { TaskComposer, type TaskAskTarget } from "./CaptainForward"
import { TaskAsk } from "./TaskAsk"
import { leaveThread, openThread, taskSlot, useAskAboutTask, useOpenThread, useTaskAsks, useTaskThread, type OpenThread } from "../lib/threads"
import type { StickyScrollHandle } from "./StickyScroll"
import { WaitFixButton, WaitReason } from "./WaitReason"
import { TaskFailure } from "./TaskFailure"
import { DismissButton, useModalStep } from "./Modal"
import { TaskStatusAnnouncer } from "./TaskStatusAnnouncer"
import { Loading } from "./Loading"
import { runningSince } from "../lib/runningTasks"
import { PanelControls } from "./ColumnControls"
import { usePanelPlace } from "../lib/panelStack"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"
import { SidebarMenuButton } from "./Sidebar"
import type { Task } from "../../../shared/types"

/**
 * Beside the chat a panel is a column (ColumnControls.tsx) and its crumbs lead up, so Back is for the sheet. Side questions are a level inside the
 * panel: their Back shows instead of the controls, so the header never has both Back and × (docs/dismiss.md).
 */
const BACK_ON_SHEET = "@min-[35.5rem]/coord:hidden"

/** Its agent is on a turn (or setting one up): the thread says so, and for how long. */
const onTurn = (t: Task) => t.status === "working" || t.status === "starting"

export function TaskSession({ id, onClose, backLabel, scrollKey }: { id: string; onClose: () => void; backLabel?: string; scrollKey: string }) {
  const query = useTask(id)
  const projects = useProjects()
  const artifacts = useArtifacts()
  const schedules = useSchedules()
  const files = useMemo(() => (artifacts.data ?? []).filter((a) => a.taskId === id), [artifacts.data, id])
  const task = query.data
  const project = projects.data?.find((p) => p.id === task?.projectId)
  const handle = useRef<StickyScrollHandle>(null)
  const panel = useRef<HTMLDivElement>(null)
  const send = useSendTaskMessage(id)
  const submit = useCallback((content: string, attachments: Parameters<typeof send.mutateAsync>[0]["attachments"]) => {
    const sending = send.mutateAsync({ content, attachments })
    handle.current?.scrollToEnd()
    return sending
  }, [send.mutateAsync])
  const followUp = useCallback((content: string) => { void submit(content, []).catch(() => {}) }, [submit])
  const scrollToEnd = useCallback(() => handle.current?.scrollToEnd(), [])
  // Highlighted text: Ask is a thread of the project's Captain chat on this task, shown here; Create task goes to that
  // Captain. Stable, so the transcript (memo'd) doesn't re-render with the header.
  const slot = taskSlot(id)
  const projectId = project?.id
  const projectName = project?.name
  const selectionAsk = useMemo<SelectionAsk | null>(() => (projectId ? { chat: projectId, slot, anchorId: id } : null), [projectId, slot, id])
  const taskRef = taskContext(task)
  const selectionSource = useMemo<SelectionTaskSource | null>(
    () => (projectId && projectName && taskRef ? { kind: "task", project: { id: projectId, name: projectName }, task: taskRef } : null),
    [projectId, projectName, taskRef?.id, taskRef?.title, taskRef?.branch, taskRef?.prUrl], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const question = useOpenThread(slot)
  const qc = useQueryClient()
  const leaveQuestion = useCallback(() => projectId && leaveThread(qc, projectId, slot), [qc, projectId, slot])
  // A level inside the panel, as the side questions are: Esc goes back to the thread it was asked in, then to the task.
  useModalStep(Boolean(question && projectId), leaveQuestion, "Back to the task")
  const schedule = schedules.data?.find((s) => s.id === task?.scheduleId)
  // Side questions: the box asks the Coordinator about the task, and its answers show in place of the transcript.
  const [asking, setAsking] = useState(false)
  const askHandle = useRef<StickyScrollHandle>(null)
  const askThread = useTaskThread(id)
  const askAbout = useAskAboutTask(id, task?.title ?? id)
  const askSubmit = useCallback((question: string) => {
    const asked = askAbout(question)
    askHandle.current?.scrollToEnd()
    return asked
  }, [askAbout])
  const askStarter = useCallback((question: string) => { void askSubmit(question).catch(() => {}) }, [askSubmit])
  const back = useCallback(() => setAsking(false), [])
  // Side questions are a level inside the panel: Esc and the header's Back return to the transcript first.
  useModalStep(asking, back, "Back to the task")
  const ask = useMemo<TaskAskTarget>(() => ({
    on: asking,
    toggle: () => setAsking((on) => !on),
    unread: Boolean(askThread?.unread),
    busy: Boolean(askThread?.busy),
    submit: askSubmit,
  }), [asking, askThread?.unread, askThread?.busy, askSubmit])
  const inPanel = Boolean(usePanelPlace())
  const sidebarInline = useMinWidth(SIDEBAR_INLINE)
  const controls = useMemo(() => (inPanel ? <PanelControls name={task?.title ?? "Task"} className="-my-1.5" /> : undefined), [inPanel, task?.title])
  // The task header supplies Back, title and actions inside the shared conversation panel. Every row lays out in the
  // Captain chat's column (`.chat-column`): the transcript (TaskThread `bare`) and the box as the Captain's do, the other
  // rows as its header (CHAT_COLUMN), so a task is as wide as the Captain at any width.
  return (
    <>
      {!task ? (
        <>
          <header className={cx(CHAT_COLUMN, "flex shrink-0 items-center gap-1.5 border-b border-zinc-800/70 py-1.5")}>
            {/* On a phone the sidebar's ☰ leads every header, as in the task's own (TaskHeader). */}
            {!sidebarInline && <SidebarMenuButton />}
            <DismissButton kind="back" onClick={onClose} label={backLabel} className={cx(sidebarInline ? "-ml-2 pointer-coarse:-ml-3" : "-ml-1", inPanel && BACK_ON_SHEET)} />
            <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-zinc-50">Task conversation</h2>
            {controls}
          </header>
          <div className={cx(CHAT_COLUMN, "py-3 text-sm text-zinc-400")}>
            {query.isLoading ? <Loading kind="chat" label="Loading the task" /> : query.isError ? (
              <div role="alert" className="space-y-2"><p>Couldn't load this task.</p><Button onClick={() => void query.refetch()}>Retry</Button></div>
            ) : <p>Task not found. It may have been deleted.</p>}
          </div>
        </>
      ) : (
        <InRepo taskId={id}>
          <div ref={panel} className="relative flex min-h-0 flex-1 flex-col">
            <TaskHeader task={task} project={project} schedule={schedule} files={files} onBack={asking ? back : onClose} backLabel={asking ? "Back to the task" : backLabel} backClassName={inPanel && !asking ? BACK_ON_SHEET : undefined} controls={asking ? undefined : controls} tree={!asking} />
            <TaskStatusAnnouncer task={task} />
            {/* pb-0.5: the column clips from sm, and the button's focus ring stays inside it. */}
            {task.status === "queued" && task.waitReason && <div role="status" className={cx(CHAT_COLUMN, "flex shrink-0 flex-wrap items-center gap-2 pt-2 pb-0.5 text-sm text-amber-200")}><WaitReason task={task} /><WaitFixButton task={task} /></div>}
            {/* At most half the panel, and it scrolls: with Details open on a small phone the box and Send stay on screen.
                Beside the chat it is the transcript's column, which starts past its day rail (ChatHistory, w-11); a
                phone's sheet gives it the whole width. */}
            {task.status === "failed" && task.error && (
              <div className="mt-2 flex max-h-[50%] min-h-0 shrink-0 flex-col @min-[35.5rem]/coord:pl-11">
                <div className="chat-column min-h-0 overflow-y-auto"><TaskFailure task={task} project={project} /></div>
              </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col">
              {asking ? <TaskAsk taskId={id} handle={askHandle} onAsk={askStarter} /> : (
                <TaskThread handle={handle} id={id} bare scrollKey={scrollKey}
                  working={onTurn(task) ? workingLabel(task.status) : null}
                  workingSince={onTurn(task) ? runningSince(task) : null}
                  ask={task.status === "needs_input" ? task.question : null}
                  questions={task.status === "needs_input" ? (task.questions ?? null) : null}
                  selectionSource={selectionSource} selectionAsk={selectionAsk} onFollowUp={followUp}
                />
              )}
            </div>
            {projectId && !asking && <TaskQuestions taskId={id} projectId={projectId} openId={question?.id ?? null} />}
            <div className="shrink-0">
              <TaskComposer task={task} project={project} panelRef={panel} onSubmit={submit} onForwarded={scrollToEnd} ask={ask} className="chat-column overflow-hidden" />
            </div>
            {question && projectId && <TaskQuestion key={question.id} projectId={projectId} slot={slot} open={question} source={selectionSource} />}
          </div>
        </InRepo>
      )}
    </>
  )
}

/**
 * A question about a passage of the task's transcript, open: the thread covers the panel (its header's Back, or Esc,
 * returns to the thread it was asked in, then to the task), and what's under it is out of reach of Tab meanwhile.
 */
function TaskQuestion({ projectId, slot, open, source }: { projectId: string; slot: string; open: OpenThread; source: SelectionTaskSource | null }) {
  const sheet = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = sheet.current
    const under = el?.parentElement ? [...el.parentElement.children].filter((c) => c !== el) : []
    for (const c of under) c.setAttribute("inert", "")
    return () => {
      for (const c of under) c.removeAttribute("inert")
    }
  }, [])
  return (
    <section ref={sheet} data-testid="task-question" aria-label="Thread" className="absolute inset-0 z-30 flex flex-col bg-zinc-950">
      <ThreadView chat={projectId} slot={slot} open={open} headerClassName="min-h-12" sheet backLabel="Back to the task" source={source} />
    </section>
  )
}

/**
 * The questions asked about passages of this task's transcript, as chips above its box: each opens its thread again.
 * Resolved ones fold into a count, which shows them.
 */
function TaskQuestions({ taskId, projectId, openId }: { taskId: string; projectId: string; openId: string | null }) {
  const asks = useTaskAsks(projectId, taskId)
  const [all, setAll] = useState(false)
  if (!asks.length) return null
  const folded = asks.filter((t) => t.resolvedAt != null && !t.unread && !t.busy)
  const shown = all ? asks : asks.filter((t) => !folded.includes(t))
  return (
    <div data-testid="task-questions" role="group" aria-label="Questions about this transcript" className="chat-column flex max-h-24 shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto pt-1.5 pb-1 pointer-coarse:gap-y-5 pointer-coarse:py-3">
      <span className="shrink-0 text-[11px] text-zinc-400">Asked here</span>
      {shown.map((t) => (
        <ThreadChip key={t.id} t={t} active={openId === t.id} onOpen={() => openThread(taskSlot(taskId), t.id)} />
      ))}
      {folded.length > 0 && (
        <button type="button" onClick={() => setAll(!all)} aria-expanded={all} className={cx(TAP_AREA, "inline-flex h-6 shrink-0 items-center rounded-full px-2 text-xs text-zinc-400 hover:text-zinc-100")}>
          {all ? "Hide resolved" : `${folded.length} resolved`}
        </button>
      )}
    </div>
  )
}
