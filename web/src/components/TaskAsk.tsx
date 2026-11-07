// A task's side questions, in the task panel (TaskSession.tsx): Cody asks the Coordinator about the task in the
// task's own side thread (kind "task", server/sideThreads.ts). The Coordinator answers read-only, from the task as it
// stands; the task's agent never sees the questions and isn't interrupted. The panel's box switches to them with its
// "Side question" button (TaskComposer), and they show here in place of the transcript until it switches back. They're
// a level inside the panel (useModalStep in TaskSession): the header's Back and Esc return to the transcript.
import { memo, useEffect, type Ref } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { ThreadLine, ThreadStreaming } from "./SideThread"
import { RecommendedNextSteps } from "./RecommendedNextSteps"
import { CHAT_COLUMN } from "./TaskHeader"
import { cx } from "./ui"
import { COORDINATOR_CHAT, useTaskThread, useThreadControl, useThreadMessages } from "../lib/threads"
import type { SideThreadMessage } from "../../../shared/types"

const NO_MESSAGES: SideThreadMessage[] = []

/** Questions to start from, before the first one. */
export const TASK_ASK_STARTERS = ["Where is it up to?", "What's left before it's done?", "Is anything blocking it?"]

export const TaskAsk = memo(function TaskAsk({
  taskId,
  handle,
  onAsk,
}: {
  taskId: string
  handle: Ref<StickyScrollHandle>
  /** A starter question, sent as if typed. */
  onAsk: (question: string) => void
}) {
  const thread = useTaskThread(taskId)
  const messages = useThreadMessages(thread?.id ?? "", Boolean(thread)).data ?? NO_MESSAGES
  const control = useThreadControl(COORDINATOR_CHAT)
  // Shown: its answers are read, now and as they arrive.
  const unread = Boolean(thread?.unread)
  useEffect(() => {
    if (unread && thread) control.seen(thread.id)
  }, [unread, thread?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div data-testid="task-ask" className="flex min-h-0 flex-1 flex-col">
      {/* Where you are; the header's Back is the way out, so there's no second one here. In the task's column, as the transcript. */}
      <h3 className={cx(CHAT_COLUMN, "flex shrink-0 items-center gap-1 pt-2.5 text-xs font-medium text-yard-300")}>
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Side questions
      </h3>
      <StickyScroll handle={handle} count={messages.length} resetKey={thread?.id ?? taskId} className="chat-column py-3" contentClassName="space-y-3">
        {messages.length === 0 && (
          <div data-testid="task-ask-intro" className="rounded-lg border border-zinc-900 bg-zinc-900/40 px-3 py-2.5 text-xs leading-5 text-zinc-400">
            Ask the Coordinator about this task. It answers from the task as it stands; the agent doesn't see your questions and keeps working.
            <RecommendedNextSteps steps={TASK_ASK_STARTERS} onPick={onAsk} />
          </div>
        )}
        {messages.map((m) => (
          <ThreadLine key={m.id} m={m} />
        ))}
        {thread && <ThreadStreaming id={thread.id} busy={Boolean(thread.busy)} />}
      </StickyScroll>
    </div>
  )
})
