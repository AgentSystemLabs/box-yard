// Select text in a chat or transcript to act on it. In a chat with side threads (useThreadChat: the Coordinator's or
// a Captain's), "Reply quoting selection" opens the message's reply thread (SideThread.tsx) with the passage quoted in
// its box: the chat's agent routes what Cody writes there, which covers asking about it and starting work from it. In
// a task's transcript, "New task from selection" opens the shared New task popover with the quote and a box for
// instructions. Enter sends both to whoever routes the work (the Coordinator), as its button says, and the toast after
// it opens that chat; "Start it myself…" starts the task directly from the full New task dialog, which shows the quote
// and takes the instructions.
//
// A mouse gets the action as a pill over the selection. A finger gets a bar just above the chat's composer, or on it
// while the selection reaches down to where the bar would be.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react"
import { MessageSquarePlus, Reply } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { buildSelectionTaskBrief, buildSelectionTaskPrompt, selectionTarget, type SelectionTaskSource } from "../lib/selectionTask"
import { clearNewTaskDraft, newTaskDraftKey, saveDraft, selectionScope } from "../lib/newTask"
import { toast } from "../lib/toast"
import { openChat } from "../lib/navigation"
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
  /** The phone bar's distance from the bottom of the window when it sits above the composer; null: over it. */
  bar: number | null
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
  /** "Start it myself…": the full New task dialog for this selection and the instructions typed so far. */
  const [dialog, setDialog] = useState<{ text: string; instructions: string } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  /** This chat's composer, found once: the phone bar sits above it. */
  const composer = useRef<HTMLElement | null>(null)
  const popoverId = useId()
  const ownerName = useOwnerName()
  const qc = useQueryClient()
  const threadChat = useThreadChat()
  const replyTo = useReplyTo()
  const canReply = Boolean(replyTo && selection?.anchorId)

  useEffect(() => {
    const update = () => {
      if (!source && !threadChat) return setSelection(null)
      const info = readSelection(root.current, composer)
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
      ? { icon: MessageSquarePlus, label: "New task from selection", bar: "New task from selection", testid: "selection-task", run: open, popup: "dialog" as const }
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
          <div
            data-selection-task-action
            className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex gap-2 [@media(pointer:fine)]:hidden"
            style={selection.bar === null ? undefined : { bottom: selection.bar }}
          >
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
            submitLabel={`Send to ${selectionTarget(source)}`}
            moreLabel="Start it myself…"
            scope={selectionScope(draft.text)}
            align="center"
            defaultProjectId={source.project?.id}
            onStart={(instructions) => {
              onPrompt(buildSelectionTaskPrompt({ source, selectedText: draft.text, instructions, ownerName }))
              finish()
              // With an action, so it shows in a task's view too (its toasts are the quiet ones), and leads to the answer.
              toast.info(`Sent to ${selectionTarget(source)}`, "It will decide where this task belongs.", {
                action: { label: "Open chat", onClick: () => openChat(source.kind === "captain" ? source.project.id : null) },
                duration: 8000,
              })
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
          // The source's project to start with, not for good: a follow-up may belong to another one.
          defaultProjectId={source.project?.id}
          initialPrompt={dialog.instructions}
          quote={dialog.text}
          compose={(instructions) => buildSelectionTaskBrief({ source, selectedText: dialog.text, instructions })}
          draftKey={newTaskDraftKey(selectionScope(dialog.text))}
          onCancel={(instructions) => {
            // Kept for this quote, as the popover keeps them.
            saveDraft(selectionScope(dialog.text), instructions)
            setDialog(null)
          }}
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

/** The bar's height and the gap around it. */
const BAR_ROOM = 64

/** The composer of the chat `root` is in: the nearest one up the tree (chats kept beside it have their own). */
function composerOf(root: HTMLElement, found: { current: HTMLElement | null }): HTMLElement | null {
  if (found.current?.isConnected) return found.current
  for (let el = root.parentElement; el; el = el.parentElement) {
    const box = el.querySelector<HTMLElement>("[data-composer-box]")
    if (box) return (found.current = box.closest("form") ?? box)
  }
  return null
}

/** Where the phone bar goes: above the composer, unless there isn't one on screen or the selection is in the way. */
function barBottom(root: HTMLElement, found: { current: HTMLElement | null }, range: Range): number | null {
  if (window.matchMedia?.("(pointer: fine)").matches) return null
  const top = composerOf(root, found)?.getBoundingClientRect().top ?? 0
  if (top <= BAR_ROOM || top > window.innerHeight || range.getBoundingClientRect().bottom > top - BAR_ROOM) return null
  return window.innerHeight - top + 8
}

function readSelection(root: HTMLElement | null, composer: { current: HTMLElement | null }): SelectionInfo | null {
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
    bar: barBottom(root, composer, range),
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
