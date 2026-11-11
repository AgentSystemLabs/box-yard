// The same responsive/resizable slot as questions, with the URL's panels beside the chat (lib/panelStack.ts): tasks,
// Captains and schedules alike, left to right. Beside the chat each panel keeps its own width (lib/panelWidths.ts) and
// every border drags: the chat's, and each open panel's left edge. Panels that don't fit scroll sideways. As a sheet
// over the chat (a phone, a narrow window) only the last shows, and its Back closes it.
// On a desktop what shows is the item opened and the pins (lib/columns.ts): each column (the chat, each panel) can
// be pinned from its header, and closed there while another column is in view (ColumnControls.tsx). With the chat hidden the panels cover it, and the
// rightmost fills the room it left, its content centred. With the sidebar folded the levels above the item opened
// that aren't showing are strips (Rails.tsx), each just left of the first of its descendants.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { Overlay } from "../lib/overlays"
import { PanelStackContext, viewOf, type PanelPlace } from "../lib/panelStack"
import { closePanel, isPinned, useColumnLayout, type Fold } from "../lib/columns"
import { ResizeHandle, useElementWidth, useResizable } from "../lib/resize"
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, STRIP_WIDTH, THREAD_CHAT_ROOM, moveChatEdge, panelLimit, panelWidthCss } from "../lib/layout"
import { panelWidth, setChatEdge, setPanelWidth, useChatRoom, usePanelWidth, usePanelWidths } from "../lib/panelWidths"
import { useProjects, useSchedules, useTasks, QUIET } from "../lib/queries"
import { Modal } from "./Modal"
import { LevelStrip, SubtaskBar } from "./Rails"
import { PanelControls } from "./ColumnControls"
import { TaskSession } from "./TaskSession"
import { CaptainTab } from "./CaptainTab"
import { lazyPart } from "./LazyPart"
import { Button, cx } from "./ui"
import { Loading } from "./Loading"

// Schedules are a chunk of their own, out of the first load.
const SchedulesView = lazyPart(() => import("./Schedules").then((m) => m.SchedulesView), { Loading: () => <Loading label="Loading schedules" /> })
const ScheduleCard = lazyPart(() => import("./Schedules").then((m) => m.ScheduleCard), { Loading: () => <Loading label="Loading the schedule" /> })

// The chat's on screen: the centre keeps the chats left last hidden beside it, composers and all (lib/keptChats.ts).
const sourceComposer = () => [...document.querySelectorAll<HTMLTextAreaElement>('[data-testid="chat-footer"] textarea')].find((t) => t.checkVisibility?.() ?? true) ?? null

/**
 * Where the chat's section (`coord`) is under 35.5rem the panels are a sheet over it, and this hides all but the
 * newest. Whole class names only, here and below: Tailwind finds the classes to build by reading them in the source.
 */
export const SHEET_HIDDEN = "@max-[35.5rem]/coord:hidden"
/** Beside the chat a panel is a column (ColumnControls.tsx), so its Back is for the sheet. */
const BACK_ON_SHEET = "@min-[35.5rem]/coord:hidden"

interface Panel {
  ref: string
  label: string
  title?: React.ReactNode
  body?: string
  content: React.ReactNode
}
const FILL = "flex min-h-0 flex-1 flex-col overflow-hidden"
/** Non-task panels filling the room keep their content to a comfortable reading width, centred. */
export const FOCUS_MAX = "max-w-[56rem]"

/**
 * The panels open, left to right (`view` is the first, the URL's own). `rails`: the sidebar is folded (its icon rail,
 * or none), so a task filling the room lists its sub-tasks beside it.
 */
export function OverlayHost({ view, rails = false }: { view: Overlay; rails?: boolean }) {
  const projects = useProjects()
  const schedules = useSchedules()
  const tasks = useTasks(QUIET)
  const layout = useColumnLayout()
  const refs = layout.refs.length ? layout.refs : [view.kind === "session" ? view.id : `${view.kind}.${view.id}`]
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const titleOf = (tid: string) => tasks.data?.find((t) => t.id === tid)?.title
  const panelFor = (ref: string, i: number): Panel => {
    const { kind, id } = viewOf(ref)
    const behind = i > 0 ? labelOf(refs[i - 1]!) : undefined
    const close = () => closePanel(i)
    if (kind === "session") {
      return { ref, label: titleOf(id) ?? "Task conversation", body: FILL, content: <TaskSession key={ref} id={id} onClose={close} backLabel={behind ? `Back to ${behind}` : undefined} scrollKey={`panel:session:${id}`} /> }
    }
    const project = kind === "captain" ? projects.data?.find((p) => p.id === id) : undefined
    const schedule = kind === "schedule" ? schedules.data?.find((s) => s.id === id) : undefined
    const label = labelOf(ref)
    const key = `${kind}:${id}`
    return {
      ref,
      label,
      // A Captain's chat draws the panel's header itself, as a task does (CaptainTab.tsx PanelCaptainHeader).
      title: kind === "captain" && project ? undefined : label,
      body: kind === "schedule" ? undefined : FILL,
      content:
        kind === "captain" ? project ? <CaptainTab key={key} project={project} scrollKey={`panel:${key}`} onClose={close} backLabel={behind ? `Back to ${behind}` : undefined} /> : <div className="p-4">
            {projects.isLoading ? <Loading kind="chat" label="Loading the project" /> : projects.isError ? <div role="alert">Couldn't load this project. <Button onClick={() => void projects.refetch()}>Retry</Button></div> : <p>Project not found.</p>}
          </div>
          : id === "all" ? <SchedulesView /> : schedule ? <ScheduleCard key={key} schedule={schedule} expanded />
            : schedules.isLoading ? <Loading label="Loading the schedule" /> : schedules.isError ? <div role="alert">Couldn't load this schedule. <Button onClick={() => void schedules.refetch()}>Retry</Button></div> : <p>Schedule not found. It may have been deleted.</p>,
    }
  }
  /** A panel's name: its task's title, "<project> Captain", or its schedule's. */
  function labelOf(ref: string): string {
    const { kind, id } = viewOf(ref)
    if (kind === "session") return titleOf(id) ?? "Task conversation"
    if (kind === "captain") {
      const name = projects.data?.find((p) => p.id === id)?.name
      return name ? `${name} Captain` : "Project Captain"
    }
    return id === "all" ? "Schedules" : schedules.data?.find((s) => s.id === id)?.name ?? "Schedule"
  }
  const panels = refs.map(panelFor)
  // A panel that opens scrolls into view: the one added, wherever the pins put it.
  const shown = useRef<string[]>([])
  const joined = refs.join()
  useLayoutEffect(() => {
    const added = refs.find((r) => !shown.current.includes(r))
    shown.current = refs
    if (!row || !added) return
    if (added === refs.at(-1)) row.scrollLeft = row.scrollWidth
    else row.querySelector(`[data-panel="${CSS.escape(added)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, joined])
  // Which panel a control sits in: the same object while its place and ref stay, so its consumers don't re-render.
  const places = useMemo(() => joined.split(",").map((ref, index): PanelPlace => ({ index, ref })), [joined])
  // A sheet shows one panel and its Back closes it; beside the chat, Esc leaves a pinned panel where it is.
  const sheet = () => !row || getComputedStyle(row).overflowX === "hidden"
  return (
    <div className="relative h-full min-h-0 w-full">
      {/* First, so Tab reaches the edges left to right. Only between the chat and the panels. */}
      {layout.chat === "open" && <ChatEdge strip={row} folds={layout.panels} strips={layout.strips.length} label={panels[0]!.label} />}
      <div
        ref={setRow}
        data-testid="columns"
        data-panels={panels.length}
        data-chat={layout.chat}
        className="scroll-thin flex h-full min-h-0 w-full overflow-x-auto overflow-y-hidden @max-[35.5rem]/coord:overflow-x-hidden"
      >
        {panels.map((p, i) => {
          const fold = layout.panels[i] ?? "open"
          const view = viewOf(p.ref)
          return [
            ...layout.strips.filter((s) => s.before === i).map((s) => <LevelStrip key={`strip:${s.ref}`} level={s.ref} below={s.below} />),
            // Keyed by place, so a panel that switches view keeps its dialog (and focus) and its width; what's in it remounts.
            <StackColumn
              key={i}
              index={i}
              panel={p.ref}
              label={p.label}
              last={i === panels.length - 1}
              fold={fold}
              // With the chat hidden, the first panel's left is the sidebar's border (or the window's edge), not its own.
              edge={i > 0 || layout.chat === "open" || layout.strips.some((s) => s.before === 0)}
              // The panel filling the room has its sub-tasks in a bar on its left, with the sidebar folded.
              rail={fold === "fill" && rails && view.kind === "session" ? <SubtaskBar taskId={view.id} /> : null}
            >
              <PanelStackContext.Provider value={places[i] ?? null}>
                <Modal
                  label={p.label}
                  title={p.title}
                  placement="panel"
                  swipeBack
                  focusKey={p.ref}
                  returnFocus={sourceComposer}
                  onClose={() => (isPinned(p.ref) && !sheet() ? undefined : closePanel(i))}
                  headerEnd={p.title ? <PanelControls name={p.label} className="-my-1.5 -mr-2" /> : undefined}
                  backClassName={BACK_ON_SHEET}
                  className="@container"
                  bodyClassName={p.body}
                >
                  {p.content}
                </Modal>
              </PanelStackContext.Provider>
            </StackColumn>,
          ]
        })}
      </div>
    </div>
  )
}

/**
 * The border between the chat and the panels, at the strip's left edge whatever is scrolled into view: the first
 * panel's left edge, which sets its width (layout.ts' moveChatEdge: the chat's room moves with it while panels are
 * scrolled out of view). A move keeps the first panel's left edge at the border if it's there, and otherwise the
 * newest panel's right edge where it is: what goes out of view is on the left.
 */
function ChatEdge({ strip, folds, strips, label }: { strip: HTMLDivElement | null; folds: readonly Fold[]; strips: number; label: string }) {
  // The strips' room is theirs: the open panels and the chat share the rest.
  const whole = useElementWidth(strip?.closest("aside")?.parentElement)
  const section = whole && whole - strips * STRIP_WIDTH
  const all = usePanelWidths(folds.length)
  const widths = useMemo(() => all.filter((_, i) => folds[i] === "open"), [all, folds])
  const room = useChatRoom()
  // Where the strip was before a change, to put it back after (in the layout effect below).
  const anchor = useRef<{ start: boolean; right: number } | null>(null)
  const newest = () => strip?.lastElementChild ?? null
  const move = (first: number, chat: number) => {
    if (first === panelWidth(0) && chat === room) return
    const end = newest()
    if (strip && end && anchor.current === null) anchor.current = { start: strip.scrollLeft === 0, right: end.getBoundingClientRect().right }
    setChatEdge(first, chat)
  }
  const size = useResizable({
    defaultWidth: PANEL_DEFAULT,
    min: PANEL_MIN,
    max: PANEL_MAX,
    limit: section ? panelLimit(section) : undefined,
    edge: "left",
    value: widths[0] ?? PANEL_DEFAULT,
    onChange: (w) => {
      if (!section) return
      const next = moveChatEdge(widths, room, section, w)
      move(next.first, next.chatRoom)
    },
    // Back to the first panel's default width and the chat's least room.
    onReset: () => move(PANEL_DEFAULT, THREAD_CHAT_ROOM),
    enabled: Boolean(section),
  })
  useLayoutEffect(() => {
    const before = anchor.current
    anchor.current = null
    const end = newest()
    if (before === null || !end || !strip) return
    if (before.start) strip.scrollLeft = 0
    else strip.scrollLeft += end.getBoundingClientRect().right - before.right
  }, [strip, widths, room])
  return <ResizeHandle {...size.handle} label={`Width of ${label}`} belowHeader className="@min-[35.5rem]/coord:block" />
}

const viewKey = (ref: string) => {
  const v = viewOf(ref)
  return `${v.kind}:${v.id}`
}

/**
 * One panel's column at its own width, with its left edge to drag (the first panel's is the chat's border: ChatEdge).
 * Holds the drag, so a move re-renders this and the strip's width (SideThreadPane), not the panels' views
 * (`children`). A drag keeps the panel's right edge where it is, so the edge follows the pointer even while the strip
 * scrolls: the panels to the left move aside.
 * `fold` "fill" takes the room the chat left, from its own width up, its content centred, with `rail` (its sub-tasks'
 * bar) on its left.
 * `edge`: a border on its left, unless it's first with the chat hidden (the sidebar's border is there).
 */
function StackColumn({ index, panel, label, last, fold, edge, rail, children }: { index: number; panel: string; label: string; last: boolean; fold: Fold; edge: boolean; rail?: ReactNode; children: ReactNode }) {
  const [column, setColumn] = useState<HTMLDivElement | null>(null)
  // The chat's section: the room beside the chat caps a drag.
  const section = useElementWidth(column?.closest("aside")?.parentElement)
  const width = usePanelWidth(index)
  // The panel's right edge on screen before a change, to put it back after (in the layout effect below).
  const anchor = useRef<number | null>(null)
  const onChange = useCallback(
    (w: number) => {
      if (w === panelWidth(index)) return
      if (column && anchor.current === null) anchor.current = column.getBoundingClientRect().right
      setPanelWidth(index, w)
    },
    [column, index],
  )
  const size = useResizable({ defaultWidth: PANEL_DEFAULT, min: PANEL_MIN, max: PANEL_MAX, limit: section ? panelLimit(section) : undefined, edge: "left", value: width, onChange })
  useLayoutEffect(() => {
    const before = anchor.current
    anchor.current = null
    const strip = column?.parentElement
    if (before === null || !column || !strip) return
    strip.scrollLeft += column.getBoundingClientRect().right - before
  }, [column, width])
  return (
    <div
      ref={setColumn}
      data-testid="column"
      data-index={index}
      data-panel={panel}
      data-view={viewKey(panel)}
      data-fold={fold === "open" ? undefined : fold}
      style={{ "--panel-w": panelWidthCss(width) } as CSSProperties}
      className={cx(
        // Beside the chat: its own width, a border on its left (the chat's, or the panel's before it). Filling: from
        // its width up, as wide as the room left.
        "relative flex min-h-0",
        rail ? "flex-row" : "flex-col",
        fold === "fill" ? "min-w-(--panel-w) flex-1" : "w-(--panel-w) flex-none",
        // First with the chat hidden, the sidebar's border is its own: the room it fills lines up with the chat's.
        edge && "border-l border-zinc-800",
        // A sheet: the newest fills it, the rest wait behind it.
        "@max-[35.5rem]/coord:w-full @max-[35.5rem]/coord:min-w-0 @max-[35.5rem]/coord:border-l-0",
        !last && SHEET_HIDDEN,
      )}
    >
      {rail}
      {/* TaskSession centres its text with chat-column, like the Coordinator and Captain. Keep its frame full
          width so the date rail, summary and scroll area share the conversation panel's edge. */}
      <div className={cx("flex min-h-0 w-full flex-1 flex-col", fold === "fill" && viewOf(panel).kind !== "session" && cx("mx-auto", FOCUS_MAX))}>
        {children}
      </div>
      {index > 0 && fold === "open" && <ResizeHandle {...size.handle} label={`Width of ${label}`} belowHeader className="@min-[35.5rem]/coord:block" />}
    </div>
  )
}
