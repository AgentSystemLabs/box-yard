// Queued messages: sent while an agent, the Coordinator or a Captain is mid-turn, waiting for its next turn.
// The task page lists them as Queued rows below the live transcript, in send order; the Coordinator chat and
// the Captain tab show them as their usual bubbles under the live turn (QueuedChatMessage). Each can be edited
// in place or cancelled until a turn takes it; the server refuses changes after that ("already delivered"), so an
// edit or cancel never races the delivery. Cancel takes the message back: its text and files go back in the
// chat's message box to fix and send again (lib/takeBack.ts), and Undo queues it again. On the task page, Steer
// requests delivery of the whole queue into a running Claude/Codex turn; Stop is a separate action.
// Codex acceptance/uncertainty stays visible until the turn settles. Cursor waits for the turn's end.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Clock, Loader2, Navigation2, Pencil, X } from "lucide-react"
import type { Attachment, CaptainMessage, ChatMessage, QueuedMessage } from "../../../shared/types"
import { keys, useOwnerName, useQueuedChatActions, useQueuedMessageActions, useSteerQueued, useSteerState, useTaskQueue } from "../lib/queries"
import { isQueued } from "../lib/queued"
import { takeBack } from "../lib/takeBack"
import { primeSendSound } from "../lib/sendSound"
import { UNDO_MS } from "../lib/inbox"
import { navigate } from "wouter/use-browser-location"
import { QUEUE_HASH, REVEAL_QUEUE_EVENT, revealTaskQueue } from "../lib/reveal"
import { toast } from "../lib/toast"
import { AttachmentList } from "./Attachments"
import { Button, LineIcon, TimeAgo, cx } from "./ui"

/** Square icon buttons: 44px touch targets on phones, 24px from sm. */
const ICON_BUTTON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none sm:h-6 sm:w-6"

/** Steer, with its name: 44px tall on phones, 24px from sm. */
const STEER_BUTTON =
  "flex h-11 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-semibold text-yard-300 transition hover:bg-zinc-800 hover:text-yard-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none disabled:opacity-50 sm:h-6 sm:px-1.5"

const CANCEL_TITLE = "Cancel: it goes back in the message box to edit"
const STEER_TITLE = "Steer: request delivery of the queued messages into the running turn"

export const TaskQueue = memo(function TaskQueue({ taskId }: { taskId: string }) {
  const queue = useTaskQueue(taskId)
  const { edit, remove, restore } = useQueuedMessageActions(taskId)
  const steerState = useSteerState(taskId)
  const steer = useSteerQueued(taskId)
  const [editing, setEditing] = useState<string | null>(null)
  // Cancelled rows stay in place as an Undo line for a few seconds (the server keeps them longer).
  const [deleted, setDeleted] = useState<QueuedMessage[]>([])
  // Each cancelled row's text went back in the message box (or its draft, with no box on screen): its Undo takes it out again (lib/takeBack.ts).
  const untakes = useRef(new Map<string, () => void>())
  const list = queue.data ?? []
  const root = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const live = new Set(list.map((m) => m.id))
    return [...list.map((m) => ({ m, deleted: false })), ...deleted.filter((m) => !live.has(m.id)).map((m) => ({ m, deleted: true }))].sort(
      (a, b) => a.m.createdAt - b.m.createdAt,
    )
  }, [list, deleted])

  // The row being edited went out (or someone else deleted it) before the edit was saved: say so.
  const editingGone = editing !== null && queue.isFetched && !list.some((m) => m.id === editing)
  useEffect(() => {
    if (!editingGone) return
    setEditing(null)
    toast.error("Already delivered", "The agent got the message as it was, so your edit wasn't saved. Send it as a new message if it still matters.")
  }, [editingGone])

  // /tasks/:id#queue (the "N queued" badge) scrolls here.
  const reveal = useCallback(() => {
    if (window.location.hash === QUEUE_HASH) root.current?.scrollIntoView({ block: "nearest" })
  }, [])
  useEffect(() => {
    reveal()
    const onReveal = (e: Event) => (e as CustomEvent<string>).detail === taskId && requestAnimationFrame(reveal)
    window.addEventListener(REVEAL_QUEUE_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_QUEUE_EVENT, onReveal)
  }, [taskId, reveal, rows.length > 0])

  const onDelete = useCallback(
    (m: QueuedMessage) => {
      if (m.status === "uncertain") { remove.mutate(m.id); return }
      if (editing === m.id) setEditing(null)
      const untake = takeBack(`task:${taskId}`, m.text, m.attachments, root.current)
      untakes.current.set(m.id, untake)
      remove.mutate(m.id, {
        onSuccess: () => setDeleted((d) => [...d.filter((x) => x.id !== m.id), m]),
        // Already delivered: the agent has it, so it leaves the box again.
        onError: () => {
          untake()
          untakes.current.delete(m.id)
        },
      })
    },
    [taskId, editing, remove.mutate],
  )
  const onUndo = useCallback(
    (m: QueuedMessage) => {
      setDeleted((d) => d.filter((x) => x.id !== m.id))
      untakes.current.get(m.id)?.()
      untakes.current.delete(m.id)
      restore.mutate(m)
    },
    [restore.mutate],
  )
  const onSave = useCallback(
    (m: QueuedMessage, text: string) => {
      setEditing(null)
      if (text.trim() !== m.text) edit.mutate({ id: m.id, text, version: m.version })
    },
    [edit.mutate],
  )
  const dropUndo = useCallback((id: string) => {
    untakes.current.delete(id)
    setDeleted((d) => d.filter((x) => x.id !== id))
  }, [])
  const running = Boolean(steerState?.running)
  // Turn: a running turn can take it, so Steer shows; a Cursor turn can't (its rows say so).
  const noSteer = steerState?.noSteer ?? null
  const turn: QueuedTurn = !running ? "none" : noSteer ? "unsteerable" : steerState?.compacting ? "compacting" : "steerable"
  const onSteer = useCallback(() => {
    primeSendSound()
    steer.mutate()
  }, [steer.mutate])

  if (!rows.length) return null
  return (
    <div ref={root} id="task-queue" role="list" aria-label="Queued messages" className="scroll-mt-4 space-y-1.5 pt-1">
      {rows.map(({ m, deleted }) =>
        deleted ? (
          <DeletedRow key={m.id} m={m} onUndo={onUndo} onExpire={dropUndo} />
        ) : (
          <QueuedRow
            key={m.id}
            m={m}
            editing={editing === m.id}
            onEdit={setEditing}
            onSave={onSave}
            onDelete={onDelete}
            turn={turn}
            noSteer={noSteer}
            steering={steer.isPending}
            onSteer={onSteer}
          />
        ),
      )}
    </div>
  )
})

/** The turn a queued row waits on: none running, one Steer can reach, a /compact, or a Cursor turn (no steering). */
type QueuedTurn = "none" | "steerable" | "compacting" | "unsteerable"

const WAITS: Record<QueuedTurn, (cli: string) => string> = {
  none: () => "Delivered when the agent's next turn starts.",
  steerable: () => "Delivered when the current turn ends, or during the turn with Steer.",
  compacting: () => "Delivered once the agent has compacted its context.",
  unsteerable: (cli) => `Delivered when the current turn ends: ${cli} can't take a message mid-turn.`,
}

const QueuedRow = memo(function QueuedRow({
  m,
  editing,
  onEdit,
  onSave,
  onDelete,
  turn,
  noSteer,
  steering,
  onSteer,
}: {
  m: QueuedMessage
  editing: boolean
  onEdit: (id: string | null) => void
  onSave: (m: QueuedMessage, text: string) => void
  onDelete: (m: QueuedMessage) => void
  turn: QueuedTurn
  /** The CLI's name when it can't take a message mid-turn (Cursor). */
  noSteer: string | null
  /** A Steer is on its way to the server. */
  steering: boolean
  onSteer: () => void
}) {
  const ownerName = useOwnerName()
  const steered = m.status === "steering"
  const locked = m.status === "delivering" || steered || m.status === "accepted" || m.status === "uncertain"
  // An optimistic row (just sent) has no server id yet.
  const settled = !m.id.startsWith("tmp-")
  return (
    <div
      role="listitem"
      data-testid="queued-message"
      className={cx("@container rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-3 py-2", locked && "opacity-70")}
    >
      <div className="flex min-h-6 items-center gap-1.5 text-[11px] text-zinc-500">
        {steered ? (
          <LineIcon icon={Navigation2} className="h-3 w-3 rotate-90 text-yard-300" />
        ) : (
          <LineIcon icon={m.status === "accepted" || m.status === "uncertain" ? Clock : locked ? Loader2 : Clock} className={cx("h-3 w-3", m.status === "delivering" && "animate-spin")} />
        )}
        <span className={cx("font-semibold", steered ? "text-yard-300" : "text-zinc-400")}>{m.status === "uncertain" ? "Delivery uncertain" : m.status === "accepted" ? "Accepted by Codex" : steered ? "Steering" : locked ? "Delivering" : "Queued"}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{m.sender || ownerName}</span>
        {/* Too narrow for the time next to Steer and two 44px buttons (a 320px phone): it goes, so nothing overflows. */}
        <span className="hidden shrink-0 text-[10px] text-zinc-600 @min-[19rem]:inline">
          <TimeAgo ts={m.createdAt} />
        </span>
        {m.status === "uncertain" && <button type="button" className={ICON_BUTTON + " ml-auto"} title="Remove hold after reviewing the transcript; this does not undo delivery" aria-label="Remove delivery hold" onClick={() => onDelete(m)}><X className="h-3.5 w-3.5" /></button>}
        {!locked && settled && !editing && (
          <span className="-my-2.5 ml-auto flex shrink-0 sm:-my-0.5">
            {turn === "steerable" && (
              <button type="button" className={STEER_BUTTON} title={STEER_TITLE} aria-label="Steer the queued messages into the running turn" disabled={steering} onClick={onSteer}>
                <Navigation2 className="h-3.5 w-3.5 rotate-90" />
                Steer
              </button>
            )}
            <button type="button" className={ICON_BUTTON} title="Edit" aria-label="Edit queued message" onClick={() => onEdit(m.id)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={ICON_BUTTON} title={CANCEL_TITLE} aria-label="Cancel queued message" onClick={() => onDelete(m)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <QueuedEditor initial={m.text} canBeEmpty={m.attachments.length > 0} locked={locked} onSave={(text) => onSave(m, text)} onCancel={() => onEdit(null)} />
      ) : (
        m.text && <div className="mt-0.5 line-clamp-6 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-300">{m.text}</div>
      )}
      <AttachmentList files={m.attachments.length ? m.attachments : undefined} />
      {m.status === "accepted" && <div className="mt-1 text-[11px] text-zinc-500">Codex accepted this input. This does not confirm that the model processed it.</div>}
      {m.status === "uncertain" && <div className="mt-1 text-[11px] text-zinc-500">It may already have reached Codex. Automatic retry is paused. Review the transcript, then remove this hold before resuming.</div>}
      {(steered || !locked) && (
        <div className="mt-1 text-[11px] text-zinc-500">{steered ? "Delivery requested; waiting for the runner to acknowledge it." : WAITS[turn](noSteer ?? "this agent")}</div>
      )}
    </div>
  )
})

/**
 * Edit a queued message in place. `locked`: a turn is taking it right now, so the edit can't be saved any more.
 * `canBeEmpty`: it has attachments, so the text may go.
 */
function QueuedEditor({
  initial,
  canBeEmpty = false,
  locked = false,
  onSave,
  onCancel,
  className = "mt-1",
}: {
  initial: string
  canBeEmpty?: boolean
  locked?: boolean
  onSave: (text: string) => void
  onCancel: () => void
  className?: string
}) {
  const [text, setText] = useState(initial)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  const empty = !text.trim() && !canBeEmpty
  const canSave = !empty && !locked
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
      e.preventDefault()
      onSave(text)
    }
  }
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) onSave(text)
      }}
    >
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        readOnly={locked}
        rows={2}
        aria-label="Queued message"
        className="block w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-base text-zinc-100 focus:border-yard-500 focus:outline-none sm:text-sm"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {locked && (
          <span role="status" className="mr-auto text-xs text-amber-300/90">
            Being delivered: it can't be changed now.
          </span>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  )
}

/** A cancelled row's Undo line: its text went back in the message box (Undo takes it out again). */
function DeletedRow({ m, onUndo, onExpire }: { m: QueuedMessage; onUndo: (m: QueuedMessage) => void; onExpire: (id: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onExpire(m.id), UNDO_MS)
    return () => clearTimeout(t)
  }, [m.id, onExpire])
  return (
    <div role="listitem" data-testid="queued-deleted" className="flex min-h-6 items-center gap-1.5 rounded-lg px-3 text-[11px] text-zinc-500">
      <LineIcon icon={X} className="h-3 w-3" />
      <span className="min-w-0 truncate">Cancelled · back in the message box</span>
      <button type="button" onClick={() => onUndo(m)} className="-my-2.5 ml-auto min-h-11 shrink-0 rounded-md px-2 font-semibold text-yard-400 hover:bg-zinc-800 sm:my-0 sm:min-h-6">
        Undo
      </button>
    </div>
  )
}

/**
 * "N queued" on task cards and the task header: opens the task's Queued rows. A button, not a link, because it
 * sits inside the card's link; it doesn't open the card's own target.
 */
export function QueuedLink({ taskId, count, className }: { taskId: string; count: number; className?: string }) {
  return (
    <button
      type="button"
      title={`${count} message${count === 1 ? "" : "s"} wait for the next turn. Open the queue to edit or cancel them.`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        revealTaskQueue(taskId, navigate)
      }}
      className={cx("rounded hover:text-zinc-200 hover:underline focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none", className)}
    >
      {count} queued
    </button>
  )
}

/** Under a message sent mid-turn: it reaches `who` when the current turn ends. */
export function QueuedLabel({ who, className }: { who: string; className?: string }) {
  return (
    <div data-testid="queued-label" title={`Sent while ${who} was busy. It goes in with the next turn.`} className={cx("flex items-center gap-1 text-[11px] text-zinc-500", className)}>
      <Clock className="h-3 w-3" /> Queued · delivered when this turn ends
    </div>
  )
}

/**
 * A Coordinator or Captain message queued mid-turn (`projectId` null: the Coordinator chat): its bubble
 * (`children`), then the Queued label with Edit and Cancel. Edit swaps the bubble for an editor in place; Cancel
 * puts it back in the chat's message box. The parent lays them out (a flex column, aligned like the bubble).
 */
export function QueuedChatMessage({ m, projectId, who, children }: { m: ChatMessage | CaptainMessage; projectId: string | null; who: string; children: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const { edit, remove } = useQueuedChatActions(projectId)
  const qc = useQueryClient()
  // The turn took it while it was being edited: this line moves into the thread (unmounting here), so say so.
  const editingNow = useRef(false)
  editingNow.current = editing
  useEffect(
    () => () => {
      if (!editingNow.current) return
      const now = qc.getQueryData<(ChatMessage | CaptainMessage)[]>(projectId ? keys.captainMessages(projectId) : keys.chat)?.find((x) => x.id === m.id)
      if (now && !isQueued(now) && now.meta?.cancelled !== true) toast.error("Already delivered", `${who[0]!.toUpperCase()}${who.slice(1)} got the message as it was, so your edit wasn't saved.`)
    },
    [qc, projectId, m.id, who],
  )
  const settled = !m.meta?.pending
  const files = m.meta?.attachments as Attachment[] | undefined
  return (
    <>
      {editing ? (
        <QueuedEditor
          initial={m.content}
          canBeEmpty={Boolean(files?.length)}
          className="w-full max-w-[85%]"
          onCancel={() => setEditing(false)}
          onSave={(text) => {
            setEditing(false)
            if (text.trim() !== m.content) edit.mutate({ id: m.id, text })
          }}
        />
      ) : (
        children
      )}
      <div className="flex min-h-6 items-center gap-1">
        <QueuedLabel who={who} />
        {settled && !editing && (
          <span className="-my-2.5 -mr-3.5 flex shrink-0 sm:-my-0.5 sm:-mr-1">
            <button type="button" className={ICON_BUTTON} title="Edit" aria-label="Edit queued message" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              title={CANCEL_TITLE}
              aria-label="Cancel queued message"
              onClick={(e) => {
                const untake = takeBack(projectId ? `captain:${projectId}` : "coordinator", m.content, files ?? [], e.currentTarget)
                remove.mutate({ id: m.id, untake })
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
    </>
  )
}
