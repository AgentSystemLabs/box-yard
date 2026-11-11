import { pinProject, unpinProject, useBarPins, useChatProjectFilter } from "../lib/projectBar"
import { openChat } from "../lib/navigation"
import { focusComposer, pickFocusesComposer } from "../lib/chatSwitch"
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useLocation, useSearch } from "wouter"
import { Activity, AlarmClock, Box, CornerDownLeft, ExternalLink, FileText, FolderGit2, FolderPlus, GitPullRequest, Hand, History, Keyboard, LayoutGrid, ListTodo, ListTree, MessageSquarePlus, Pin, PinOff, Search, Settings, X, Zap } from "lucide-react"
import { QUIET, useArtifacts, useOwnerName, useProjects, useTasks } from "../lib/queries"
import { NEW_TASK, buildItems, newTaskFrom, pushRecent, recentKeyFor, type NewTaskContext, type PaletteCommand, type PaletteItem } from "../lib/palette"
import { PREFIXES, bumpUsage, currentUsage, normalizeQuery, paletteIndex, paletteRows, parseQuery, rankPalette, type GroupKey, type PaletteRow, type PaletteScope } from "../lib/paletteRank"
import { withOwner } from "../../../shared/owner"
import { subtaskHitsLabel } from "../lib/subtaskSearch"
import { isFilePath, previewKind } from "../lib/filePreview"
import { openPreview } from "../lib/preview"
import { NewTabLink, PR_STYLE, STATUS, TAP_AREA, TimeAgo, cx } from "./ui"
import { useOpenSettings } from "./SettingsHost"
import { NewProjectDialog } from "./NewProjectDialog"
import { NewTaskDialog } from "./NewTask"
import { Loading } from "./Loading"
import { clearNewTaskDraft, draftScope, loadDraft, newTaskDraftKey, saveDraft } from "../lib/newTask"
import { projectOfTask } from "../lib/overlays"
import { prNumber, prStateOf } from "../lib/prState"
import { openShortcuts } from "./ShortcutsHelp"
import { chordLabel, isNewTaskKey, paletteChord } from "../lib/shortcuts"
import { isMac } from "../lib/useDictation"
import { DismissButton, Modal, isDialogOpen } from "./Modal"
import { Subtask } from "./ChatIcons"
import { ProjectAvatar, TaskStatusIcon } from "./TaskIcon"
import { useProjectIcon } from "../lib/taskTiles"

// ------------------------------------------------------------------ open state

let open = false
const listeners = new Set<() => void>()
const setOpen = (value: boolean) => {
  open = value
  listeners.forEach((l) => l())
}
export const openPalette = () => setOpen(true)

/** A chat header's 🔍: 44px, like the header's other buttons. */
const HEADER_SEARCH =
  "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"

/**
 * 🔍: opens the palette, as ⌘K / Ctrl K and "/" do. In the Coordinator's and a Captain's header on a phone, and the
 * sidebar's top row where the sidebar is a column (`className` draws it for that row).
 */
export function SearchButton({ className = HEADER_SEARCH }: { className?: string }) {
  const mac = isMac()
  return (
    <button
      type="button"
      data-testid="search-button"
      title={`Search tasks (${chordLabel(paletteChord, mac)} or /)`}
      aria-label="Search tasks"
      aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"}
      onClick={(e) => {
        e.currentTarget.focus()
        openPalette()
      }}
      className={className}
    >
      <Search className="h-4 w-4" aria-hidden />
    </button>
  )
}
const usePaletteOpen = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
  )

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl "

// ------------------------------------------------------------------ recently viewed and command usage

const RECENT_KEY = "box-yard:recent"
const USAGE_KEY = "box-yard:command-usage"

function read<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or full storage: recents and usage are a nicety.
  }
}

const isKeyList = (v: unknown): v is string[] => Array.isArray(v)
const isCounts = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && !Array.isArray(v)

const loadRecent = () => read(RECENT_KEY, isKeyList, []).filter((k): k is string => typeof k === "string")
const remember = (key: string) => write(RECENT_KEY, pushRecent(loadRecent(), key))
const loadUsage = () => currentUsage(read(USAGE_KEY, isCounts, {}))
const countUse = (key: string) => write(USAGE_KEY, bumpUsage(loadUsage(), key))

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]"))

// ------------------------------------------------------------------ host

/** The palette's New task dialog has a project picker, so it keeps one draft wherever it opens (lib/newTask.ts). */
const NEW_TASK_SCOPE = draftScope(null)

/** Mounted once in the app: hotkeys, recent tracking, the palette and the dialogs it opens. */
export function CommandPalette() {
  const isOpen = usePaletteOpen()
  const [location] = useLocation()
  const search = useSearch()
  const captain = useChatProjectFilter()
  const [dialog, setDialog] = useState<PaletteCommand | null>(null)
  /** "New task…": the dialog's first project (the one in view) and its text. */
  const [newTask, setNewTask] = useState<{ projectId: string | null; prompt: string } | null>(null)
  const openSettings = useOpenSettings()

  // Recently viewed: a task's panel or a Captain, however it opened (the sidebar, a card, a link, the palette).
  const viewing = recentKeyFor(search ? `${location}?${search}` : location)
  useEffect(() => {
    if (viewing) remember(viewing)
  }, [viewing])
  useEffect(() => {
    if (captain) remember(`project:${captain}`)
  }, [captain])

  // The project a new task starts in: the open task's, else the Captain's. Its dialog's picker can change it.
  const [kind, id] = viewing?.split(/:(.*)/) ?? []
  const projectInView = (kind === "task" && id ? projectOfTask(id) : kind === "project" ? id : null) ?? captain ?? null

  const onCommand = (command: PaletteCommand, item: PaletteItem) => {
    if (command === "settings") openSettings(item.section)
    else if (command === "shortcuts") openShortcuts()
    else if (command === "pin-project") pinProject(item.project!)
    else if (command === "unpin-project") unpinProject(item.project!)
    else if (command === "coordinator") {
      // As a pick in the sidebar: the chat (or, with it pinned, nothing moves and a toast says why).
      openChat(null)
    } else if (command === "new-task") {
      // The text is the draft kept from last time, then what was typed in the palette.
      const kept = loadDraft(NEW_TASK_SCOPE)
      const typed = item.prompt ?? ""
      setNewTask({ projectId: projectInView, prompt: kept && typed && !kept.includes(typed) ? `${kept}\n\n${typed}` : kept || typed })
    } else setDialog(command)
  }
  const command = useRef(onCommand)
  command.current = onCommand

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen(!open)
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && !open && !isTyping(e.target)) {
        // Pages with their own "/" search (the project Tasks tab) handle it first and call preventDefault.
        e.preventDefault()
        setOpen(true)
      } else if (isNewTaskKey(e) && !isDialogOpen()) {
        // N: the New task dialog, as the palette's "New task…". Never over another dialog; the sidebar's list takes
        // letters for itself (a jump to a row) and calls preventDefault.
        e.preventDefault()
        command.current("new-task", NEW_TASK)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <>
      {isOpen && <Palette projectInView={projectInView} onClose={() => setOpen(false)} onCommand={onCommand} />}
      {dialog === "new-project" && <NewProjectDialog onClose={() => setDialog(null)} />}
      {newTask && (
        <NewTaskDialog
          defaultProjectId={newTask.projectId}
          initialPrompt={newTask.prompt}
          draftKey={newTaskDraftKey(NEW_TASK_SCOPE)}
          onCancel={(prompt) => {
            saveDraft(NEW_TASK_SCOPE, prompt)
            setNewTask(null)
          }}
          onDone={() => {
            clearNewTaskDraft(NEW_TASK_SCOPE)
            setNewTask(null)
          }}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------------ palette

const KIND_ICON: Record<PaletteItem["kind"], typeof Search> = {
  action: Zap,
  page: LayoutGrid,
  setting: Settings,
  task: ListTodo,
  pr: GitPullRequest,
  project: FolderGit2,
  schedule: AlarmClock,
  artifact: FileText,
  box: Box,
}

/** A command's own icon, where it has one: what it makes or opens, instead of its kind's. */
const COMMAND_ICON: Partial<Record<PaletteCommand, typeof Search>> = {
  "new-task": MessageSquarePlus,
  "new-project": FolderPlus,
  settings: Settings,
  shortcuts: Keyboard,
  "pin-project": Pin,
  "unpin-project": PinOff,
}

const GROUP_ICON: Partial<Record<GroupKey, typeof Search>> = { waiting: Hand, working: Activity, recent: History }

const SCOPE_PLACEHOLDER: Record<PaletteScope, string> = {
  command: "Commands and pages…",
  pr: "PR number or title…",
  file: "Search files…",
  project: "Search projects…",
  box: "Search boxes…",
}

const prefixOf = (scope: PaletteScope) => PREFIXES.find((p) => p.scope === scope)!

/** Rows drawn at a time once "Show N more" opens a big group; scrolling near the end or moving past it draws more. */
const ROW_PAGE = 50

function Palette({ projectInView, onClose, onCommand }: { projectInView: string | null; onClose: () => void; onCommand: (c: PaletteCommand, item: PaletteItem) => void }) {
  const [, navigate] = useLocation()
  // QUIET: live updates don't re-render the open palette; the next keystroke picks them up.
  const tasks = useTasks(QUIET)
  const projects = useProjects(QUIET)
  const artifacts = useArtifacts(QUIET)
  const pins = useBarPins()
  const ownerName = useOwnerName()
  const [text, setText] = useState("")
  const [scope, setScope] = useState<PaletteScope | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<GroupKey>>(() => new Set())
  const [active, setActive] = useState(0)
  const [limit, setLimit] = useState(ROW_PAGE)
  const [recent] = useState(loadRecent)
  const [usage] = useState(loadUsage)
  // One clock per open palette, so recency boosts can't reorder rows between keystrokes.
  const [now] = useState(Date.now)
  // What the New task dialog kept last time, read once: its row says so.
  const [draft] = useState(() => loadDraft(NEW_TASK_SCOPE))
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()

  const newTask = useMemo<NewTaskContext>(() => ({ project: projects.data?.find((p) => p.id === projectInView)?.name, draft }), [projects.data, projectInView, draft])
  const items = useMemo(
    () => buildItems({ tasks: tasks.data, projects: projects.data, artifacts: artifacts.data, pins, newTask }),
    [tasks.data, projects.data, artifacts.data, pins, newTask],
  )
  // Indexed for search once the palette has painted, so the first keystroke doesn't wait for it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => (timer = setTimeout(() => paletteIndex(items))))
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [items])
  const query = normalizeQuery(text)
  const groups = useMemo(() => rankPalette(items, { scope, query }, { now, recent, usage, expanded }), [items, scope, query, now, recent, usage, expanded])
  // The last row starts a task from what was typed, when nothing matches it or it reads like a prompt (two words, or
  // a long one). Not in a prefix's scope, which lists one kind, nor while the tasks load.
  const typed = text.trim()
  const offer = useMemo(
    () => (typed && !scope && !tasks.isLoading && (groups.length === 0 || typed.length >= 12 || /\s/.test(typed)) ? newTaskFrom(typed, newTask) : null),
    [groups, typed, scope, tasks.isLoading, newTask],
  )
  const rows = useMemo<PaletteRow[]>(() => (offer ? [...paletteRows(groups), { type: "item", item: offer, group: "command" }] : paletteRows(groups)), [groups, offer])
  const found = useMemo(() => groups.reduce((n, g) => n + g.total, 0), [groups])
  /** The offer's row, when it has one: the last. */
  const offerAt = rows.length - 1
  const at = Math.min(active, rows.length - 1)
  const current = rows[at]
  const optionId = (i: number) => `${id}-opt-${i}`
  // The selected row is always drawn, so the arrows and Ctrl+End reach past the limit.
  const drawn = Math.max(limit, at + 1)
  const more = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActive(0)
    // Kept when nothing is expanded: a new Set would rank the same query again.
    setExpanded((s) => (s.size ? new Set() : s))
    setLimit(ROW_PAGE)
  }, [query, scope])

  useEffect(() => {
    const end = more.current
    if (!end || typeof IntersectionObserver === "undefined") return
    // A fresh observer reports at once, so a tall window keeps drawing until the list fills it.
    const seen = new IntersectionObserver(([e]) => e?.isIntersecting && setLimit(drawn + ROW_PAGE), { root: list.current, rootMargin: "600px 0px" })
    seen.observe(end)
    return () => seen.disconnect()
  }, [drawn, rows.length])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" })
  }, [at])

  const choose = (item: PaletteItem, newTab = false) => {
    if (item.kind === "page" || item.kind === "action") countUse(item.key)
    else if (item.kind === "task" || item.kind === "project") remember(item.key)
    if (newTab && item.href) return void window.open(item.href, "_blank", "noopener")
    onClose()
    // A chat (the Coordinator, a Captain, a task) has the caret in its box, after the draft, once it's on screen and the
    // palette has given the focus back. Not on a touch screen: iOS opens the keyboard only for a focus inside the tap,
    // and the box mounts after it, so it would be a caret without a keyboard there and a keyboard over the chat on
    // Android (lib/chatSwitch.ts pickFocusesComposer, as a pick in the sidebar).
    if (item.chat && pickFocusesComposer()) focusComposer(item.chat, { end: true })
    if (item.command) return onCommand(item.command, item)
    if (item.file && !newTab && isFilePath(item.file.url) && previewKind(item.file)) return openPreview(item.file)
    if (item.url) return void window.open(item.url, "_blank", "noopener")
    if (!item.href) return
    navigate(item.href)
    // pushState doesn't fire hashchange; pages that scroll to #id listen for it.
    if (item.href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"))
  }

  // The rows that were hidden take the "Show N more" row's place, so the selection lands on the first of them.
  const expand = (key: GroupKey) => setExpanded((s) => new Set(s).add(key))

  const activate = (row: PaletteRow, newTab = false) => (row.type === "more" ? expand(row.group) : choose(row.item, newTab))

  const pickScope = (next: PaletteScope | null) => {
    setScope(next)
    input.current?.focus()
  }

  const onInput = (value: string) => {
    if (!scope) {
      const parsed = parseQuery(value)
      if (parsed.scope) {
        setScope(parsed.scope)
        return setText(parsed.rest)
      }
    }
    setText(value)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = rows.length
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault()
      if (n) setActive((at + 1) % n)
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault()
      if (n) setActive((at - 1 + n) % n)
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault()
      setActive(Math.max(0, n - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (current) activate(current, e.metaKey || e.ctrlKey)
    } else if (e.key === "Backspace" && scope && input.current?.selectionStart === 0 && input.current.selectionEnd === 0) {
      // Backspace in front of the text drops the prefix chip.
      e.preventDefault()
      setScope(null)
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only stop; options are reached with the arrows.
      e.preventDefault()
      input.current?.focus()
    }
  }

  const highlight = scope === "pr" ? query.replace(/^#/, "") : query
  const noMatches = typed ? `No matches for “${typed}”` : "No matches"
  let index = 0

  return (
    <Modal
      size="lg"
      placement="top"
      label="Command palette"
      onClose={onClose}
      onKeyDown={onKeyDown}
      // Important: the Modal's own sm:max-h would win otherwise, and long lists ran off the screen.
      className="sm:max-h-[70vh]!"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      {/* The input always has the focus, so the row says so along its bottom edge: an outline around the input would be clipped by the row. */}
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-zinc-900 px-4 has-[>input:focus-visible]:shadow-[inset_0_-2px_0_var(--focus-ink)]">
        {scope === "command" ? <Zap className="h-4 w-4 shrink-0 text-yard-400" /> : <Search className="h-4 w-4 shrink-0 text-zinc-500" />}
        {scope && (
          <button
            type="button"
            data-testid="palette-scope"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickScope(null)}
            aria-label={`${prefixOf(scope).label} only: remove the ${prefixOf(scope).prefix} filter`}
            className={cx(TAP_AREA, "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-yard-500/40 bg-yard-500/10 px-2 text-xs font-medium text-yard-300 sm:min-h-0 sm:py-0.5")}
          >
            <span className="font-mono">{prefixOf(scope).prefix}</span>
            {prefixOf(scope).label}
            <X className="h-3 w-3" />
          </button>
        )}
        <input
          ref={input}
          // Focused as it mounts, so the Modal doesn't look for a control to focus (that forces a layout). It gives
          // focus back to whatever had it when the palette closes.
          autoFocus
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={current ? optionId(at) : undefined}
          aria-autocomplete="list"
          aria-label="Search Box Yard"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => onInput(e.target.value)}
          placeholder={scope ? SCOPE_PLACEHOLDER[scope] : "Search tasks, Captains, settings, files…"}
          className="min-w-0 flex-1 bg-transparent py-3.5 text-base text-zinc-100 outline-none! placeholder:text-zinc-600 sm:text-sm"
        />
        <kbd className="rounded border border-zinc-800 px-1.5 py-0.5 font-sans text-[10px] text-zinc-500 max-sm:hidden">esc</kbd>
        {/* A phone has no Esc key; a wider screen shows the esc hint instead. */}
        <DismissButton kind="close" onClick={onClose} className="-mr-1.5 sm:hidden" />
      </div>

      {!scope && !text && (
        // A narrow phone drops the label and tightens the chips, so the four fit on one line; narrower still, they wrap.
        <div data-testid="palette-prefixes" role="group" aria-label="Narrow to" className="@container flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-900 px-4 py-2 text-[11px] text-zinc-500 pointer-coarse:min-h-11">
          <span aria-hidden className="shrink-0 @max-[22rem]:hidden">Narrow to</span>
          {PREFIXES.map((p) => (
            <button
              key={p.scope}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickScope(p.scope)}
              className={cx(TAP_AREA, "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 sm:min-h-0 sm:py-0.5 @max-[19rem]:px-1.5")}
            >
              <span className="font-mono text-zinc-300">{p.prefix}</span>
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div ref={list} id={`${id}-list`} role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 && (tasks.isLoading ? <Loading kind="rows" label="Loading tasks" className="px-2.5 py-3" /> : <div className="px-3 py-8 text-center text-sm wrap-anywhere text-zinc-500">{noMatches}</div>)}
        {/* Groups past the drawn rows wait for them. */}
        {groups.map((g) => index < drawn && (
          <Group key={g.key} name={g.key} label={withOwner(g.label, ownerName)} id={`${id}-${g.key}`}>
            {g.items.map((item) => {
              const i = index++
              if (i >= drawn) return null
              return (
                <Option
                  key={item.key}
                  id={optionId(i)}
                  index={i}
                  item={item}
                  query={highlight}
                  selected={i === at}
                  onHover={() => setActive(i)}
                  onChoose={(newTab) => choose(item, newTab)}
                />
              )
            })}
            {g.items.length < g.total &&
              (() => {
                const i = index++
                if (i >= drawn) return null
                return <ShowAll key="more" id={optionId(i)} index={i} hidden={g.total - g.items.length} selected={i === at} onHover={() => setActive(i)} onChoose={() => expand(g.key)} />
              })()}
          </Group>
        ))}
        {offer &&
          offerAt < drawn &&
          (() => {
            const row = <Option id={optionId(offerAt)} index={offerAt} item={offer} query="" selected={offerAt === at} onHover={() => setActive(offerAt)} onChoose={() => choose(offer)} />
            // On its own it answers "No matches"; under results it is one more group, the last.
            return groups.length ? (
              <Group name="new-task" label="New task" id={`${id}-new-task`}>
                {row}
              </Group>
            ) : (
              <>
                <div className="px-3 pt-6 pb-4 text-center text-sm wrap-anywhere text-zinc-500">{noMatches}</div>
                {row}
              </>
            )
          })()}
        {rows.length > drawn && <div ref={more} data-testid="palette-more-rows" className="h-px" />}
      </div>

      {/* What a search found, for a screen reader: the rows themselves are read only as the arrows reach them. */}
      <div role="status" className="sr-only">
        {offer && !found ? `${noMatches}. Enter starts a new task with it.` : !typed && !scope ? "" : tasks.isLoading && !found ? "" : found ? `${found} result${found === 1 ? "" : "s"}` : noMatches}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-900 px-4 py-2 text-[11px] text-zinc-500 max-sm:hidden">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        {/* Only a row that is a page of the app opens in a tab of its own. */}
        {current?.type === "item" && current.item.href && (
          <span>
            <Kbd>{MOD_KEY.trim()}</Kbd>
            <Kbd>↵</Kbd> new tab
          </span>
        )}
        {scope && (
          <span className="ml-auto">
            <Kbd>⌫</Kbd> clear filter
          </span>
        )}
      </div>
    </Modal>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-0.5 inline-block min-w-4 rounded border border-zinc-800 bg-zinc-900 px-1 text-center font-sans text-[10px] text-zinc-400">{children}</kbd>
}

function Group({ name, label, id, children }: { name: GroupKey | "new-task"; label: string; id: string; children: ReactNode }) {
  const Icon = name === "new-task" ? undefined : GROUP_ICON[name]
  return (
    <div role="group" aria-labelledby={id} data-group={name} className="mb-1 last:mb-0">
      <div id={id} className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      {children}
    </div>
  )
}

function Option({
  id,
  index,
  item,
  query,
  selected,
  onHover,
  onChoose,
}: {
  id: string
  index: number
  item: PaletteItem
  query: string
  selected: boolean
  onHover: () => void
  onChoose: (newTab: boolean) => void
}) {
  const Icon = (item.command && COMMAND_ICON[item.command]) || KIND_ICON[item.kind]
  const icon = useProjectIcon(item.kind === "project" ? item.key.slice("project:".length) : null)
  const { task } = item
  const pr = task ? prStateOf(task) : null
  const PrIcon = pr ? PR_STYLE[pr].icon : null
  const number = item.kind === "task" && pr ? prNumber(task?.prUrl) : null
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-key={item.key}
      // Keep focus in the input so the keyboard keeps working after a click.
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={(e) => onChoose(e.metaKey || e.ctrlKey)}
      onAuxClick={(e) => e.button === 1 && onChoose(true)}
      className={cx("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm", selected ? "bg-zinc-800/80 text-zinc-50" : "text-zinc-300")}
    >
      <div className="min-w-0 flex-1">
        <div className={cx("truncate", item.kind === "task" && item.taskStatus === "failed" && "task-title-failed")}>
          <Highlight text={item.title} query={query} />
        </div>
        <Meta item={item} />
      </div>
      {/* Drawn first, after the title in the DOM: a screen reader reads the task, then its state (as the sidebar's rows). */}
      <span className="order-first grid h-5 w-5 shrink-0 place-items-center">
        {item.kind === "task" && task ? (
          // The task's own tile says its state; a finished one is neutral, so live work stands out.
          <TaskStatusIcon task={task} label={item.status === "merged" ? "Merged" : STATUS[task.status].label} muted={task.status === "done"} />
        ) : item.kind === "pr" && PrIcon && pr ? (
          // A pull request's glyph in its state's colour; the line under the title says the state in words.
          <PrIcon aria-hidden className={cx("h-4 w-4", PR_STYLE[pr].link)} />
        ) : (
          <ProjectAvatar src={icon} className="h-4 w-4 rounded-[4px]">
            <Icon className={cx("h-4 w-4 shrink-0", selected ? "text-yard-400" : "text-zinc-500")} />
          </ProjectAvatar>
        )}
      </span>
      {/* A task's PR, to read: the row is the one thing here to press, and its PR's own row ("#") links to GitHub. */}
      {number && PrIcon && pr && (
        <span data-pr-state={pr} className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-500 tabular-nums">
          <PrIcon aria-hidden className={cx("h-3 w-3", PR_STYLE[pr].link)} />
          <span className="sr-only">Pull request, {pr}: </span>#{number}
        </span>
      )}
      {item.shortcut && (
        <span className="shrink-0 max-sm:hidden">
          <Kbd>{item.shortcut}</Kbd>
        </span>
      )}
      {(item.kind === "task" || item.kind === "pr") && item.at && (
        <span className="w-14 shrink-0 text-right text-xs text-zinc-500 max-sm:hidden">
          <TimeAgo ts={item.at} />
        </span>
      )}
      {item.externalUrl && (
        <NewTabLink
          href={item.externalUrl}
          aria-label="Open on GitHub"
          title="Open on GitHub"
          mark={false}
          onMouseDown={(e) => e.preventDefault()}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-200 sm:h-7 sm:w-7"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </NewTabLink>
      )}
      {/* Every row keeps the glyph's place, so the columns before it don't move as the selection does. */}
      <CornerDownLeft aria-hidden className={cx("h-3.5 w-3.5 shrink-0 text-zinc-500 max-sm:hidden", !selected && "invisible")} />
    </div>
  )
}

/**
 * The line under a row's title: a sub-task's parent task (so a tree's look-alike titles tell apart), or why a top-level
 * task is listed when only its sub-tasks match; then the subtitle (the project). Otherwise just the subtitle.
 */
function Meta({ item }: { item: PaletteItem }) {
  const lead = item.subtaskHits ? subtaskHitsLabel(item.subtaskHits) : item.parent
  if (!lead) return item.subtitle ? <div className="truncate text-xs text-zinc-500">{item.subtitle}</div> : null
  const Icon = item.subtaskHits ? ListTree : Subtask
  return (
    <div data-testid="palette-meta" className="flex min-w-0 items-center gap-1 text-xs text-zinc-500">
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {!item.subtaskHits && <span className="sr-only">Sub-task of </span>}
      {/* "2 sub-tasks match" is short and says why the row is here, so the project gives way instead. */}
      <span className={item.subtaskHits ? "shrink-0" : "min-w-0 truncate"}>{lead}</span>
      {item.subtitle && <span className={cx("truncate", item.subtaskHits ? "min-w-0" : "max-w-[45%] shrink-0")}>· {item.subtitle}</span>}
    </div>
  )
}

/** The last row of a capped group: expands it in place. */
function ShowAll({ id, index, hidden, selected, onHover, onChoose }: { id: string; index: number; hidden: number; selected: boolean; onHover: () => void; onChoose: () => void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-testid="palette-show-all"
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => !selected && onHover()}
      onClick={onChoose}
      className={cx("flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 py-1.5 pl-10.5 text-xs sm:min-h-8", selected ? "bg-zinc-800/80 text-zinc-100" : "text-zinc-500")}
    >
      Show {hidden} more
    </div>
  )
}

/** Marks the first occurrence of the query in the title. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-yard-400">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  )
}
