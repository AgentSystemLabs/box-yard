// Select text in a chat or transcript to act on it. In a chat with side threads (useThreadChat: the Coordinator's or
// a Captain's), "Reply quoting selection" opens the message's reply thread (SideThread.tsx) with the passage quoted in
// its box: the chat's agent routes what Cody writes there, which covers asking about it and starting work from it. In
// a task's transcript, "Start new task" opens the shared New task popover with the quote and a box for instructions.
// Enter sends both to whoever routes the work (the Coordinator); "More options" starts the task directly from the
// full New task dialog.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { MessageSquarePlus, Reply } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { buildSelectionTaskBrief, buildSelectionTaskPrompt, selectionTarget, type SelectionTaskSource } from "../lib/selectionTask"
import { clearNewTaskDraft, selectionScope } from "../lib/newTask"
import { toast } from "../lib/toast"
import { useOwnerName } from "../lib/queries"
import { NewTaskDialog, NewTaskPopover } from "./NewTask"
import { useReplyTo, useThreadChat } from "./SideThread"
import { quoteLines } from "./MessageActions"
import { chatMessageText } from "../lib/threads"

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface SelectionInfo {
  text: string
  x: number
  y: number
  /** The chat message the selection ends in (`data-chat-id`), whose reply thread it quotes into. */
  anchorId: string | null
}

export function SelectionToTask({
  source,
  onPrompt,
  children,
}: {
  source: SelectionTaskSource | null
  onPrompt: (prompt: string) => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** The New task popover is open on this selection, hanging from where its button was. */
  const [draft, setDraft] = useState<{ text: string; rect: Rect } | null>(null)
  /** "More options": the full New task dialog for this selection and the instructions typed so far. */
  const [dialog, setDialog] = useState<{ text: string; instructions: string } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const popoverId = useId()
  const ownerName = useOwnerName()
  const qc = useQueryClient()
  const threadChat = useThreadChat()
  const replyTo = useReplyTo()
  const canReply = Boolean(replyTo && selection?.anchorId)

  useEffect(() => {
    const update = () => {
      if (!source && !threadChat) return setSelection(null)
      const info = readSelection(root.current)
      setSelection(info)
    }
    const clearIfOutside = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || root.current?.contains(target) || [...document.querySelectorAll("[data-selection-task-action]")].some((el) => el.contains(target))) return
      setSelection(null)
    }
    document.addEventListener("selectionchange", update)
    window.addEventListener("keyup", update)
    window.addEventListener("pointerup", update)
    window.addEventListener("touchend", update)
    window.addEventListener("pointerdown", clearIfOutside)
    window.addEventListener("scroll", update, true)
    return () => {
      document.removeEventListener("selectionchange", update)
      window.removeEventListener("keyup", update)
      window.removeEventListener("pointerup", update)
      window.removeEventListener("touchend", update)
      window.removeEventListener("pointerdown", clearIfOutside)
      window.removeEventListener("scroll", update, true)
    }
  }, [source, threadChat])

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    if (!selection) return
    const r = e.currentTarget.getBoundingClientRect()
    setDraft({ text: selection.text, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    setSelection(null)
  }

  /** The message's reply thread, with the passage quoted in its box and the caret after it. */
  const reply = () => {
    const sel = selection
    if (!replyTo || !threadChat || !sel?.anchorId) return
    replyTo(sel.anchorId, chatMessageText(qc, threadChat, sel.anchorId) ?? sel.text, `${quoteLines(sel.text)}\n\n`)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const finish = () => {
    setDraft(null)
    window.getSelection()?.removeAllRanges()
  }

  /** One action: a reply where the chat has threads, otherwise a new task. */
  const action = canReply
    ? { icon: Reply, label: "Reply quoting selection", bar: "Reply quoting selection", testid: "selection-reply", run: reply, popup: undefined }
    : source
      ? { icon: MessageSquarePlus, label: "Start new task", bar: "Start new task from selection", testid: "selection-task", run: open, popup: "dialog" as const }
      : null

  return (
    <div ref={root} className="contents">
      {children}
      {selection && !draft && action && (
        <>
          {/* Pressing these keeps the selection and the focus where they are (never the composer's). */}
          <div
            data-selection-task-action
            className="fixed z-40 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-yard-400/50 bg-zinc-900/95 p-0.5 shadow-lg shadow-black/40 backdrop-blur [@media(pointer:fine)]:flex"
            style={{ left: selection.x, top: selection.y }}
          >
            <button type="button" data-testid={action.testid} data-selection-task-action aria-haspopup={action.popup} onMouseDown={(e) => e.preventDefault()} onClick={action.run} className={PILL}>
              <action.icon className="h-3.5 w-3.5" /> {action.label}
            </button>
          </div>
          <div data-selection-task-action className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex gap-2 [@media(pointer:fine)]:hidden">
            <button type="button" aria-haspopup={action.popup} onMouseDown={(e) => e.preventDefault()} onClick={action.run} className={BAR}>
              <action.icon className="h-4 w-4 shrink-0" /> {action.bar}
            </button>
          </div>
        </>
      )}
      {source && draft && (
        <>
          {/* Where the action button was: the popover hangs from it (the button itself goes once the selection does). */}
          <span ref={anchor} aria-hidden className="pointer-events-none fixed" style={draft.rect} />
          <NewTaskPopover
            key="selection"
            id={popoverId}
            trigger={anchor}
            heading="New task from selection"
            quote={draft.text}
            placeholder="Additional instructions (optional)"
            scope={selectionScope(draft.text)}
            align="center"
            defaultProjectId={source.project?.id}
            onStart={(instructions) => {
              onPrompt(buildSelectionTaskPrompt({ source, selectedText: draft.text, instructions, ownerName }))
              finish()
              toast.info(`Sent to ${selectionTarget(source)}`, "It will decide where this task belongs.")
            }}
            onClose={() => setDraft(null)}
            onMore={(_, instructions) => {
              setDialog({ text: draft.text, instructions })
              setDraft(null)
            }}
          />
        </>
      )}
      {source && dialog && (
        <NewTaskDialog
          projectId={source.project?.id}
          initialPrompt={buildSelectionTaskBrief({ source, selectedText: dialog.text, instructions: dialog.instructions })}
          onCancel={() => setDialog(null)}
          onDone={() => {
            clearNewTaskDraft(selectionScope(dialog.text))
            setDialog(null)
            finish()
          }}
        />
      )}
    </div>
  )
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-yard-200 hover:bg-zinc-800 hover:text-yard-100 focus:ring-2 focus:ring-yard-500 focus:outline-none"
const BAR =
  "flex min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl border border-yard-400/50 bg-zinc-900/95 px-4 py-3 text-sm font-medium text-yard-100 shadow-2xl shadow-black/50 backdrop-blur"

function readSelection(root: HTMLElement | null): SelectionInfo | null {
  if (!root) return null
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ""
  if (!sel || sel.rangeCount === 0 || text.length < 3) return null
  const range = sel.getRangeAt(0)
  if (!contains(root, range.commonAncestorContainer)) return null
  // A long message's Reply pill is out beside it: the pill quotes the selection itself (MessageActions).
  if ([...document.querySelectorAll("[data-reply-pill][data-open]")].some((pill) => pill.parentElement && contains(pill.parentElement, range.commonAncestorContainer))) return null
  const rect = usefulRect(range)
  if (!rect) return null
  const message = (node: Node) => (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest?.("[data-chat-id]")
  return {
    text,
    anchorId: (message(range.endContainer) ?? message(range.startContainer))?.getAttribute("data-chat-id") ?? null,
    x: clamp(rect.left + rect.width / 2, 120, window.innerWidth - 120),
    y: clamp(rect.top - 42, 12, window.innerHeight - 52),
  }
}

function usefulRect(range: Range): DOMRect | null {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
  return rects[0] ?? (range.getBoundingClientRect().width ? range.getBoundingClientRect() : null)
}

function contains(root: HTMLElement, node: Node): boolean {
  const target = node.nodeType === Node.TEXT_NODE ? node.parentNode : node
  return target ? root.contains(target) : false
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
