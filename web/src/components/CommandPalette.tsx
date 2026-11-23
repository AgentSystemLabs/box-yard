// The command palette's dialog, its keys (⌘K / Ctrl K and "/", N for a new task), the 🔍 buttons that open it and what
// was recently viewed. The list inside (Palette.tsx: ranking, groups and rows) is a chunk of its own that comes the
// first time the palette opens, or when a 🔍 is pointed at; until then the dialog's field keeps what's typed for it.
import { pinProject, unpinProject, useChatProjectFilter } from "../lib/projectBar"
import { openChat } from "../lib/navigation"
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react"
import { useLocation, useSearch } from "wouter"
import { Search } from "lucide-react"
import { NEW_TASK, pushRecent, recentKeyFor, type PaletteCommand, type PaletteItem } from "../lib/palette"
import { useOpenSettings } from "./SettingsHost"
import { NewProjectDialog } from "./NewProjectDialog"
import { NewTaskDialog, useNarrow } from "./NewTask"
import { Loading } from "./Loading"
import { LoadFailed, lazyPart } from "./LazyPart"
import { clearNewTaskDraft, draftScope, loadDraft, newTaskDraftKey, saveDraft } from "../lib/newTask"
import { projectOfTask } from "../lib/overlays"
import { openShortcuts } from "./ShortcutsHelp"
import { chordLabel, isNewTaskKey, paletteChord } from "../lib/shortcuts"
import { isMac } from "../lib/useDictation"
import { DismissButton, Modal, isDialogOpen } from "./Modal"

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
      title={`Search and commands (${chordLabel(paletteChord, mac)} or /)`}
      aria-label="Search and commands"
      aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"}
      onClick={(e) => {
        e.currentTarget.focus()
        openPalette()
      }}
      onPointerEnter={Palette.preload}
      onFocus={Palette.preload}
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

export function readStored<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or full storage: recents and usage are a nicety.
  }
}

const isKeyList = (v: unknown): v is string[] => Array.isArray(v)

export const loadRecent = () => readStored(RECENT_KEY, isKeyList, []).filter((k): k is string => typeof k === "string")
export const remember = (key: string) => writeStored(RECENT_KEY, pushRecent(loadRecent(), key))

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]"))

// ------------------------------------------------------------------ host

/** The palette's New task dialog has a project picker, so it keeps one draft wherever it opens (lib/newTask.ts). */
export const NEW_TASK_SCOPE = draftScope(null)

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
  const keys = useRef<PaletteKeys | null>(null)
  const early = useRef("")
  // Each opening starts empty, with the list's keys set again as it renders.
  useEffect(() => {
    if (isOpen) return
    early.current = ""
    keys.current = null
  }, [isOpen])
  const close = () => setOpen(false)

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
      {isOpen && (
        <Modal
          size="lg"
          placement="top"
          label="Command palette"
          onClose={close}
          onKeyDown={(e) => keys.current?.(e)}
          // Important: the Modal's own sm:max-h would win otherwise, and long lists ran off the screen.
          className="sm:max-h-[70vh]!"
          bodyClassName="flex min-h-0 flex-1 flex-col"
        >
          <Palette projectInView={projectInView} onClose={close} onCommand={onCommand} keys={keys} early={early} />
        </Modal>
      )}
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

// ------------------------------------------------------------------ the list's chunk

type PaletteKeys = (e: ReactKeyboardEvent) => void

export type PaletteProps = {
  projectInView: string | null
  onClose: () => void
  onCommand: (c: PaletteCommand, item: PaletteItem) => void
  /** The dialog's key handler, which the list sets as it renders. */
  keys: RefObject<PaletteKeys | null>
  /** What was typed in the field while the list's chunk came in. */
  early: RefObject<string>
}

/** The field's row and the field: the list's and its loading view's, so one takes the other's place unmoved. */
export const PALETTE_INPUT_ROW =
  "flex min-h-14 shrink-0 items-center gap-2.5 border-b border-zinc-900 px-4 has-[>input:focus-visible]:shadow-[inset_0_-2px_0_var(--focus-ink)]"
export const PALETTE_INPUT = "min-w-0 flex-1 bg-transparent py-3.5 text-base text-ellipsis text-zinc-100 outline-none! placeholder:text-zinc-600 sm:text-sm"
/** A field with the caret in it cuts a long placeholder off without a "…": a phone gets one that fits. */
export const paletteHint = (narrow: boolean) => (narrow ? "Search Box Yard…" : "Search tasks, Captains, settings, files…")

/** The esc hint where there's a keyboard; a phone has no Esc key, so it gets Close instead. */
export function PaletteDismiss({ onClose }: { onClose: () => void }) {
  return (
    <>
      <kbd className="rounded border border-zinc-800 px-1.5 py-0.5 font-sans text-[10px] text-zinc-500 max-sm:hidden">esc</kbd>
      <DismissButton kind="close" onClick={onClose} className="-mr-1.5 sm:hidden" />
    </>
  )
}

/** The dialog until the list is in: the same field, which keeps what's typed and hands it over, and Esc and Close. */
function PaletteLoading({ onClose, early }: PaletteProps) {
  const narrow = useNarrow()
  return (
    <>
      <div className={PALETTE_INPUT_ROW}>
        <Search className="h-4 w-4 shrink-0 text-zinc-500" />
        <input
          autoFocus
          aria-label="Search Box Yard"
          autoComplete="off"
          spellCheck={false}
          defaultValue={early.current}
          onChange={(e) => (early.current = e.target.value)}
          placeholder={paletteHint(narrow)}
          className={PALETTE_INPUT}
        />
        <PaletteDismiss onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 p-2">
        <Loading kind="rows" label="Loading search" className="px-2.5 py-3" />
      </div>
    </>
  )
}

// Most visits never open it, so it stays out of the background warm-up: the first opening, or a 🔍 pointed at, fetches it.
const Palette = lazyPart<PaletteProps>(() => import("./Palette").then((m) => m.Palette), {
  Loading: PaletteLoading,
  Failed: () => (
    <div className="p-4">
      <LoadFailed />
    </div>
  ),
  warm: false,
})
