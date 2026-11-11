// A task's panel: its full history in TaskView's memoized, paged transcript (TaskThread), without the task page.
// The box's "Side question" swaps the transcript for the task's side questions to the Coordinator (TaskAsk.tsx).
import { useCallback, useMemo, useRef, useState } from "react"
import { useArtifacts, useProjects, useSchedules, useSendChat, useSendTaskMessage, useTask, newClientId } from "../lib/queries"
import { projectContext, taskContext } from "../lib/selectionTask"
import { Button, InRepo, cx } from "./ui"
import { TaskThread, workingLabel } from "./TaskView"
import { CHAT_COLUMN, TaskHeader } from "./TaskHeader"
import { TaskComposer, type TaskAskTarget } from "./CaptainForward"
import { TaskAsk } from "./TaskAsk"
import { useAskAboutTask, useTaskThread } from "../lib/threads"
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
  const chat = useSendChat()
  const submit = useCallback((content: string, attachments: Parameters<typeof send.mutateAsync>[0]["attachments"]) => {
    const sending = send.mutateAsync({ content, attachments })
    handle.current?.scrollToEnd()
    return sending
  }, [send.mutateAsync])
  const followUp = useCallback((content: string) => { void submit(content, []).catch(() => {}) }, [submit])
  const scrollToEnd = useCallback(() => handle.current?.scrollToEnd(), [])
  const selection = useCallback((content: string) => chat.mutate({ id: newClientId("chat"), content, attachments: [] }), [chat.mutate])
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
          <div ref={panel} className="flex min-h-0 flex-1 flex-col">
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
                  selectionSource={project ? { kind: "task", project: projectContext(project)!, task: taskContext(task)! } : null}
                  onStartFromSelection={selection} onFollowUp={followUp}
                />
              )}
            </div>
            <div className="shrink-0">
              <TaskComposer task={task} project={project} panelRef={panel} onSubmit={submit} onForwarded={scrollToEnd} ask={ask} className="chat-column overflow-hidden" />
            </div>
          </div>
        </InRepo>
      )}
    </>
  )
}
