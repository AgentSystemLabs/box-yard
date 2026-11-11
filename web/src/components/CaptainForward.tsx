// The task page's composer, which can send a message to the project's Captain instead of the task's agent
// (lib/captainForward.ts), and the two thread lines that follow: "→ Captain" and the Captain's reply.
import { memo, useCallback, useMemo, useRef, useState, type ComponentProps, type RefObject } from "react"
import { flushSync } from "react-dom"
import { MessageCircleQuestion, X } from "lucide-react"
import { COMPOSER_FOOTER, Composer, type ComposerHandle } from "./Composer"
import { ComposerMenuItem, useCloseMore } from "./ComposerMenu"
import { ComposerIcon, TaskComposerIcon } from "./ChatIcons"
import { CaptainIcon, captainIconFor } from "./CaptainIcon"
import { projectColorStyle } from "./TaskIcon"
import { useProjectColor } from "../lib/taskTiles"
import { captainHref } from "./ChatSwitcher"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { AttachmentList } from "./Attachments"
import { AppLink, LineIcon, Markdown, TimeAgo, cx } from "./ui"
import { useForwardToCaptain, useStopTask } from "../lib/queries"
import { looksLikeTaskManagement, suggestsCaptain } from "../lib/captainForward"
import { useComposerFocus } from "../lib/chatSwitch"
import { labelFrom, rowWidth } from "../lib/composerRow"
import type { Attachment, Project, Task, TaskMessage } from "../../../shared/types"

/**
 * How many of the row's 44px buttons (and the gap after one) a chip takes with its label, at text-xs to a finger:
 * "Side question" 119px, "Captain" 85px, "To Captain" 104px. Without its label a chip counts as one 44px touch slot.
 */
const LABELLED = { ask: 2.6, captain: 1.9, toCaptain: 2.25 }

const CHIP =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs whitespace-nowrap focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"

const queuedLabel = (n: number) => (n === 1 ? "1 queued message" : `${n} queued messages`)

/** A task's side questions (TaskAsk.tsx), which the box can ask instead of messaging the agent. */
export interface TaskAskTarget {
  /** The box asks the Coordinator about the task, and the panel shows the answers. */
  on: boolean
  toggle: () => void
  /** An answer not read yet, or one on its way: a dot on the button while the box is on the task. */
  unread: boolean
  busy: boolean
  submit: (question: string) => Promise<unknown>
}

/**
 * The task page's box. Whatever the task's status, a "Captain" chip sends the next message to the project's Captain
 * (with the task's queue) instead of the agent; after that send it goes back to the task. While the task is busy or has
 * queued messages, a draft that reads like task management gets a one-tap "Send to Captain"; nothing is ever rerouted
 * on its own. With `ask`, a "Side question" toggle asks the Coordinator about the task instead, out of the agent's
 * sight (and hides the Captain chip: the box sends to one of them).
 * While the agent's turn runs, Stop before Send ends it, as the header's Stop does.
 */
export const TaskComposer = memo(function TaskComposer({
  task,
  project,
  panelRef,
  onSubmit,
  onForwarded,
  ask,
  className,
}: {
  task: Task
  project: Project | undefined
  panelRef: RefObject<HTMLElement | null>
  ask?: TaskAskTarget
  /** The footer's column (`chat-column overflow-hidden`, as the Captain's DockComposer). */
  className?: string
  /** To the task's agent (queued while it's busy). */
  onSubmit: (text: string, attachments: Attachment[]) => Promise<unknown>
  /** After a send to the Captain: scroll the thread to its line. */
  onForwarded?: () => void
}) {
  const [toCaptain, setToCaptain] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const handle = useRef<ComposerHandle>(null)
  // A question card's Answer (NoticeNow.tsx) opens the task and asks for its box.
  const box = useRef<HTMLTextAreaElement>(null)
  useComposerFocus(task.id, box)
  const forward = useForwardToCaptain(task.id)
  const captain = `${project?.name ?? "project"} Captain`
  const color = useProjectColor(task.projectId)
  const suggest = suggestsCaptain(task, task.pendingCount)
  const running = task.status === "working" || task.status === "starting"
  const asking = Boolean(ask?.on)
  const { mutate: stopTask } = useStopTask()
  const stop = useMemo(() => (running && !asking ? { label: "Stop the agent's turn", onStop: () => stopTask(task.id) } : null), [running, asking, stopTask, task.id])
  const showCaptain = !asking
  // The chips fold into the box's More menu when the row is too narrow for them (lib/composerRow.ts). Their labels show
  // only where the whole row fits them: Mic, Send, Stop, Attach, Expand (kept for when the text grows) and the chips.
  const chips = (ask ? 1 : 0) + (showCaptain ? 1 : 0)
  const labels = labelFrom(
    rowWidth(4 + (stop ? 1 : 0) + (asking ? 0 : 1) + (ask ? LABELLED.ask : 0) + (showCaptain ? (toCaptain ? LABELLED.toCaptain : LABELLED.captain) : 0)),
  )
  const askToggle = ask?.toggle
  const toggleAsk = useCallback(() => {
    handle.current?.clearSendTo()
    setToCaptain(false)
    askToggle?.()
  }, [askToggle])
  // Turned on, the text takes the caret at once, inside the press: on a phone that's what brings up the keyboard.
  const pressAsk = useCallback(() => {
    if (!asking) box.current?.focus()
    toggleAsk()
  }, [asking, toggleAsk])
  const toggleCaptain = useCallback(() => { handle.current?.clearSendTo(); setToCaptain((on) => !on) }, [])
  const answer = !asking && ask && (ask.busy || ask.unread) ? (ask.busy ? "An answer is on its way" : "A new answer") : null

  const submit = useCallback(
    (text: string, attachments: Attachment[]) => {
      setDismissed(false)
      if (ask?.on) return ask.submit(text)
      if (!toCaptain) return onSubmit(text, attachments)
      const sending = forward.mutateAsync({ content: text, attachments })
      onForwarded?.()
      // Back to the task for the next message; a failed send keeps the Captain picked (the text is back in the box).
      sending.then(() => setToCaptain(false), () => {})
      return sending
    },
    [toCaptain, onSubmit, forward.mutateAsync, onForwarded, ask?.on, ask?.submit],
  )

  const sendToCaptain = useCallback(() => {
    flushSync(() => setToCaptain(true))
    handle.current?.submit()
  }, [])

  const hint = useCallback(
    (draft: string) => {
      if (asking)
        return (
          <div data-testid="task-ask-note" className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px] text-yard-300/80">
            <MessageCircleQuestion className="h-3 w-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">To the Coordinator, aside. The agent doesn't see it.</span>
          </div>
        )
      if (toCaptain)
        return (
          <div data-testid="captain-forward-note" className="flex min-w-0 items-center gap-1.5 px-1.5 pb-1 text-[11px] text-yard-300/80">
            <CaptainIcon projectId={task.projectId} className="h-3 w-3" />
            <span className="min-w-0 truncate">
              To the {captain}, not the agent{task.pendingCount ? `, with this task's ${queuedLabel(task.pendingCount)}` : ""}. Its reply shows here.
            </span>
          </div>
        )
      if (!suggest || dismissed || !looksLikeTaskManagement(draft)) return null
      return (
        <div role="status" data-testid="captain-suggest" className="mx-1 mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-yard-500/30 bg-yard-500/10 py-1 pr-1 pl-2 text-[11px] text-yard-200">
          <span className="min-w-0 flex-1 basis-40">
            Sounds like task management. The {captain} can act on it now; the agent only reads it {running ? "after this turn" : "when it starts"}.
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={sendToCaptain} className={cx(CHIP, "bg-yard-500/20 font-medium text-yard-100 hover:bg-yard-500/30")}>
              <CaptainIcon projectId={task.projectId} className="h-3.5 w-3.5" />
              Send to Captain
            </button>
            <button type="button" onClick={() => setDismissed(true)} aria-label="Keep it for the task" title="Keep it for the task" className={cx(CHIP, "px-1.5 text-yard-300/70 hover:text-yard-100")}>
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </div>
      )
    },
    [asking, toCaptain, suggest, dismissed, captain, task.projectId, task.pendingCount, running, sendToCaptain],
  )

  return (
    <Composer
      onDestinationPick={() => { setToCaptain(false); if (asking) askToggle?.() }}
      handleRef={handle}
      textareaRef={box}
      className={cx(COMPOSER_FOOTER, "mt-3 @container/composer", className)}
      onSubmit={submit}
      panelRef={panelRef}
      historyKey={asking ? `task-ask:${task.id}` : `task:${task.id}`}
      // One draft for the task, so turning "Side question" on or off keeps what's typed.
      draftKey={`task:${task.id}`}
      githubProject={task.projectId}
      files={!asking}
      hint={hint}
      stop={stop}
      icon={asking ? <ComposerIcon kind="side-question" label="Side question to the Coordinator about this task" /> : <TaskComposerIcon task={task} captain={toCaptain ? captain : null} />}
      tools={
        <>
          {ask && (
            <button
              type="button"
              data-testid="task-ask-toggle"
              aria-pressed={asking}
              onClick={pressAsk}
              title={asking ? "Asking the Coordinator aside: tap to message the task's agent again" : "Ask the Coordinator about this task in a side thread. The agent doesn't see it and keeps working"}
              className={cx(CHIP, "relative", asking ? "bg-yard-500/15 text-yard-200 ring-1 ring-yard-500/40" : "text-zinc-500 hover:text-zinc-200")}
            >
              <MessageCircleQuestion className="h-3.5 w-3.5 text-yard-400" aria-hidden />
              <span className={labels}>Side question</span>
              {!asking && (ask.busy || ask.unread) && (
                <span
                  data-testid="task-ask-dot"
                  role="img"
                  aria-label={ask.busy ? "An answer is on its way" : "A new answer"}
                  className={cx("absolute top-1 right-1 h-1.5 w-1.5 rounded-full pointer-coarse:top-2.5 pointer-coarse:right-1.5", ask.busy ? "animate-pulse bg-sky-400" : "bg-yard-400")}
                />
              )}
            </button>
          )}
          {showCaptain && (
            <button
              type="button"
              data-testid="captain-target"
              aria-pressed={toCaptain}
              onClick={toggleCaptain}
              title={
                toCaptain
                  ? "Sending to the Captain: tap to send to the task's agent instead"
                  : `Send this to the ${captain} instead of the agent: it can split, reprioritise or start tasks${task.pendingCount ? " and edit this task's queue" : ""}${running ? ", now rather than after this turn" : ""}`
              }
              className={cx(CHIP, toCaptain ? "bg-yard-500/15 text-yard-200 ring-1 ring-yard-500/40" : "text-zinc-500 hover:text-zinc-200")}
            >
              <CaptainIcon projectId={task.projectId} style={projectColorStyle(color)} className={cx("h-3.5 w-3.5", color ? "text-(--pc)" : "text-zinc-300")} />
              <span className={labels}>{toCaptain ? "To Captain" : "Captain"}</span>
            </button>
          )}
        </>
      }
      toolsMenu={
        chips ? (
          <>
            {ask && (
              <ChipLine
                data-testid="more-task-ask"
                icon={MessageCircleQuestion}
                label="Side question"
                detail={asking ? "On: asking the Coordinator aside" : (answer ?? "Ask the Coordinator aside")}
                aria-pressed={asking}
                onToggle={toggleAsk}
                box={box}
              />
            )}
            {showCaptain && (
              <ChipLine
                data-testid="more-captain-target"
                icon={captainIconFor(task.projectId)}
                label={toCaptain ? "To Captain" : "Captain"}
                detail={toCaptain ? `On: sending to the ${captain}` : `Send to the ${captain}`}
                aria-pressed={toCaptain}
                onToggle={toggleCaptain}
                box={box}
              />
            )}
          </>
        ) : undefined
      }
      toolSlots={chips}
      toolsDot={answer ? { label: answer, className: ask?.busy ? "bg-sky-400" : "bg-yard-400" } : null}
      placeholder={
        asking
          ? "Ask about this task…"
          : toCaptain
          ? `Message the ${captain}…`
          : task.status === "needs_input"
            ? "Answer the agent…"
            : running
              ? "Delivered when the current turn ends…"
              : "Send feedback or a follow-up…"
      }
    />
  )
})

/** A chip's line in the box's More menu, where it goes when the row is too narrow: it toggles, then closes the menu. */
function ChipLine({ onToggle, box, ...line }: Omit<ComponentProps<typeof ComposerMenuItem>, "onClick"> & { onToggle: () => void; box: RefObject<HTMLTextAreaElement | null> }) {
  const close = useCloseMore()
  return (
    <ComposerMenuItem
      {...line}
      onClick={() => {
        onToggle()
        close()
        // The text is where the next message goes (a keyboard user's focus was in the menu).
        box.current?.focus()
      }}
    />
  )
}

/**
 * "You → box-yard Captain": Cody's message sent from this chat to the Captain (TaskManager.forwardToCaptain), "You" as
 * in the Captain's own chat. The task's queued messages are named only when some went with it.
 */
export const ToCaptainLine = memo(function ToCaptainLine({ m }: { m: TaskMessage }) {
  const name = typeof m.meta?.captainName === "string" ? `${m.meta.captainName} Captain` : "Captain"
  const queued = typeof m.meta?.queued === "number" ? m.meta.queued : 0
  const pid = typeof m.meta?.captainProjectId === "string" ? m.meta.captainProjectId : null
  return (
    <div data-testid="to-captain" className={cx(MESSAGE_BLOCK, "rounded-lg border-l-2 border-dashed border-yard-500/70 bg-yard-500/5 px-3 py-2")}>
      {/* The time keeps the first line's end, whatever wraps before it. */}
      <div className="mb-0.5 flex min-w-0 items-baseline gap-x-1 text-[11px] font-semibold text-yard-400">
        <span className="min-w-0 wrap-anywhere">
          You → {pid ? <AppLink href={captainHref(pid)} className="hover:underline">{name}</AppLink> : name}
          {queued > 0 && <span className="font-normal text-zinc-500"> · with {queuedLabel(queued)}</span>}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[10px] font-normal whitespace-nowrap text-zinc-600">
          <TimeAgo ts={m.createdAt} />
        </span>
      </div>
      {m.content && <div className="text-sm whitespace-pre-wrap wrap-anywhere text-zinc-200">{m.content}</div>}
      <AttachmentList files={m.meta?.attachments as Attachment[] | undefined} />
      {!m.meta?.pending && <MessageActions text={m.content} />}
    </div>
  )
})

/** The Captain's reply to a message sent from this chat (TaskManager.captainAnsweredForwards). */
export const CaptainAnswerLine = memo(function CaptainAnswerLine({ m }: { m: TaskMessage }) {
  const name = typeof m.meta?.captainName === "string" ? `${m.meta.captainName} Captain` : "Captain"
  const pid = typeof m.meta?.captainProjectId === "string" ? m.meta.captainProjectId : null
  // The Captain's icon in its project's colour, as everywhere a Captain shows.
  const color = useProjectColor(pid)
  return (
    <div data-testid="captain-answer" style={projectColorStyle(color)} className={cx(MESSAGE_BLOCK, "flex min-w-0 items-start gap-2 rounded-lg bg-yard-500/5 px-3 py-2 text-sm leading-relaxed")}>
      <LineIcon icon={captainIconFor(pid)} className={cx("h-4 w-4", color ? "text-(--pc)" : "text-zinc-300")} />
      <div className="min-w-0 text-zinc-200 [&>.prose-chat>:first-child]:mt-0!">
        <div className="mb-0.5 text-[11px] leading-5 font-semibold text-yard-400">
          {pid ? <AppLink href={captainHref(pid)} className="hover:underline">{name}</AppLink> : name}
          <span className="font-normal text-zinc-500"> · replied</span>
          <span className="ml-2 text-[10px] font-normal text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        <Markdown>{m.content}</Markdown>
      </div>
      <MessageActions text={m.content} />
    </div>
  )
})
