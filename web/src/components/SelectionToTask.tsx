// Select text in a chat, a task's transcript or a side thread to act on it. Two actions, the same everywhere:
//
// - "Ask" opens the side panel on a thread about the passage, which shows quoted above a box for the question
//   (SideThread.tsx). The question is asked from inside whatever the passage is in: a chat message, a task's transcript
//   (a thread of its project's Captain chat, shown in the task's panel), or another thread, which the new one then
//   nests under, to any depth.
// - "Create task" opens the shared New task popover with the passage quoted and a box for the request. Sending it
//   messages whoever creates the task, as its button says: the project's Captain (a task's, or the Captain chat's own),
//   or the Coordinator from its chat. The message asks for a new task from the request and the passage, and says where
//   the passage was highlighted (lib/selectionTask.ts). Nothing here creates a task itself. A toast confirms and opens
//   that chat.
//
// A mouse gets the actions as a pill over the selection. A finger gets them as a bar, centred just above the chat's
// composer, or under the chat's header when that side is the one clear of the selection: never over the composer.
import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { ListPlus, MessageCircleQuestion } from "lucide-react"
import { buildSelectionTaskPrompt, selectionTarget, selectionTargetProject, type SelectionTaskSource } from "../lib/selectionTask"
import { selectionScope } from "../lib/newTask"
import { toast } from "../lib/toast"
import { openChat } from "../lib/navigation"
import { newClientId, useOwnerName, useSendCaptainMessage, useSendChat } from "../lib/queries"
import { NewTaskPopover } from "./NewTask"
import { openAsk, useThreadChat, type ThreadChat, type ThreadSlot } from "../lib/threads"

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
  /** The chat message the selection ends in (`data-chat-id`), which a question about it is anchored on. */
  anchorId: string | null
  /** Where the phone bar sits when the chat has a composer on screen (barPlace); null: at the window's bottom edge. */
  bar: CSSProperties | null
}

/** Where "Ask" puts its thread. */
export interface SelectionAsk {
  /** The chat the thread belongs to: the Coordinator's or a Captain's. */
  chat: ThreadChat
  /** Where it opens, when that isn't the chat's own side panel (a task's panel, lib/threads.ts' taskSlot). */
  slot?: ThreadSlot
  /** What it's anchored on, when that isn't the chat message the selection is in: a task (its transcript), or a thread's own anchor. */
  anchorId?: string
  /** The thread the selection is in: the question nests under it. */
  parentId?: string
}

/** The longest passage a thread takes (server/sideThreads.ts' MAX_QUOTE_CHARS); a longer selection is cut to it. */
const MAX_ASK_QUOTE = 20_000

export function SelectionToTask({
  source,
  askOn,
  thread = null,
  children,
}: {
  /** Where these lines are, for "Create task": who gets it and what it says. Null: no Create task (still loading). */
  source: SelectionTaskSource | null
  /** Where "Ask" goes. Left out: the chat these lines are in (ThreadChatProvider), on the selected message. Null: no Ask. */
  askOn?: SelectionAsk | null
  /** The side thread these lines are in, which "Create task" names as where the passage was highlighted. */
  thread?: { id: string; quote: string } | null
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  /** The Create task popover is open on this selection, hanging from where its button was. */
  const [draft, setDraft] = useState<{ text: string; messageId: string | null; rect: Rect } | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  /** This chat's composer, found once: the phone bar sits above it. */
  const composer = useRef<HTMLElement | null>(null)
  const popoverId = useId()
  const ownerName = useOwnerName()
  const threadChat = useThreadChat()
  const ask: SelectionAsk | null = askOn === undefined ? (threadChat ? { chat: threadChat } : null) : askOn
  const askAnchor = ask ? (ask.anchorId ?? selection?.anchorId ?? null) : null
  const sendChat = useSendChat()
  const sendCaptain = useSendCaptainMessage(source ? (selectionTargetProject(source) ?? "") : "")
  const on = Boolean(source || ask)

  useEffect(() => {
    const update = () => {
      if (!on) return setSelection(null)
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
  }, [on])

  /**
   * The side panel on a thread about the passage, the caret in its box. In the press's own commit (flushSync), so the
   * box takes the focus before the handler returns, which is what brings up a phone's keyboard.
   */
  const askAbout = () => {
    const sel = selection
    if (!ask || !sel || !askAnchor) return
    flushSync(() => openAsk(ask.slot ?? ask.chat, { anchorId: askAnchor, quote: sel.text.slice(0, MAX_ASK_QUOTE), parentId: ask.parentId }))
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const createTask = (e: MouseEvent<HTMLButtonElement>) => {
    if (!selection) return
    // The pill or the bar, whichever was pressed: the popover hangs from it.
    const r = (e.currentTarget.closest("[data-selection-task-action]:not(button)") ?? e.currentTarget).getBoundingClientRect()
    setDraft({ text: selection.text, messageId: selection.anchorId, rect: { left: r.left, top: r.top, width: r.width, height: r.height } })
    setSelection(null)
  }

  /** To the project's Captain, or the Coordinator: it creates the task. The toast leads to its chat, where it answers. */
  const send = (source: SelectionTaskSource, text: string, messageId: string | null, instructions: string) => {
    const content = buildSelectionTaskPrompt({ source, selectedText: text, instructions, place: { messageId, thread }, ownerName })
    const projectId = selectionTargetProject(source)
    const input = { id: newClientId("chat"), content, attachments: [] }
    const sending = projectId ? sendCaptain.mutateAsync({ ...input, projectId }) : sendChat.mutateAsync(input)
    const target = selectionTarget(source)
    // Once it's there; a send that fails says so itself. With an action, so it shows in a task's view too (its toasts
    // are the quiet ones).
    sending.then(
      () =>
        toast.info(`Sent to ${target}`, projectId ? `It creates the task in ${source.project!.name}.` : "It creates the task in the project it belongs to.", {
          action: { label: "Open chat", onClick: () => openChat(projectId) },
          duration: 8000,
        }),
      () => {},
    )
  }

  const actions = [
    ...(askAnchor ? [{ key: "ask", icon: MessageCircleQuestion, label: "Ask", title: "Ask about the selected text in a side thread", run: askAbout, popup: undefined }] : []),
    ...(source ? [{ key: "task", icon: ListPlus, label: "Create task", title: `Create a task from the selected text: ${selectionTarget(source)} gets it`, run: createTask, popup: "dialog" as const }] : []),
  ]

  return (
    <div ref={root} className="contents">
      {children}
      {selection && !draft && actions.length > 0 && (
        <>
          {/* Pressing these keeps the selection and the focus where they are (never the composer's). */}
          <div
            data-selection-task-action
            role="group"
            aria-label="Selected text"
            className="fixed z-40 hidden w-max -translate-x-1/2 items-center gap-0.5 rounded-full border border-yard-400/50 bg-zinc-900/95 p-0.5 shadow-lg shadow-black/40 backdrop-blur [@media(pointer:fine)]:flex"
            style={{ left: selection.x, top: selection.y }}
          >
            {actions.map((a) => (
              <button key={a.key} type="button" data-testid={`selection-${a.key}`} data-selection-task-action title={a.title} aria-haspopup={a.popup} onMouseDown={(e) => e.preventDefault()} onClick={a.run} className={PILL}>
                <a.icon className="h-3.5 w-3.5" aria-hidden /> {a.label}
              </button>
            ))}
          </div>
          <div
            data-selection-task-action
            role="group"
            aria-label="Selected text"
            className={BAR}
            style={selection.bar ?? undefined}
          >
            {actions.map((a) => (
              <button key={a.key} type="button" data-testid={`selection-${a.key}-bar`} aria-haspopup={a.popup} onMouseDown={(e) => e.preventDefault()} onClick={a.run} className={BAR_BUTTON}>
                <a.icon className="h-4 w-4 shrink-0" aria-hidden /> {a.label}
              </button>
            ))}
          </div>
        </>
      )}
      {source && draft && (
        <>
          {/* Where the actions were: the popover hangs from there (they go once the selection does). */}
          <span ref={anchor} aria-hidden className="pointer-events-none fixed" style={draft.rect} />
          <NewTaskPopover
            key="selection"
            id={popoverId}
            trigger={anchor}
            heading="Create task"
            quote={draft.text}
            placeholder="What should the task do? (optional)"
            submitLabel={`Send to ${selectionTarget(source)}`}
            scope={selectionScope(draft.text)}
            align="center"
            defaultProjectId={source.project?.id}
            onStart={(instructions) => {
              send(source, draft.text, draft.messageId, instructions)
              setDraft(null)
              window.getSelection()?.removeAllRanges()
            }}
            onClose={() => setDraft(null)}
          />
        </>
      )}
    </div>
  )
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap text-yard-200 hover:bg-zinc-800 hover:text-yard-100 focus:ring-2 focus:ring-yard-500 focus:outline-none"
/** The phone's bar: one rounded box, a 44px button per action. */
const BAR =
  "fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 z-40 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-stretch divide-x divide-yard-400/30 overflow-hidden rounded-2xl border border-yard-400/50 bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur [@media(pointer:fine)]:hidden"
const BAR_BUTTON = "flex min-h-11 min-w-11 items-center justify-center gap-2 px-4 py-3 text-sm font-medium whitespace-nowrap text-yard-100 active:bg-zinc-800"

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

/**
 * Where the phone bar goes: just above the composer while the selection ends clear of there, else on the side with
 * more room clear of it, which is mostly under the chat's header (the top of what scrolls), below a notch. Never over
 * the composer. Null without a composer on screen: the window's bottom edge then covers nothing.
 */
function barPlace(root: HTMLElement, found: { current: HTMLElement | null }, range: Range): CSSProperties | null {
  if (window.matchMedia?.("(pointer: fine)").matches) return null
  const box = composerOf(root, found)?.getBoundingClientRect()
  const top = box?.top ?? 0
  if (!box || top <= BAR_ROOM || top > window.innerHeight) return null
  // Centred on its chat, which a tablet shows beside others.
  const left = box.left + box.width / 2
  const node = range.commonAncestorContainer
  const scroller = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest("[data-scroller]")
  const head = Math.max(0, Math.round(scroller?.getBoundingClientRect().top ?? 0))
  const picked = range.getBoundingClientRect()
  // The room left on each side of the selection, of what shows of it.
  const below = Math.max(0, top - picked.bottom)
  const above = Math.max(0, picked.top - head)
  if (below >= BAR_ROOM || below > above) return { left, bottom: window.innerHeight - top + 8 }
  return { left, top: `max(${head + 8}px, calc(env(safe-area-inset-top) + 0.5rem))`, bottom: "auto" }
}

function readSelection(root: HTMLElement | null, composer: { current: HTMLElement | null }): SelectionInfo | null {
  if (!root) return null
  const sel = window.getSelection()
  const text = sel?.toString().trim() ?? ""
  if (!sel || sel.rangeCount === 0 || text.length < 3) return null
  const range = sel.getRangeAt(0)
  if (!contains(root, range.commonAncestorContainer)) return null
  const rect = usefulRect(range)
  if (!rect) return null
  const message = (node: Node) => (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest?.("[data-chat-id]")
  return {
    text,
    anchorId: (message(range.endContainer) ?? message(range.startContainer))?.getAttribute("data-chat-id") ?? null,
    x: clamp(rect.left + rect.width / 2, 120, window.innerWidth - 120),
    y: clamp(rect.top - 42, 12, window.innerHeight - 52),
    bar: barPlace(root, composer, range),
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
