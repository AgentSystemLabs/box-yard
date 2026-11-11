// The Coordinator chat's updates as one-line chips (rows from lib/chatUpdates.ts): "box-yard Captain replied · …",
// "✓ Fix login done · …". A click opens the whole notice in place, under the chip; in the plain transcript
// (CoordinatorTranscript) back-to-back updates fold into one "N updates" line. Open state is per session
// (lib/chipState.ts) and per chip, so a toggle re-renders only that chip.
import { Fragment, memo, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { ChevronRight, type LucideIcon } from "lucide-react"
import { AppLink, InRepo, LinkedText, Markdown, cx } from "./ui"
import { ChatLine, FullReplyLink, NoticeProject } from "./ChatLine"
import { PublishedCard } from "./PublishedNotices"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { ThreadMarkers } from "./SideThread"
import { NOTICE_ICON } from "./noticeIcons"
import { TaskTile } from "./TaskIcon"
import { captainIconFor } from "./CaptainIcon"
import { useTaskTile } from "../lib/taskTiles"
import { chipView, coordinatorRows, itemMessages, itemTask, plainRows, rowFirstMessage, stableRows, type CoordinatorRow, type UpdateItem } from "../lib/chatUpdates"
import { DayBoundary } from "./ChatHistory"
import { splitNotice } from "../lib/captainTranscript"
import { stripTruncation } from "../lib/truncated"
import { publishedLabel } from "../lib/publishedNotices"
import { setOpen, useChipOpen, useOpenAmong } from "../lib/chipState"
import { NewestAsks, useNewestAsks } from "../lib/noticeNow"
import type { ChatMessage } from "../../../shared/types"

/** The project a Captain's report is from (its notice's meta), whose Captain's icon its chip shows. */
const metaProject = (m: ChatMessage) => (typeof m.meta?.projectId === "string" ? m.meta.projectId : null)

/** The chip's line: taller under a finger, so a phone can hit it. */
const CHIP_ROW =
  "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11"
/** What an open chip shows, under its line. */
const CHIP_BODY = "mt-0.5 mb-1 ml-2.5 border-l border-zinc-800 pl-3"
const SOURCE_LINK = "min-w-0 max-w-[55%] shrink truncate font-medium text-yard-400 hover:underline"
/**
 * A task's chip in a narrow chat (ChatHistory's container): two lines. The task's name takes the first, beside its tile
 * and the chevron, and what happened goes on the second, so a phone shows more of the name than its first word.
 */
const NARROW_ROW = "@max-[30rem]/history:flex-wrap @max-[30rem]/history:gap-y-0.5"
/** The name on its line: all of it but the tile's and the chevron's room. */
const NARROW_NAME = "@max-[30rem]/history:max-w-[calc(100%-3.5rem)]"
/** What happened, and the preview: in the row as before (`contents`), or the second line, under the name. */
const NARROW_EVENT =
  "contents @max-[30rem]/history:order-3 @max-[30rem]/history:flex @max-[30rem]/history:min-w-0 @max-[30rem]/history:basis-full @max-[30rem]/history:items-center @max-[30rem]/history:gap-1.5"

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className={cx("ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform", open && "rotate-90")} aria-hidden />
}

/** A role=button line (not a <button>: the source inside is a link). Its links keep their clicks. */
function ChipLine({ open, onToggle, title, className, children }: { open: boolean; onToggle: () => void; title?: string; className?: string; children: ReactNode }) {
  const toggle = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("a")) return
    if ("key" in e && e.key !== "Enter" && e.key !== " ") return
    e.preventDefault()
    onToggle()
  }
  return (
    <div role="button" tabIndex={0} aria-expanded={open} data-testid="update-chip-line" title={open ? undefined : title} onClick={toggle} onKeyDown={toggle} className={cx(CHIP_ROW, className)}>
      {children}
      <Chevron open={open} />
    </div>
  )
}

/** One update: its chip, and once opened its whole text (or a files card) under it. */
export const UpdateChip = memo(
  function UpdateChip({ item }: { item: UpdateItem }) {
    return item.type === "files" ? <FilesChip item={item} /> : <NoticeChip m={item.message} />
  },
  // Rows are rebuilt as messages arrive; an update with the very same messages is the same chip.
  (a, b) => a.item === b.item || (a.item.id === b.item.id && sameMessages(itemMessages(a.item), itemMessages(b.item))),
)

const sameMessages = (a: ChatMessage[], b: ChatMessage[]) => a.length === b.length && a.every((m, i) => m === b[i])

/** What happened, after the task's tile and name: the notice's icon, then "done", "opened a PR"… */
function Verb({ icon: Icon, className, label, verb }: { icon: LucideIcon | null; className?: string; label?: string; verb: string }) {
  if (!Icon && !verb) return null
  return (
    <span className="flex max-w-[45%] min-w-0 shrink-[0.5] items-center gap-1 text-zinc-400">
      {Icon && <Icon className={cx("h-3 w-3 shrink-0", className)} aria-label={label} />}
      {verb && <span className="min-w-0 truncate">{verb}</span>}
    </span>
  )
}

const NoticeChip = memo(function NoticeChip({ m }: { m: ChatMessage }) {
  const [open, toggle] = useChipOpen(m.id)
  const v = chipView(m)
  const showBody = v.captain || open
  const { icon, className, label } = v.captain ? { icon: captainIconFor(metaProject(m)), className: "text-sky-400", label: "Captain" } : NOTICE_ICON[v.kind]
  const Icon = icon
  // A task's update leads with its tile, and its kind's icon moves to the verb.
  const taskId = v.captain ? null : typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const tile = useTaskTile(taskId)
  const source = v.source
  // A Captain's chip has nothing after "replied" (its reply is under it), so it stays one line.
  const narrow = !v.captain && Boolean(source)
  const preview = Boolean(v.preview) && !showBody
  const line = (
    <>
      {tile ? <TaskTile id={taskId} /> : <Icon className={cx("h-3.5 w-3.5 shrink-0", className)} aria-label={label} />}
      {source && (source.href ? (
        <AppLink href={source.href} className={cx(SOURCE_LINK, narrow && NARROW_NAME)}>{source.label}</AppLink>
      ) : (
        <span className={cx("min-w-0 max-w-[55%] shrink truncate font-medium text-zinc-300", narrow && NARROW_NAME)}>{source.label}</span>
      ))}
      {(v.verb || preview || (tile && v.kind !== "info")) && (
        <span className={narrow ? cx(NARROW_EVENT, tile ? "@max-[30rem]/history:pl-[26px]" : "@max-[30rem]/history:pl-5") : "contents"}>
          {/* A plain notice's ⓘ says nothing its verb doesn't, so only the kinds with a meaning keep their icon. */}
          {tile ? <Verb icon={v.kind === "info" ? null : Icon} className={className} label={label} verb={v.verb} /> : v.verb && <span className="max-w-[45%] min-w-0 shrink-[0.5] truncate text-zinc-400">{v.verb}</span>}
          {preview && (
            <span data-testid="update-chip-preview" className={cx("min-w-0 flex-1 truncate", source ? "text-zinc-500" : "text-zinc-400")}>
              {source || v.verb ? "· " : ""}
              <InRepo taskId={typeof m.meta?.taskId === "string" ? m.meta.taskId : null} projectId={typeof m.meta?.projectId === "string" ? m.meta.projectId : null}>
                <LinkedText text={v.preview} />
              </InRepo>
            </span>
          )}
        </span>
      )}
    </>
  )
  return (
    <div id={`chat-${m.id}`} data-chat-id={m.id} data-testid="update-chip" data-open={showBody || undefined} className={MESSAGE_BLOCK}>
      {v.captain ? (
        <div className={cx(CHIP_ROW, "cursor-default hover:bg-transparent")}>{line}</div>
      ) : (
        <ChipLine open={open} onToggle={toggle} className={narrow ? NARROW_ROW : undefined} title={[v.source?.label, v.verb, v.preview].filter(Boolean).join(" ")}>{line}</ChipLine>
      )}
      {showBody && <NoticeBody m={m} />}
      <MessageActions text={m.content} anchorId={m.id} />
      <ThreadMarkers m={m} />
    </div>
  )
})

/** An open chip's text: a Captain's reply as prose; a task notice with its project and Captain links first. */
function NoticeBody({ m }: { m: ChatMessage }) {
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const projectId = typeof m.meta?.projectId === "string" ? m.meta.projectId : null
  const n = useMemo(() => splitNotice(m.content, m.meta), [m.content, m.meta])
  if (m.meta?.captain === true) {
    // The chip already says "box-yard Captain replied".
    const text = stripTruncation(m.content).text.replace(/^Captain(?: for .+?)?(?: replied)?:\s*/, "")
    return (
      <div data-testid="update-chip-body" className={cx(CHIP_BODY, "text-sm text-zinc-300")}>
        <InRepo projectId={projectId}>
          <Markdown>{text}</Markdown>
        </InRepo>
      </div>
    )
  }
  return (
    <div data-testid="update-chip-body" className={cx(CHIP_BODY, "text-xs leading-relaxed wrap-anywhere text-zinc-400")}>
      {taskId && <NoticeProject taskId={taskId} projectId={projectId} />}
      <div className="inline [&>.prose-chat]:inline [&>.prose-chat>p:first-child]:inline">
        <InRepo taskId={taskId} projectId={projectId}>
          <Markdown>{n.event}</Markdown>
        </InRepo>
      </div>
      {n.truncated && taskId && <FullReplyLink taskId={taskId} />}
    </div>
  )
}

const FilesChip = memo(function FilesChip({ item }: { item: Extract<UpdateItem, { type: "files" }> }) {
  const [open, toggle] = useChipOpen(item.id)
  const g = item.group
  const { icon: Icon, className, label } = NOTICE_ICON.artifact
  const tile = useTaskTile(g.taskId)
  return (
    <div id={`chat-${item.id}`} data-testid="update-chip" data-open={open || undefined}>
      <ChipLine open={open} onToggle={toggle} className={NARROW_ROW} title={`${g.taskTitle} ${publishedLabel(g.files.length)}`}>
        {tile ? <TaskTile id={g.taskId} /> : <Icon className={cx("h-3.5 w-3.5 shrink-0", className)} aria-label={label} />}
        {g.taskId ? (
          <AppLink href={`/tasks/${g.taskId}`} className={cx(SOURCE_LINK, NARROW_NAME)}>
            {g.taskTitle}
          </AppLink>
        ) : (
          <span className={cx("min-w-0 max-w-[55%] shrink truncate font-medium text-zinc-300", NARROW_NAME)}>{g.taskTitle}</span>
        )}
        <span className={cx(NARROW_EVENT, tile ? "@max-[30rem]/history:pl-[26px]" : "@max-[30rem]/history:pl-5")}>
          <span className="flex shrink-0 items-center gap-1 text-zinc-400">
            {tile && <Icon className={cx("h-3 w-3 shrink-0", className)} aria-label={label} />}
            {publishedLabel(g.files.length)}
          </span>
          <span className="min-w-0 flex-1 truncate text-zinc-500">· {g.files.map((f) => f.title).join(", ")}</span>
        </span>
      </ChipLine>
      {open && (
        <div className={CHIP_BODY}>
          <PublishedCard group={g} />
        </div>
      )}
    </div>
  )
})

/** coordinatorRows, with every row that didn't change kept as the same object, so its memo'd component skips. */
export function useCoordinatorRows(messages: ChatMessage[]): CoordinatorRow[] {
  const prev = useRef<CoordinatorRow[]>([])
  return useMemo(() => (prev.current = stableRows(prev.current, coordinatorRows(messages))), [messages])
}

/** plainRows over the chat's rows, kept stable the same way, for the plain transcript. */
export function usePlainRows(rows: CoordinatorRow[]): CoordinatorRow[] {
  const prev = useRef<CoordinatorRow[]>([])
  return useMemo(() => (prev.current = stableRows(prev.current, plainRows(rows))), [rows])
}

const groupKey = (id: string) => `group:${id}`

/**
 * Back-to-back updates as one quiet line: their tiles, "3 updates" and whom they're from. Open, each is a chip. It's
 * open too while one of its chips is (a reply's "from:" line opens them), so what that line points at is in view.
 */
export const UpdateGroup = memo(function UpdateGroup({ id, items }: { id: string; items: UpdateItem[] }) {
  const ids = useMemo(() => items.map((i) => i.id), [items])
  const [self] = useChipOpen(groupKey(id))
  const inside = useOpenAmong(ids) !== ""
  const open = self || inside
  const toggle = () => setOpen(open ? [groupKey(id), ...ids] : [groupKey(id)], !open)
  // Each task's tile once; a Captain's report or a notice about no task, its kind's icon.
  const { marks, names } = useMemo(() => {
    const marks = new Map<string, { taskId: string } | { icon: LucideIcon; className: string }>()
    const names = new Set<string>()
    for (const item of items) {
      const taskId = itemTask(item)
      const v = item.type === "notice" ? chipView(item.message) : null
      names.add(item.type === "files" ? item.group.taskTitle : (v!.source?.label ?? NOTICE_ICON[v!.kind].label))
      if (taskId) {
        if (!marks.has(taskId)) marks.set(taskId, { taskId })
        continue
      }
      // One mark per Captain, as each draws its own icon.
      const captain = v?.captain && item.type === "notice" ? metaProject(item.message) : undefined
      const key = v?.captain ? `captain:${captain ?? ""}` : (v?.kind ?? "artifact")
      if (!marks.has(key)) marks.set(key, v?.captain ? { icon: captainIconFor(captain), className: "text-sky-400" } : NOTICE_ICON[v?.kind ?? "artifact"])
    }
    return { marks: [...marks].slice(0, 4), names: [...names].join(", ") }
  }, [items])
  return (
    <div id={`chat-${id}`} data-testid="update-group" data-count={items.length} data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={toggle} title={open ? undefined : names} className={cx(CHIP_ROW, "w-full")}>
        <span className="flex shrink-0 gap-0.5">
          {marks.map(([key, k]) => ("taskId" in k ? <TaskTile key={key} id={k.taskId} /> : <k.icon key={key} className={cx("h-3.5 w-3.5", k.className)} aria-hidden />))}
        </span>
        <span className="shrink-0 font-medium text-zinc-300">{items.length} updates</span>
        <span data-testid="update-group-names" className="min-w-0 flex-1 truncate text-zinc-500">· {names}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div data-testid="update-group-items" className={cx(CHIP_BODY, "space-y-0.5 pl-1")}>
          {items.map((item) => (
            <UpdateChip key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
})

/**
 * The Coordinator chat as a plain transcript (rows from usePlainRows): Cody's messages and the Coordinator's replies,
 * questions, PRs and failures as cards, every other update a chip, and a run of them one "N updates" line. Task and
 * Captain names in them open their panels. Only the newest reply offers its next steps: older ones were for a moment
 * that has passed. Likewise only a task's newest question, PR or failure asks for anything (lib/noticeNow.ts); `rows`
 * are the newest ones (useTail), so each task's newest card is among them.
 */
export const CoordinatorTranscript = memo(function CoordinatorTranscript({ rows, onFollowUp }: { rows: CoordinatorRow[]; onFollowUp: (message: string) => void }) {
  const newest = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.type === "message" && r.message.role === "assistant") return r.id
    }
  }, [rows])
  const asks = useNewestAsks(rows)
  return (
    <NewestAsks.Provider value={asks}>
      {rows.map((r, i) => (
        <Fragment key={r.id}>
          <DayBoundary at={rowFirstMessage(r).createdAt} previousAt={i ? rowFirstMessage(rows[i - 1]!).createdAt : undefined} messageId={r.id} />
          {r.type === "updates" ? (
            <UpdateGroup id={r.id} items={r.items} />
          ) : r.type === "update" ? (
            <UpdateChip item={r.item} />
          ) : (
            <ChatLine m={r.message} sources={r.sources} onFollowUp={onFollowUp} next={r.id === newest} />
          )}
        </Fragment>
      ))}
    </NewestAsks.Provider>
  )
})
