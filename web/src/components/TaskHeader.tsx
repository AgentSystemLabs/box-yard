// Task identity and current state stay visible above the transcript, in one row. Secondary details and actions live in ⓘ.
import { taskSessionHref, projectChatHref } from "../lib/navigation"
import { daytonaSize } from "../../../shared/runnerSizes"
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Link, useLocation } from "wouter"
import {
  ChevronRight,
  Check,
  CheckCircle2,
  Copy,
  GitMerge,
  Globe,
  Info,
  Plug,
  RefreshCcw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react"
import { useAgentSettings, useDeleteTask, useIdentities, useReopenTask, useRetryTask, useSetStayOpenOnMerge, useStopTask } from "../lib/queries"
import { ContinueTask } from "./ContinueTask"
import { api } from "../lib/api"
import { primaryAction, readyForReview } from "../lib/taskActions"
import { toast } from "../lib/toast"
import { Button, HEADER_CHIP, HEADER_FOLD, NewTabLink, PriorityPill, STATUS, StatusDot, TimeAgo, cx, timeAgo } from "./ui"
import { DeleteFailedTaskButton } from "./DeleteFailedTaskButton"
import { TaskStatusIcon } from "./TaskIcon"
import { FilesChip } from "./TaskFiles"
import { MergePrMenuItem } from "./MergePr"
import { PrStatusChip } from "./PrStatus"
import { pushStateLine } from "../lib/pushState"
import type { Artifact, PreviewLink, Project, Schedule, Task } from "../../../shared/types"
import { RUNNER_LABEL } from "../../../shared/runner"
import { gpuPickLabel } from "../../../shared/gpuCatalog"
import { AGENT_CLI_LABEL } from "../../../shared/agentCli"
import { confirmDialog } from "../lib/confirm"
import { useMarkDone } from "../lib/markDone"
import { copyIdOnClick } from "../lib/breadcrumb"
import { QueuedLink } from "./QueuedMessages"
import { PlacementDetails } from "./PlacementChip"
import { IdentityBadge } from "./IdentityBadge"
import { useOpenSettings } from "./SettingsHost"
import { HEAD_CONTAINER } from "../lib/contextVisibility"
import { DismissButton, Modal, modalDepth } from "./Modal"
import { TaskCrumbs } from "./TreeNav"
import { SidebarMenuButton } from "./Sidebar"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"

/**
 * The task's header, in the task panel (`onBack`: an h2 with a back button before it) and the task page (an h1
 * under the breadcrumb). One row, like a phone's navigation bar: back, the task's icon and its title (one line; a tap
 * opens the details), then what to act on (its PR, previews and files, and Mark done once it's ready for review, or
 * Reopen once it's done, or Delete if it failed) and ⓘ (its details) last. The icon is the header's status (TaskStatusIcon): it pulses while
 * the task works and has a still dot when it asks or failed, and its name says the state to screen readers; the details
 * say it in words. A narrow header (a slim panel) folds the chips to their icons. The agent and where it runs are
 * only in the details. Too narrow even for that, the icons wrap under the
 * title. It sticks to the top while the transcript scrolls.
 *
 * In a panel its crumbs' row is the Captain's header's (CaptainTab.tsx CentreCaptainHeader): as tall, the Captain's
 * icon and its project's name where that header has them (TreeNav.tsx), then the task's own crumb; filling the room
 * the chat left (or on a phone), in the same column. Going between a Captain and its task moves none of it.
 *
 * On a phone (under SIDEBAR_INLINE, where the panel covers the chat) it's two rows. The first is the way around: the
 * sidebar's ☰, the levels above as crumbs in Back's place (TreeNav.tsx), Mark done or Reopen, and ⓘ. Under it, the
 * task: its icon and its whole title, wrapping (a tap opens the details), with its chips.
 */
export function TaskHeader({
  task,
  project,
  schedule,
  files,
  onBack,
  backLabel,
  backClassName,
  tools,
  controls,
  tree = false,
}: {
  task: Task
  project: Project | undefined
  schedule: Schedule | null | undefined
  files: Artifact[]
  /** In the popup: a back button at the top left returns to the chat (or out of a level inside the panel). */
  onBack?: () => void
  /** Back's name when it leads somewhere more specific than "Back". */
  backLabel?: string
  /** Where Back hides: beside the chat, where the panel is a column (ColumnControls.tsx) and its crumbs lead up. */
  backClassName?: string
  /** The panel's own buttons, just before ⓘ. */
  tools?: ReactNode
  /** After ⓘ, last: Pin, and Close while another column is in view (ColumnControls.tsx). */
  controls?: ReactNode
  /**
   * The panel shows the task itself (not a level inside it): the levels above it are crumbs (TreeNav.tsx), after Back
   * on a desktop (where Back shows only on a sheet), in its place on a phone.
   */
  tree?: boolean
}) {
  const Heading = onBack ? "h2" : "h1"
  const [details, setDetails] = useState(false)
  const phone = !useMinWidth(SIDEBAR_INLINE)
  const ready = readyForReview(task.status)
  const chips = (
    <div data-testid="task-chips" className="flex items-center gap-0.5 @min-[36rem]/head:gap-1.5">
      <TaskStateMore task={task} />
      {task.prUrl && <PrStatusChip task={task} />}
      {task.previews.map((p) => <PreviewChip key={p.port} preview={p} port={task.previews.length > 1} />)}
      {files.length > 0 && <FilesChip taskId={task.id} projectId={task.projectId} files={files} quiet fold />}
    </div>
  )
  const menu = <TaskMenu task={task} project={project} schedule={schedule} open={details} setOpen={setDetails} />
  if (phone && onBack)
    return (
      <header data-testid="task-header" className={cx(HEAD_CONTAINER, "sticky top-0 z-20 shrink-0 border-b border-zinc-800/70 bg-zinc-950/95 backdrop-blur")}>
        <div data-testid="task-nav" className={cx(CHAT_COLUMN, CRUMB_ROW)}>
          <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            <SidebarMenuButton />
            {tree ? <TaskCrumbs task={task} project={project} /> : <DismissButton kind="back" label={backLabel} onClick={onBack} className={cx("relative z-10 -ml-1", backClassName)} />}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {ready ? <MarkDoneButton task={task} crowded={false} /> : task.status === "done" && <ReopenButton task={task} crowded={false} />}
              {task.status === "failed" && <DeleteFailedTaskButton task={task} header />}
              {tools}
              {menu}
              {controls}
            </div>
          </div>
        </div>
        <div data-testid="task-meta" className={cx(CHAT_COLUMN, "flex min-w-0 flex-wrap items-start gap-x-0.5 pb-0.5 text-xs text-zinc-500")}>
          <Heading className={cx("flex min-w-[min(100%,9rem)] flex-1 basis-0", task.status === "idle" ? "text-zinc-400" : "text-zinc-50")}>
            <TitleButton task={task} open={details} onOpen={() => setDetails(true)} wrap />
          </Heading>
          <div className="ml-auto flex h-11 shrink-0 items-center">{chips}</div>
        </div>
      </header>
    )
  const crumbs = Boolean(onBack && tree)
  const meta = (
    <div data-testid="task-meta" className="flex min-w-0 flex-wrap items-center gap-x-0.5 text-xs text-zinc-500 @min-[36rem]/head:gap-x-1.5">
      {/* Back and the title keep 9rem (about 12 characters of title) beside the icons; any less and the icons wrap to a second row. */}
      <div className="flex min-w-[min(100%,9rem)] flex-1 basis-0 items-center">
        {onBack && <DismissButton kind="back" label={backLabel} onClick={onBack} className={cx("relative z-10 -ml-2 pointer-coarse:-ml-3", backClassName)} />}
        {/* The Captain's crumb reaches into the gap before it, where Back shows (a sheet over the chat) its own. */}
        {crumbs && <TaskCrumbs task={task} project={project} className={backClassName ? "@max-[35.5rem]/coord:ml-2" : "ml-2"} />}
        <Heading className={cx("flex min-w-0 flex-1", task.status === "idle" ? "text-zinc-400" : "text-zinc-50")}>
          <TitleButton task={task} open={details} onOpen={() => setDetails(true)} />
        </Heading>
      </div>
      {/* Chips and ⓘ wrap together, so ⓘ stays last. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 @min-[36rem]/head:gap-1.5">
        {chips}
        {ready && <MarkDoneButton task={task} crowded={Boolean(task.prUrl) || task.previews.length > 0 || files.length > 0} />}
        {task.status === "done" && <ReopenButton task={task} crowded={Boolean(task.prUrl) || task.previews.length > 0 || files.length > 0} />}
        {task.status === "failed" && <DeleteFailedTaskButton task={task} header />}
        {tools}
        {menu}
        {controls}
      </div>
    </div>
  )
  if (!onBack)
    return (
      <header data-testid="task-header" className={cx(HEAD_CONTAINER, "sticky top-0 z-20 mb-3 shrink-0 space-y-1 border-b border-zinc-800/70 bg-zinc-950/95 pb-1 backdrop-blur")}>
        <Breadcrumb task={task} project={project} />
        {meta}
      </header>
    )
  return (
    // In a panel, the Captain's header's height (CRUMB_ROW) and its column, beside the chat or in its room.
    <header data-testid="task-header" className={cx(HEAD_CONTAINER, "sticky top-0 z-20 shrink-0 border-b border-zinc-800/70 bg-zinc-950/95 backdrop-blur")}>
      <div className={cx(CHAT_COLUMN, CRUMB_ROW)}>{meta}</div>
    </header>
  )
}

/**
 * The Captain's header's column (CaptainTab.tsx CentreCaptainHeader): `chat-column`, its scrollbar gutters too (they
 * only apply where it clips, from sm: phones have none), so the crumbs start where the Captain's icon does. Inside the
 * header, as there: what shows from 36rem or 48rem goes by the header's width, not the column's 48rem. The task's
 * other rows that don't scroll take it too (TaskSession.tsx), so the whole panel is the Captain chat's width.
 */
export const CHAT_COLUMN = "chat-column sm:overflow-hidden"
/**
 * The crumbs' row, as tall as the Captain's header and its content at the same height: 56px with the border under
 * it, below the top inset (the panel covers the chat's own on a phone) and 8px from sm. An unnamed container, as the
 * Captain's header is, for the crumbs it shares with it (TreeNav.tsx).
 */
const CRUMB_ROW = "@container flex min-h-[calc(3.5rem-1px)] flex-col justify-center pt-[env(safe-area-inset-top)] sm:pt-[max(0.5rem,env(safe-area-inset-top))]"

/**
 * Mark done's fold when it's the header's only chip: its words outlast the others' (HEADER_FOLD, 36rem), so a side
 * panel and a phone still say "Mark done"; only a header under 22rem (a 320px phone) draws it as its ✓, 32px, 44px to
 * a finger.
 */
const MARK_DONE_FOLD = {
  chip: "@max-[22rem]/head:h-8 @max-[22rem]/head:min-w-8 @max-[22rem]/head:justify-center @max-[22rem]/head:rounded-lg @max-[22rem]/head:border-transparent @max-[22rem]/head:bg-transparent @max-[22rem]/head:px-1.5 pointer-coarse:@max-[22rem]/head:h-11 pointer-coarse:@max-[22rem]/head:min-w-11",
  label: "@max-[22rem]/head:sr-only",
  icon: "@max-[22rem]/head:h-4 @max-[22rem]/head:w-4",
} as const

/**
 * Mark done for a task ready for Cody's review, beside ⓘ rather than only in it: a chip with its words, done at once with an
 * Undo toast like ⓘ's Mark done. `crowded`: the PR, a preview or files are there too, so it folds with them, and a
 * phone's header stays one row.
 */
function MarkDoneButton({ task, crowded }: { task: Task; crowded: boolean }) {
  const markDone = useMarkDone()
  const fold = crowded ? HEADER_FOLD : MARK_DONE_FOLD
  return (
    <button
      type="button"
      data-testid="task-mark-done"
      onClick={() => void markDone(task)}
      title="Mark done: close the task (its workspace is archived). Messaging it picks it back up."
      className={cx(HEADER_CHIP, "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-200", fold.chip)}
    >
      <Check className={cx("h-3.5 w-3.5", fold.icon)} aria-hidden />
      <span className={fold.label}>Mark done</span>
    </button>
  )
}

/**
 * Reopen for a done task, where Mark done was: Undo for a Mark done at any time later. It goes back to the status it
 * had (idle, PR ready, ...), its PR state kept, and starts no turn (useReopenTask). Folds like Mark done.
 */
function ReopenButton({ task, crowded }: { task: Task; crowded: boolean }) {
  const reopen = useReopenTask()
  const [busy, setBusy] = useState(false)
  const fold = crowded ? HEADER_FOLD : MARK_DONE_FOLD
  return (
    <button
      type="button"
      data-testid="task-reopen"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void reopen(task.id).finally(() => setBusy(false))
      }}
      title="Reopen: back to where it was before it was marked done. It starts no turn; it waits for you again."
      className={cx(HEADER_CHIP, "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-50 disabled:opacity-60", fold.chip)}
    >
      <RotateCcw className={cx("h-3.5 w-3.5", fold.icon)} aria-hidden />
      <span className={fold.label}>Reopen</span>
    </button>
  )
}

/** ⓘ, drawn like Back (DismissButton): 32px, and 44px to a finger. */
const ICON_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:w-11"

/**
 * The task's icon and the title, on one line. A tap opens the details (the full title, the state in words, where it
 * runs). The icon says the state (TaskStatusIcon): to the eye while it works, asks or failed, and always by name to
 * screen readers and in the tooltip. Task state is separate from its PR state, including after the PR merges. `wrap`
 * (a phone's second row): the whole title, up to three lines, the icon on its first.
 */
function TitleButton({ task, open, onOpen, wrap = false }: { task: Task; open: boolean; onOpen: () => void; wrap?: boolean }) {
  return (
    <button
      type="button"
      data-testid="task-title"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`${task.title}\n${STATUS[task.status].label} · active ${timeAgo(task.updatedAt)}. Details and more actions`}
      className={cx(
        "flex min-w-0 flex-1 gap-2 rounded-md px-1 text-left hover:bg-zinc-900/80 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
        wrap ? "-ml-1 min-h-11 items-start py-3 text-[15px] leading-5" : "min-h-8 items-center pointer-coarse:min-h-11",
      )}
    >
      <span className={cx("flex shrink-0 items-center gap-1.5", wrap && "h-5")}>
        {/* Muted with the title while the task idles. */}
        <TaskStatusIcon task={task} size="lg" label={STATUS[task.status].label} muted={task.status === "idle"} />
        <PriorityPill task={task} compact />
      </span>
      <span className={cx("min-w-0 flex-1 font-semibold tracking-tight", wrap ? "line-clamp-3 wrap-anywhere" : "truncate text-[15px] leading-snug @min-[32rem]/head:text-base")}>{task.title}</span>
    </button>
  )
}

/** Queued messages and compacting, beside the chips once the header has room (the details always say them). */
function TaskStateMore({ task }: { task: Task }) {
  const compact = task.compacting || task.compactPending
  if (!task.pendingCount && !compact) return null
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap @max-[36rem]/head:hidden">
      {task.pendingCount > 0 && <QueuedLink taskId={task.id} count={task.pendingCount} />}
      {compact && <span>{task.compacting ? "Compacting…" : "Compact queued"}</span>}
    </span>
  )
}

/** The state in words, for the details: the dot and its label, then what's queued and compacting. */
function TaskState({ task, onReveal }: { task: Task; onReveal: () => void }) {
  return (
    <StatusDot status={task.status} title={`Active ${timeAgo(task.updatedAt)}`} className={cx("min-w-0 flex-wrap", task.status !== "idle" && "text-zinc-200")}>
      {/* The queue opens in the transcript, so the sheet steps aside first. */}
      {task.pendingCount > 0 && <span className="font-normal text-zinc-500" onClickCapture={onReveal}>· <QueuedLink taskId={task.id} count={task.pendingCount} /></span>}
      {(task.compacting || task.compactPending) && <span className="font-normal text-zinc-500">· {task.compacting ? "Compacting…" : "Compact queued"}</span>}
      <PriorityPill task={task} />
    </StatusDot>
  )
}

/** "box-yard › task_…" above the title: the project (on the tab used last) and the task id, which copies on click. */
function Breadcrumb({ task, project }: { task: Task; project: Project | undefined }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const crumb = "rounded focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-zinc-500">
      {project ? (
        <Link href={projectChatHref(project.id)} className={cx(crumb, "min-w-0 truncate py-1 hover:text-zinc-300 hover:underline sm:py-0")}>
          {project.name}
        </Link>
      ) : (
        <Link href="/" className={cx(crumb, "shrink-0 py-1 hover:text-zinc-300 hover:underline sm:py-0")}>
          Yard
        </Link>
      )}
      <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" aria-hidden />
      <span className="relative shrink-0">
        <Link
          href={taskSessionHref(task.id)}
          aria-current="page"
          title={`${task.title}\nClick to copy the id`}
          className={cx(crumb, "py-1 font-mono text-[11px] text-zinc-400 hover:text-zinc-200 sm:py-0")}
          onClick={async (e) => {
            // Plain clicks copy; Cmd/Ctrl and middle clicks keep the link and open the task in a new tab.
            const result = await copyIdOnClick(e, task.id)
            if (result === "copied") setCopied(true)
            else if (result === "failed") toast.error("Couldn't copy", "The browser blocked clipboard access.")
          }}
        >
          {task.id}
        </Link>
        {copied && (
          <span role="status" className="absolute top-full left-1/2 z-20 mt-1 -translate-x-1/2 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-zinc-200 shadow-lg">
            <Check className="mr-0.5 inline h-3 w-3 text-emerald-400" /> Copied
          </span>
        )}
      </span>
    </nav>
  )
}

/**
 * A preview the agent registered (report_preview) or Cody opened: the header's most prominent action, in a new tab.
 * The port only shows when there are several to tell apart; the tooltip always has the label and port. A narrow
 * header folds it to the globe.
 */
function PreviewChip({ preview, port }: { preview: PreviewLink; port: boolean }) {
  return (
    <NewTabLink
      href={preview.url}
      title={`${preview.label} (port ${preview.port})`}
      mark="end"
      markClassName={HEADER_FOLD.label}
      data-testid="preview-chip"
      className={cx(HEADER_CHIP, "border border-sky-400/50 bg-sky-500/20 font-semibold text-sky-50 hover:bg-sky-500/30", HEADER_FOLD.chip)}
    >
      <Globe className={cx("h-3.5 w-3.5 text-sky-300", HEADER_FOLD.icon)} aria-hidden /> <span className={HEADER_FOLD.label}>Preview</span>
      {port && <span className="font-normal text-sky-200/80">:{preview.port}</span>}
    </NewTabLink>
  )
}

/** Closes on Escape (focus goes back to the trigger) and on a click outside `root` (and `portal`, a panel rendered elsewhere). */
export function usePopover(portal?: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!root.current?.contains(t) && !portal?.current?.contains(t)) setOpen(false)
    }
    // Esc closes only the topmost layer: not this menu while a dialog opened after it sits on top, nor when
    // something nearer has already taken the key.
    const depth = modalDepth()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || modalDepth() > depth) return
      e.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, portal])
  return { open, setOpen, root, trigger }
}

/** A menu switch's knob (role="switch" on the row). */
function Knob({ on }: { on: boolean }) {
  return (
    <span className={cx("relative h-4 w-7 shrink-0 rounded-full", on ? "bg-yard-500" : "bg-zinc-700")} aria-hidden>
      <span className={cx("absolute top-0.5 h-3 w-3 rounded-full bg-zinc-950", on ? "left-3.5" : "left-0.5")} />
    </span>
  )
}

export const menuItemBase = "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm focus-visible:outline-none sm:min-h-0 sm:py-1.5"
export const menuItem = cx(menuItemBase, "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus-visible:bg-zinc-800")

/** A red menu row: Stop and Delete. */
const dangerItem = cx(menuItemBase, "text-red-300 hover:bg-red-500/10 hover:text-red-200 focus-visible:bg-red-500/10")

/**
 * ⓘ and the details sheet it opens (the title opens it too, so the header holds `open`). An info icon, not ⋯: the sheet
 * is the task's details first (its state, branch, where it runs), with its less common actions under them, as a
 * phone's ⓘ beside a conversation's name opens its details with Delete at the bottom; ⋯ promises a short menu.
 */
function TaskMenu({
  task,
  project,
  schedule,
  open,
  setOpen,
}: {
  task: Task
  project: Project | undefined
  schedule: Schedule | null | undefined
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const primary = primaryAction(task.status)
  const [, navigate] = useLocation()
  const [portOpen, setPortOpen] = useState(false)
  const markDone = useMarkDone()
  const reopen = useReopenTask()
  const stop = useStopTask()
  const retry = useRetryTask()
  const del = useDeleteTask()
  const stayOpen = useSetStayOpenOnMerge()
  // Done when its PR merges, as its project or Settings has it (the task's own switch only ever keeps it open).
  const globalAutoDone = useAgentSettings({ enabled: open }).data?.settings.autoDoneOnMerge ?? true
  const autoDone = project?.autoDoneOnMerge ?? globalAutoDone

  useEffect(() => { if (!open) setPortOpen(false) }, [open])

  return (
    <div className="relative">
      <button
        type="button"
        className={cx(ICON_BUTTON, "-mr-1.5 pointer-coarse:-mr-2.5")}
        aria-label="Task details and more actions"
        title="Details and more actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Info className="h-[18px] w-[18px]" aria-hidden />
      </button>
      {open && (
        <Modal
          title="Task details"
          size="xl"
          placement="sheet"
          onClose={() => setOpen(false)}
          className="[&_[data-dismiss]]:size-11 [&_[data-dismiss]]:transition-none"
          bodyClassName={cx(
            "@container/details scroll-thin min-h-0 flex-1 overflow-y-auto p-5 text-sm [&_button]:min-h-11 [&_button]:min-w-11",
            "[&_time[role=button]]:inline-flex [&_time[role=button]]:min-h-11 [&_time[role=button]]:min-w-11 [&_time[role=button]]:items-center [&_time[role=button]]:whitespace-nowrap",
          )}
        >
          <p className="mb-4 leading-snug font-medium wrap-anywhere text-zinc-100">{task.title}</p>
          <div className="grid items-start gap-x-6 gap-y-5 text-xs text-zinc-400 @min-[34rem]/details:grid-cols-2">
            <DetailGroup title="Task">
              <Detail label="Status">
                <TaskState task={task} onReveal={() => setOpen(false)} />
              </Detail>
              <Detail label="ID">
                <span className="min-w-0 flex-1 wrap-anywhere font-mono text-[11px] text-zinc-300">{task.id}</span>
                <CopyButton text={task.id} label="Copy task id" />
              </Detail>
              <Detail label="Link">
                <span className="min-w-0 flex-1 truncate text-zinc-300">Open this task</span>
                <CopyButton text={`${window.location.origin}${taskSessionHref(task.id)}`} label="Copy task link" />
              </Detail>
              {task.branch && (
                <Detail label="Branch">
                  <span className="min-w-0 flex-1 wrap-anywhere font-mono text-[11px] text-zinc-300" title={task.branch}>
                    {task.branch}
                  </span>
                  <CopyButton text={task.branch} label="Copy branch name" />
                </Detail>
              )}
              {task.pushState && <PushDetail push={task.pushState} />}
              <Detail label="Active">
                <span className="text-zinc-300">
                  <TimeAgo ts={task.updatedAt} />
                </span>
                <span>
                  · {task.turnCount} turn{task.turnCount === 1 ? "" : "s"}
                </span>
              </Detail>
              <Detail label="Created">
                <span className="text-zinc-300">
                  <TimeAgo ts={task.createdAt} />
                </span>
              </Detail>
              {task.scheduleId && (
                <Detail label="Schedule">
                  <span className="min-w-0 wrap-anywhere text-zinc-300">
                    {schedule ? schedule.name : "a deleted schedule"}
                  </span>
                </Detail>
              )}
            </DetailGroup>
            <div className="min-w-0 space-y-5">
              <DetailGroup title="Agent">
                <Detail label="Agent">
                  <span className="min-w-0 wrap-anywhere text-zinc-300" data-testid="task-agent-cli">
                    {AGENT_CLI_LABEL[task.agentCli ?? "claude"]}
                  </span>
                </Detail>
                {(task.model || task.effort) && (
                  <Detail label="Model">
                    <span className="min-w-0 wrap-anywhere text-zinc-300">{[task.model, task.effort ? `${task.effort} effort` : ""].filter(Boolean).join(" · ")}</span>
                  </Detail>
                )}
                {project && <IdentityDetail identityId={project.identityId} onOpen={() => setOpen(false)} />}
                {(task.routingRule || task.routingReason) && (
                  <Detail label="Route" top>
                    <span className="min-w-0 py-0.5 leading-snug wrap-anywhere">
                      {task.routingRule && <span className="text-zinc-300">{task.routingRule}</span>}
                      {task.routingRule && task.routingReason && " · "}
                      {task.routingReason}
                    </span>
                  </Detail>
                )}
              </DetailGroup>
              {/* Where it runs: the header leaves it out, so this is the only place it shows. */}
              <section aria-label="Where this task runs" data-testid="task-details-placement" className="border-t border-zinc-800/80 pt-3">
                <h3 className="mb-2 text-sm font-medium text-zinc-100">Runner</h3>
                {task.runsOn && (
                  <dl className="mb-3 grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-2">
                    <Detail label="Runs on">
                      <span className={cx("min-w-0 wrap-anywhere", task.runsOn === "local" ? "text-amber-200" : "text-zinc-300")} data-testid="task-runs-on">
                        {task.runsOn === "gpu" && task.gpu ? gpuPickLabel(task.gpu.provider, task.gpu.type) : RUNNER_LABEL[task.runsOn]}
                        {task.runsOn === "box" && task.boxSize ? ` · ${task.boxSize} or larger` : task.runsOn === "gpu" && task.gpu?.size ? ` · ${daytonaSize(task.gpu.size)?.label ?? task.gpu.size}` : task.runsOn === "ssh" && task.machineLabel ? ` · ${task.machineLabel}` : ""} · this task only
                      </span>
                    </Detail>
                  </dl>
                )}
                <PlacementDetails task={task} project={project} />
              </section>
            </div>
          </div>

          <section aria-label="Task actions" className="mt-5 border-t border-zinc-800/80 pt-3">
            <h3 className="mb-2 text-sm font-medium text-zinc-100">Actions</h3>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(task.stayOpenOnMerge)}
              className={menuItem}
              onClick={() => stayOpen.mutate({ taskId: task.id, stayOpen: !task.stayOpenOnMerge })}
              title="On: this task is never moved to done or archived when its PR merges, for a long-running task like a dev server or runner."
              data-testid="task-stay-open-on-merge"
            >
              <GitMerge className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>Stay open when its PR merges</span>
                {!task.stayOpenOnMerge && (
                  <span className="text-xs text-zinc-500">{autoDone ? "Off: a merged PR moves it to done" : `Off, but ${project?.autoDoneOnMerge === false ? "its project" : "Settings"} leave${project?.autoDoneOnMerge === false ? "s" : ""} merged tasks open anyway`}</span>
                )}
              </span>
              <Knob on={Boolean(task.stayOpenOnMerge)} />
            </button>
            <div className="grid gap-x-4 @min-[34rem]/details:grid-cols-2">
              {portOpen ? (
                <OpenPortForm taskId={task.id} onDone={() => setOpen(false)} />
              ) : (
                <button type="button" className={menuItem} onClick={() => setPortOpen(true)}>
                  <Plug className="h-3.5 w-3.5 text-zinc-500" /> Open a port…
                </button>
              )}
              <MergePrMenuItem task={task} onPicked={() => setOpen(false)} />
              {primary === "retry" && <button type="button" className={menuItem} onClick={() => { retry.mutate(task.id); setOpen(false) }}>
                <RefreshCcw className="h-3.5 w-3.5 text-zinc-500" /> Retry task
              </button>}
              <ContinueTask task={task} className="justify-start" />
              {task.status !== "done" && (
                <button
                  type="button"
                  className={menuItem}
                  onClick={() => {
                    // Like a card's ✓: done at once with an Undo toast; a running task asks first, over the page.
                    setOpen(false)
                    void markDone(task)
                  }}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-zinc-500" /> Mark done
                </button>
              )}
              {task.status === "done" && (
                <button
                  type="button"
                  className={menuItem}
                  data-testid="task-menu-reopen"
                  onClick={() => {
                    setOpen(false)
                    void reopen(task.id)
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5 text-zinc-500" /> Reopen
                </button>
              )}
            </div>

            <div className="mt-2 grid gap-x-4 border-t border-zinc-800/80 pt-2 @min-[34rem]/details:grid-cols-2">
              {/* Only while it runs. Its turn ends; a message starts the next. */}
              {primary === "stop" && (
                <button
                  type="button"
                  className={dangerItem}
                  title="Stop the agent's current turn"
                  disabled={stop.isPending}
                  onClick={() => {
                    stop.mutate(task.id)
                    setOpen(false)
                  }}
                >
                  <Square className="h-3 w-3 fill-current" aria-hidden /> Stop task
                </button>
              )}
              <button
                type="button"
                className={dangerItem}
                onClick={async () => {
                  setOpen(false)
                  if (!(await confirmDialog({ title: "Delete task?", body: "Delete this task, its workspace and its archive?", confirmLabel: "Delete task", danger: true }))) return
                  del.mutate(task.id)
                  navigate(project ? `/projects/${project.id}` : "/")
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete task…
              </button>
            </div>
          </section>
        </Modal>
      )}
    </div>
  )
}

/** The last turn-end push: whether the task's code is on origin, so its box can go without losing it. */
function PushDetail({ push }: { push: NonNullable<Task["pushState"]> }) {
  const line = pushStateLine(push)
  return (
    <Detail label="Git" top>
      <span className="min-w-0 py-0.5 leading-snug wrap-anywhere" data-testid="push-state">
        <span className={line.tone === "ok" ? "text-zinc-300" : line.tone === "warn" ? "text-amber-300" : undefined}>{line.text}</span> · <TimeAgo ts={push.at} />
      </span>
    </Detail>
  )
}

/** Who the task's turns act as on GitHub: its project's identity (Settings › Identities). */
function IdentityDetail({ identityId, onOpen }: { identityId: string; onOpen: () => void }) {
  const identity = useIdentities().data?.find((i) => i.id === identityId)
  const openSettings = useOpenSettings()
  if (!identity) return null
  return (
    <Detail label="Identity">
      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 rounded text-left hover:text-zinc-100"
        onClick={() => {
          onOpen()
          openSettings("identities")
        }}
        data-testid="task-identity"
      >
        <IdentityBadge identity={identity} className="max-w-full" />
        {identity.githubLogin && <span className="truncate font-mono text-[11px] text-zinc-400">{identity.githubLogin}</span>}
      </button>
    </Detail>
  )
}

/** Each group keeps a readable label column, including when the modal's two columns stack. */
function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 border-t border-zinc-800/80 pt-3">
      <h3 className="mb-2 text-sm font-medium text-zinc-100">{title}</h3>
      <dl className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">{children}</dl>
    </section>
  )
}

/** One label/value pair; the value can include a copy button. */
function Detail({ label, top, children }: { label: string; top?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={cx("text-zinc-500", top && "self-start py-0.5")}>{label}</dt>
      <dd className="flex min-h-6 min-w-0 items-center gap-1">{children}</dd>
    </>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error("Couldn't copy", "The browser blocked clipboard access.")
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/** Get a public URL for any port in the task's box and open it. */
function OpenPortForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [port, setPort] = useState("")
  return (
    <form
      className="@container/port flex flex-wrap items-center gap-2 px-2 py-1"
      onSubmit={async (e) => {
        e.preventDefault()
        const n = Number(port)
        if (!n) return
        try {
          const link = await api<{ url: string }>(`/api/tasks/${taskId}/preview`, { body: { port: n } })
          window.open(link.url, "_blank", "noopener")
          onDone()
        } catch (err) {
          toast.error("Couldn't open a preview", (err as Error).message)
        }
      }}
    >
      <Plug className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <input
        autoFocus
        inputMode="numeric"
        aria-label="Port"
        value={port}
        onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
        placeholder="port, e.g. 3000"
        className="min-h-11 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-base text-zinc-100"
      />
      <Button size="sm" variant="subtle" type="submit" className="min-h-11 w-full @min-[20rem]/port:w-auto" disabled={!port}>
        <Globe className="h-3.5 w-3.5" /> Open
      </Button>
    </form>
  )
}
