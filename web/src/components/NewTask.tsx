// "New task": a button that opens a small popover anchored to it (a bottom sheet on phones) with one textarea.
// Enter starts the task, titled from its prompt; "More options" opens the full dialog (title, agent, model, effort, files,
// env vars) with the text in it. Esc, a click outside or More options keep the draft (lib/newTask.ts). The command
// palette's "New task…" opens the full dialog itself (CommandPalette.tsx).
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { AlertTriangle, ChevronDown, ChevronUp, FileText, KeyRound, Laptop, Loader2, Paperclip, Plus, ShieldAlert, SlidersHorizontal, X } from "lucide-react"
import { newClientId, useAgentSettings, useCreateTask, useModels, useProjects, useSettings } from "../lib/queries"
import { clearNewTaskDraft, draftScope, loadDraft, newTaskDraftKey, saveDraft } from "../lib/newTask"
import { attachFiles, draftAttachments, filesHold, removeFile, retryFile, useDraft, useDraftKey } from "../lib/composerDraft"
import { primeSendSound } from "../lib/sendSound"
import { startTaskChord } from "../lib/shortcuts"
import { isMac } from "../lib/useDictation"
import { EFFORT_LABEL, findModel } from "../../../shared/models"
import { EffortPicker, ModelPicker } from "./ModelPicker"
import { OpenCodeModelInput } from "./OpenCodeModelInput"
import { CursorModelSelect } from "./CursorModelSelect"
import { titleFromPrompt } from "../../../shared/taskTitle"
import { type Effort, type Project } from "../../../shared/types"
import { LOCAL_UNSANDBOXED, RUNNER_LABEL, RUNNER_PHRASE, type Runner } from "../../../shared/runner"
import { AGENT_CLIS, AGENT_CLI_LABEL, hasSeparateEffort, CODEX_MODEL_SUGGESTIONS, DEFAULT_AGENT_CLI, type AgentCli } from "../../../shared/agentCli"
import { Modal, focusables } from "./Modal"
import { Kbd } from "./Kbd"
import { formatSize } from "./Attachments"
import { ComposerAttachments } from "./ComposerAttachments"
import { Button, Field, LineIcon, Select, TAP_AREA, cx, inputClass, parseEnv } from "./ui"

/** Below Tailwind's `sm`: the popover is a bottom sheet. */
const NARROW = "(max-width: 639.98px)"
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia?.(NARROW)
  mq?.addEventListener("change", cb)
  return () => mq?.removeEventListener("change", cb)
}
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false
export const useNarrow = () => useSyncExternalStore(subscribeNarrow, isNarrow, () => false)

/** Popover width (26rem) and its gap to the trigger and the window edges. */
const WIDTH = 416
const GAP = 6
const EDGE = 8

export function NewTaskButton({
  projectId,
  defaultProjectId,
  open: openProp,
  onOpenChange,
  variant = "primary",
  size,
  className,
  children,
}: {
  /** The project the task goes to. Without it the popover has a project picker. */
  projectId?: string
  /** The picker's first choice when there's no `projectId` (e.g. the Yard's project filter); else the first project. */
  defaultProjectId?: string | null
  /** Controlled open state, for a parent that opens it itself. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: "primary" | "subtle" | "ghost"
  size?: "sm" | "md"
  className?: string
  children?: ReactNode
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const setOpen = (next: boolean) => {
    setOwnOpen(next)
    onOpenChange?.(next)
  }
  const [dialog, setDialog] = useState<{ projectId: string; prompt: string } | null>(null)
  const id = useId()
  const scope = draftScope(projectId)

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {children ?? (
          <>
            <Plus className="h-4 w-4" /> New task
          </>
        )}
      </Button>
      {open && (
        <NewTaskPopover
          id={id}
          trigger={trigger}
          projectId={projectId}
          defaultProjectId={defaultProjectId}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) trigger.current?.focus()
          }}
          onMore={(target, prompt) => {
            // Focus the trigger first: the dialog returns focus to whatever had it when it opened.
            trigger.current?.focus()
            setOpen(false)
            setDialog({ projectId: target, prompt })
          }}
        />
      )}
      {dialog && (
        <NewTaskDialog
          projectId={dialog.projectId}
          initialPrompt={dialog.prompt}
          draftKey={newTaskDraftKey(scope)}
          onCancel={(prompt) => {
            saveDraft(scope, prompt)
            setDialog(null)
          }}
          onDone={() => {
            clearNewTaskDraft(scope)
            setDialog(null)
          }}
        />
      )}
    </>
  )
}

/**
 * The popover itself. NewTaskButton opens it on a project; SelectionToTask opens it on selected output with
 * `quote`, its own draft `scope` and `onStart`, which then gets the text instead of a task being created here.
 */
export function NewTaskPopover({
  id,
  trigger,
  projectId,
  defaultProjectId,
  heading = "New task",
  quote,
  placeholder = "What should the agent do?",
  submitLabel = "Start task",
  moreLabel = "More options",
  scope: scopeProp,
  align = "end",
  onStart,
  onClose,
  onMore,
}: {
  id: string
  /** What it hangs from; a press on it is not a click outside. */
  trigger: RefObject<HTMLElement | null>
  projectId?: string
  defaultProjectId?: string | null
  heading?: string
  /** Selected text shown above the textarea as a short preview. */
  quote?: string
  placeholder?: string
  /** The submit button, when `onStart` does something other than start a task here ("Send to the Coordinator"). */
  submitLabel?: string
  /** The way to the full dialog, which then says what it does instead ("Start it myself…"). */
  moreLabel?: string
  /** Where the draft is kept; defaults to the project's. */
  scope?: string
  /** "end": its right edge on the trigger's (a header button); "center": centred under it (a selection). */
  align?: Align
  /** Takes the (possibly empty) text instead of creating a task; there's no project picker then. */
  onStart?: (text: string) => void
  /** `refocus`: put focus back on the trigger (Esc, the close button); not after a click elsewhere. */
  onClose: (refocus: boolean) => void
  onMore: (projectId: string, prompt: string) => void
}) {
  const narrow = useNarrow()
  const scope = scopeProp ?? draftScope(projectId)
  const [text, setText] = useState(() => loadDraft(scope))
  // Files attached in the full dialog stay with the draft (shown here, and sent with the task).
  const key = newTaskDraftKey(scope)
  const files = useDraft(key).files
  const held = filesHold(files)
  const projects = useProjects().data ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const target =
    projectId ?? [picked, defaultProjectId].find((p) => p && projects.some((x) => x.id === p)) ?? projects[0]?.id ?? ""
  const project = projects.find((p) => p.id === target)
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const input = useRef<HTMLTextAreaElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const labelId = `${id}-label`

  useEffect(() => saveDraft(scope, text), [scope, text])

  useAutoGrow(input, text, narrow)

  // A press anywhere outside closes it (the trigger toggles it itself). The sheet's backdrop does this on phones.
  useEffect(() => {
    if (narrow) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current(false)
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [narrow, trigger])

  const pos = useAnchor(trigger, panel, !narrow, align)

  // Focus the text with the caret after a kept draft.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [narrow])

  const submit = () => {
    const prompt = text.trim()
    primeSendSound()
    if (onStart) {
      clearNewTaskDraft(scope)
      onClose(false)
      return onStart(prompt)
    }
    if (!prompt || !target || held) return
    const taskId = newClientId("task")
    const attachments = draftAttachments(files).map((a) => a.id)
    create.mutate({ id: taskId, projectId: target, title: titleFromPrompt(prompt), prompt, ...(attachments.length && { attachments }) })
    clearNewTaskDraft(scope)
    onClose(false)
    navigate(`/tasks/${taskId}`)
  }

  const form = (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {quote && <SelectionQuote text={quote} />}
      {files.length > 0 && (
        <div className="-mx-3 -mt-3">
          <ComposerAttachments files={files} onRemove={(f) => removeFile(key, f)} onRetry={(f) => retryFile(key, f)} />
        </div>
      )}
      <textarea
        ref={input}
        rows={3}
        value={text}
        aria-labelledby={labelId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        // Enter sends it, so a phone's keyboard says so, and a screen reader (the hint beside the heading is drawn only).
        enterKeyHint="send"
        aria-description={`Enter to ${onStart ? "send" : "start"}, Shift+Enter for a new line`}
        className={cx(inputClass, GROWS)}
      />
      {/* Wraps when a long label doesn't fit beside the other button; the tap areas keep 44px on a touch screen. */}
      <div className="flex flex-wrap items-center justify-end gap-2 pointer-coarse:min-h-11 pointer-coarse:gap-y-4">
        {!projectId && !onStart && (
          <Select size="sm" aria-label="Project" className="w-0 min-w-0 flex-1 sm:max-w-[13rem]" value={target} onChange={(e) => setPicked(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <button
          type="button"
          disabled={!target && !onStart}
          onClick={() => onMore(target, text)}
          className={cx(
            TAP_AREA,
            "mr-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs whitespace-nowrap text-zinc-500 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none disabled:opacity-50 sm:min-h-0 sm:py-1",
            (projectId || onStart) && "-ml-1.5",
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> {moreLabel}
        </button>
        <Button type="submit" variant="primary" size="sm" title={submitLabel} className={cx(TAP_AREA, "max-w-full")} disabled={onStart ? false : !text.trim() || !target || held}>
          <span className="min-w-0 truncate">{submitLabel}</span>
        </Button>
      </div>
    </form>
  )

  if (narrow)
    return (
      <Modal placement="sheet" title={<span id={labelId}>{heading}</span>} description={projectId ? project?.name : undefined} onClose={() => onClose(true)} bodyClassName="px-4 pt-3 pb-4">
        {form}
      </Modal>
    )

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-labelledby={labelId}
      tabIndex={-1}
      style={pos}
      onKeyDown={(e) => trapKeys(e, panel.current, () => onClose(true))}
      className="fixed z-40 flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl shadow-black/50 focus:outline-none"
    >
      <div className="mb-2 flex items-baseline gap-3 px-0.5">
        <h2 id={labelId} className="min-w-0 truncate text-sm font-medium text-zinc-200">
          {heading}
          {projectId && project && <span className="font-normal text-zinc-500"> in {project.name}</span>}
        </h2>
        <span className="ml-auto shrink-0 text-[11px] text-zinc-500" aria-hidden>
          <Kbd>↵</Kbd> {onStart ? "send" : "start"} · <Kbd>Shift</Kbd>
          <Kbd>↵</Kbd> new line
        </span>
      </div>
      {form}
    </div>,
    document.body,
  )
}

/** A short one-paragraph preview of selected text; the task still gets all of it. */
export function quotePreview(text: string, max = 240) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/**
 * Selected text as a read-only preview above the box for instructions (the popover's, and the full dialog's): three
 * lines of it, and "Show all" for the rest when there is more, which then scrolls inside its own box.
 */
function SelectionQuote({ text }: { text: string }) {
  const preview = quotePreview(text)
  const id = useId()
  const clamp = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  // Its three lines cut it short (the preview's own cut, the "…", is known without measuring).
  const [clamped, setClamped] = useState(false)
  useLayoutEffect(() => {
    const el = clamp.current
    if (!el) return
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === "undefined") return
    const seen = new ResizeObserver(check)
    seen.observe(el)
    return () => seen.disconnect()
  }, [preview, open])
  const more = open || clamped || preview !== quotePreview(text, Infinity)
  return (
    <div className="rounded-lg border border-zinc-800 border-l-2 border-l-yard-500/60 bg-zinc-900/60 px-3 py-2 text-xs leading-5 wrap-anywhere text-zinc-400">
      <blockquote id={id} data-testid="selection-quote" aria-label="Selected text">
        {open ? (
          <div tabIndex={0} className="scroll-thin max-h-48 overflow-y-auto whitespace-pre-wrap">
            {text.trim()}
          </div>
        ) : (
          // Clamped inside the padding, or a fourth line peeks out under the third.
          <span ref={clamp} className="line-clamp-3">
            {preview}
          </span>
        )}
      </blockquote>
      {more && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="-mb-2 flex min-h-11 items-center font-medium text-zinc-300 hover:text-zinc-100 pointer-fine:min-h-8"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  )
}

/** A textarea that grows with its text (useAutoGrow) instead of being dragged taller. */
const GROWS = "scroll-thin block resize-none overflow-y-hidden leading-6 sm:leading-5"

/** Grow with the text up to 40% of the window, then scroll inside. `layout`: what else changes the box's width. */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, text: string, layout?: unknown) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const max = Math.min(360, Math.max(120, Math.round(window.innerHeight * 0.4)))
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden"
  }, [ref, text, layout])
}

/** Esc closes; Tab and Shift+Tab stay inside the panel. */
export function trapKeys(e: ReactKeyboardEvent, root: HTMLElement | null, close: () => void) {
  if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    return close()
  }
  if (e.key !== "Tab" || !root) return
  const items = focusables(root)
  if (!items.length) return
  const first = items[0]!
  const last = items.at(-1)!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

export type Align = "end" | "center"

/**
 * Fixed-position style that puts the panel under the trigger, its right edge on the trigger's (or its left edge
 * on the trigger's when there's no room to the left; or centred on it), inside the window, and above the trigger
 * when there's more room there. Follows scrolling and resizes.
 */
export function useAnchor(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, on: boolean, align: Align): CSSProperties {
  // Placed from the first render: a hidden panel couldn't take focus.
  const [style, setStyle] = useState<CSSProperties>(() => anchorStyle(trigger.current, 0, align))
  useLayoutEffect(() => {
    if (!on) return
    const place = () => setStyle(anchorStyle(trigger.current, panel.current?.offsetHeight ?? 0, align))
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    // What's in it grows (a quote shown in full, a long prompt): it may then fit above only.
    const grown = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place)
    if (panel.current) grown?.observe(panel.current)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
      grown?.disconnect()
    }
  }, [on, trigger, panel, align])
  return style
}

function anchorStyle(trigger: HTMLElement | null, height: number, align: Align): CSSProperties {
  const vw = document.documentElement.clientWidth || window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(WIDTH, vw - 2 * EDGE)
  const t = trigger?.getBoundingClientRect() ?? { left: vw - EDGE - width, right: vw - EDGE, top: EDGE, bottom: EDGE }
  let left = align === "center" ? t.left + (t.right - t.left - width) / 2 : t.right - width
  if (left < EDGE && align === "end") left = t.left
  left = Math.max(EDGE, Math.min(left, vw - EDGE - width))
  const below = vh - t.bottom - GAP - EDGE
  const above = t.top - GAP - EDGE
  return height > below && above > below
    ? { left, width, bottom: vh - t.top + GAP, maxHeight: above }
    : { left, width, top: t.bottom + GAP, maxHeight: Math.max(below, 160) }
}

/**
 * The full New task form: the prompt, an optional title (made from the prompt when blank), and the options the
 * popover leaves out: agent, model, effort and "Run on this computer" (folded into one line that says what the task
 * runs with), files and env vars. ⌘↵ / Ctrl+Enter starts it from any field. `onCancel` gets the prompt so the
 * popover's draft keeps it.
 */
export function NewTaskDialog({
  projectId: projectProp,
  defaultProjectId,
  initialPrompt = "",
  quote,
  compose,
  draftKey,
  onCancel,
  onDone,
}: {
  /** Without one the dialog has a project picker, starting on `defaultProjectId`, else the first project in the saved order. */
  projectId?: string | null
  /** The picker's first choice (the command palette: the project in view). */
  defaultProjectId?: string | null
  initialPrompt?: string
  /** Selected text the task is about, shown read-only above the prompt, which then holds only the instructions (optional). */
  quote?: string
  /** The task's prompt from what's in the box, when more goes with it (a selection's quote and where it came from). */
  compose?: (text: string) => string
  /** The draft its files are kept in (lib/composerDraft.ts), so Cancel keeps them with the popover's text. Without it, they go with the dialog. */
  draftKey?: string
  onCancel: (prompt: string) => void
  onDone: () => void
}) {
  const create = useCreateTask()
  const [, navigate] = useLocation()
  const loaded = useProjects().data
  const projects = loaded ?? []
  const [picked, setPicked] = useState("")
  const projectId = projectProp || [picked, defaultProjectId].find((id) => id && projects.some((p) => p.id === id)) || projects[0]?.id || ""
  const project: Project | undefined = projects.find((p) => p.id === projectId)
  const settings = useAgentSettings().data?.settings
  const maxMb = useSettings().data?.maxUploadMb ?? 20
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState(initialPrompt)
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<Effort | "">("")
  const key = useDraftKey(draftKey)
  const files = useDraft(key).files
  // What it opened with (a kept draft's text and files) isn't a change to lose.
  const [initialFiles] = useState(files.length)
  const [env, setEnv] = useState("")
  const [showEnv, setShowEnv] = useState(false)
  // Starts on the project's "Runs on"; flipping it pins this task to the other runner (Task.runsOn).
  const projectRunner: Runner = project?.runner ?? "box"
  const [runner, setRunner] = useState<Runner | null>(null)
  const runsOn = runner ?? projectRunner
  // Starts on the project's Agent (else Settings › Box agents); picking the other one pins this task to it for good.
  const projectCli: AgentCli = project?.agentCli ?? settings?.agentCli ?? DEFAULT_AGENT_CLI
  const [cli, setCli] = useState<AgentCli | "">("")
  const agentCli = cli || projectCli
  const picker = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const models = useModels()
  const mac = isMac()
  const optionsId = useId()
  // Folded until opened, or until one of its choices isn't the default any more. Open on a project that runs on this
  // computer, whose switch to a box is in there.
  const [optionsOpen, setOptionsOpen] = useState<boolean | null>(null)
  const showOptions = optionsOpen ?? Boolean(cli || model || effort || runsOn !== projectRunner || projectRunner === "local")
  const options = useRef<HTMLDivElement>(null)
  // Unfolded by hand: what opened comes into the dialog's view (a phone's is short).
  useEffect(() => {
    if (optionsOpen) options.current?.scrollIntoView({ block: "nearest" })
  }, [optionsOpen])

  // What the task runs with, in a line: the agent, its model as the picker names it and the effort; where it runs
  // follows it. It is the folded options' label, so a choice made there still shows.
  const modelName = (id: string) => (agentCli === "claude" ? (findModel(models, id)?.label ?? id) : id)
  const usedModel = model || (agentCli === "opencode" ? settings?.agentOpencodeModel : agentCli === "cursor" ? settings?.agentCursorModel : agentCli === "codex" ? settings?.agentCodexModel : settings?.agentModel)
  const usedEffort = hasSeparateEffort(agentCli) ? effort || (agentCli === "claude" && settings?.agentEffort !== "orchestrator" ? settings?.agentEffort : "") : ""
  const runsWith = [AGENT_CLI_LABEL[agentCli], usedModel ? modelName(usedModel) : "default model", usedEffort && EFFORT_LABEL[usedEffort]].filter(Boolean).join(" · ")
  const whyId = useId()
  const envId = useId()
  const envCount = Object.keys(parseEnv(env)).length

  // The prompt has the caret, after any text it opened with (the popover's, a kept draft's).
  useLayoutEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useAutoGrow(promptRef, prompt)

  const add = (picked: File[]) => attachFiles(key, picked, maxMb)

  const uploading = files.some((f) => f.status === "uploading")
  // A selection is a task without a word more.
  const canStart = Boolean(prompt.trim() || quote) && !uploading && Boolean(projectId)
  // What Start task waits for, said beside it.
  const why = loaded && !projectId ? "Create a project first." : !(prompt.trim() || quote) ? "Describe the task to start it." : uploading ? "Files are still uploading." : ""
  const autoTitle = prompt.trim() ? titleFromPrompt(prompt) : "Made from the prompt when blank"

  return (
    <Modal
      size="lg"
      // A phone gets it as tall as what's in it, from the bottom edge, as the popover's sheet is; up to the whole
      // screen, so a short phone's keyboard still leaves the prompt in view.
      placement="sheet"
      className="max-sm:max-h-dvh!"
      title={quote ? "New task from selection" : "New task"}
      // The picker already names the project.
      description={projectProp ? project?.name : undefined}
      dirty={Boolean(title || env) || prompt !== initialPrompt || files.length !== initialFiles}
      onClose={() => onCancel(prompt)}
      onKeyDown={(e) => {
        // ⌘↵ / Ctrl+Enter starts it from any field: Enter alone is a new line in the prompt.
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return
        e.preventDefault()
        ;(e.currentTarget as HTMLFormElement).requestSubmit()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        if (!canStart) return
        primeSendSound()
        const id = newClientId("task")
        const full = compose ? compose(prompt) : prompt.trim()
        create.mutate({
          id,
          projectId,
          title: title.trim() || titleFromPrompt(full),
          prompt: full,
          env: parseEnv(env),
          ...(model && { model }),
          ...(effort && hasSeparateEffort(agentCli) && { effort }),
          ...(runsOn !== projectRunner && { runsOn }),
          ...(agentCli !== projectCli && { agentCli }),
          attachments: draftAttachments(files).map((a) => a.id),
        })
        onDone()
        navigate(`/tasks/${id}`)
      }}
      footer={
        <>
          {/* A keyboard's hint, so not where the footer's buttons stack (a phone), nor while there's nothing to start. */}
          {!why && (
            <span aria-hidden className="mr-auto text-[11px] text-zinc-500 max-sm:hidden">
              <Kbd>{startTaskChord(mac)[0]}</Kbd>
              <Kbd>↵</Kbd> to start
            </span>
          )}
          <Button type="button" variant="ghost" onClick={() => onCancel(prompt)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canStart} aria-keyshortcuts={mac ? "Meta+Enter" : "Control+Enter"} aria-describedby={why ? whyId : undefined}>
            Start task
          </Button>
          {/* Last, so it is above the button where the footer stacks (bottom up); beside the buttons otherwise. */}
          {why && (
            <p id={whyId} className="text-xs text-zinc-400 max-sm:text-center sm:order-first sm:mr-auto">
              {why}
            </p>
          )}
        </>
      }
    >
      {!projectProp && (
        <Field label="Project">
          <Select className="w-full" value={projectId} onChange={(e) => setPicked(e.target.value)} data-testid="new-task-project">
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {quote && <SelectionQuote text={quote} />}
      <Field label="What should the agent do?" hint={quote ? "The task also gets the selected text in full, and where it came from." : undefined}>
        <textarea
          ref={promptRef}
          className={cx(inputClass, GROWS)}
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={quote ? "Additional instructions (optional)" : "Goal, constraints, and what done looks like."}
        />
      </Field>
      <Field label="Title (optional)">
        <input className={cx(inputClass, "text-ellipsis")} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle} />
      </Field>
      <div className="@container flex flex-col gap-4">
        <button
          type="button"
          data-testid="new-task-options"
          aria-expanded={showOptions}
          aria-controls={optionsId}
          onClick={() => setOptionsOpen(!showOptions)}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-sm hover:border-zinc-700"
        >
          <SlidersHorizontal aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 wrap-anywhere text-zinc-200">
            {/* Open, the fields under it say the agent, model and effort: the line keeps only where it runs. */}
            <span className="text-zinc-400">{showOptions ? "Runs on " : "Runs with "}</span>
            {!showOptions && `${runsWith} `}
            {/* One box, so the dot goes to the next line with what it leads (and a long name still wraps inside it). */}
            <span className="inline-block max-w-full">
              {!showOptions && "· "}
              {/* This computer has no sandbox, and says so in the warning's colour. */}
              <span data-testid="new-task-runs-on" className={cx(runsOn === "local" && "text-amber-200")}>
                {runsOn === "local" && <ShieldAlert aria-hidden className="mr-1 inline h-3.5 w-3.5 align-[-0.15em] text-amber-300" />}
                {showOptions ? RUNNER_PHRASE[runsOn] : RUNNER_LABEL[runsOn]}
              </span>
            </span>
          </span>
          {showOptions ? <ChevronUp aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" /> : <ChevronDown aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />}
        </button>
        {/* Hidden, not unmounted: a custom model ID's field stays as it was. */}
        <div ref={options} id={optionsId} hidden={!showOptions} className="flex flex-col gap-4">
          <div className="grid gap-4 @min-[36rem]:grid-cols-3">
            <Field label="Agent">
              <Select
                className="w-full"
                value={cli}
                onChange={(e) => {
                  setCli(e.target.value as AgentCli | "")
                  // Each agent has its own models.
                  setModel("")
                }}
                data-testid="new-task-agent-cli"
              >
                <option value="">Default ({AGENT_CLI_LABEL[projectCli]})</option>
                {AGENT_CLIS.map((c) => (
                  <option key={c} value={c}>
                    {AGENT_CLI_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model">
              {agentCli === "opencode" ? (
                <OpenCodeModelInput value={model} onChange={setModel} placeholder={`Default (${settings?.agentOpencodeModel || "OpenCode's default"})`} testId="new-task-model" />
              ) : agentCli === "cursor" ? (
                <CursorModelSelect id="new-task-cursor-model" compact value={model} onChange={setModel} defaultLabel={`Default (${settings?.agentCursorModel || "Cursor's default"})`} testId="new-task-model" />
              ) : agentCli === "codex" ? (
                <Select className="w-full" value={model} onChange={(e) => setModel(e.target.value)} data-testid="new-task-model">
                  <option value="">Default ({settings?.agentCodexModel || "Codex's default"})</option>
                  {CODEX_MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              ) : (
                <ModelPicker value={model} onChange={setModel} defaultLabel={`Default${settings?.agentModel ? ` (${modelName(settings.agentModel)})` : ""}`} testId="new-task-model" />
              )}
            </Field>
            <Field label="Effort">
              {agentCli === "opencode" ? (
                <Select className="w-full" value="" disabled data-testid="new-task-effort" title="Use provider/model#variant to select a provider-specific variant">
                  <option value="">Provider variant in model</option>
                </Select>
              ) : agentCli === "cursor" ? (
                // Cursor's model ids carry their effort (…-high, …-max): there's nothing to set apart from the model.
                <Select className="w-full" value="" disabled data-testid="new-task-effort" title="Cursor's model ids carry their effort (…-high, …-max)">
                  <option value="">In the model id</option>
                </Select>
              ) : (
                <EffortPicker
                  value={effort}
                  onChange={(v) => setEffort(v as Effort | "")}
                  model={model || (agentCli === "codex" ? settings?.agentCodexModel : settings?.agentModel) || ""}
                  effective={effort || (settings?.agentEffort !== "orchestrator" ? settings?.agentEffort : "") || ""}
                  lead={<option value="">Default{settings?.agentEffort ? ` (${settings.agentEffort === "orchestrator" ? "Coordinator decides" : EFFORT_LABEL[settings.agentEffort]})` : ""}</option>}
                  testId="new-task-effort"
                />
              )}
            </Field>
          </div>
          <RunHereToggle on={runsOn === "local"} projectLocal={projectRunner === "local"} onChange={(on) => setRunner(on ? "local" : projectRunner === "local" ? "box" : projectRunner)} />
        </div>
        {/* Said whether the options are folded or not. */}
        {runsOn === "local" && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
            <span>{LOCAL_UNSANDBOXED}</span>
          </p>
        )}
      </div>
      <div role="group" aria-label="Files" className="space-y-2">
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {files.map((f) => (
              <li
                key={f.key}
                title={f.error ?? `${f.name} · ${formatSize(f.size)}`}
                className={cx(
                  "inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-zinc-900 py-1 pr-1 pl-2 text-xs",
                  f.status === "error" ? "border-red-900/60 text-red-300" : "border-zinc-800 text-zinc-300",
                )}
              >
                {f.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : f.status === "error" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="shrink-0 text-zinc-600">{formatSize(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => removeFile(key, f.key)}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 pointer-fine:h-5 pointer-fine:w-5"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {files.some((f) => f.status === "error") && <p className="text-xs text-red-400">{files.find((f) => f.status === "error")!.error}</p>}
        <div className="flex flex-wrap items-center gap-x-4">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.target.files ?? []))
              e.target.value = ""
            }}
          />
          {/* 44px to a finger at any width; a mouse gets them as small as the text. */}
          <button type="button" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-zinc-300 hover:text-zinc-100 pointer-fine:min-h-6" onClick={() => picker.current?.click()}>
            <Paperclip className="h-3.5 w-3.5" /> Attach files
          </button>
          {/* Folding the field keeps what's in it, and the task still gets it: the button then says how many. */}
          <button
            type="button"
            aria-expanded={showEnv}
            aria-controls={showEnv ? envId : undefined}
            className="inline-flex min-h-11 items-center gap-1.5 text-xs whitespace-nowrap text-zinc-300 hover:text-zinc-100 pointer-fine:min-h-6"
            onClick={() => setShowEnv(!showEnv)}
          >
            <KeyRound className="h-3.5 w-3.5" /> {showEnv ? "Hide env vars" : envCount ? `Env vars (${envCount})` : "Env vars"}
          </button>
        </div>
      </div>
      {showEnv && (
        <div id={envId}>
          <Field label="Extra env vars for this task" hint="KEY=value per line; added to the project's env.">
            <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

/** "Run on this computer": this task only, over its project's "Runs on", in either direction. The dialog says what running here means (LOCAL_UNSANDBOXED). */
function RunHereToggle({ on, projectLocal, onChange }: { on: boolean; projectLocal: boolean; onChange: (on: boolean) => void }) {
  const hint = projectLocal
    ? on
      ? "This project runs on this computer. Turn this off to run this task in an Upstash box."
      : "Only this task runs in an Upstash box; the project runs on this computer."
    : on
      ? "Only this task runs on this computer; the project runs in Upstash boxes."
      : "This project runs in Upstash boxes. Turn this on to run this task here."
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-sm text-zinc-300">
      <input type="checkbox" className="h-5 w-5 shrink-0 accent-yard-500" checked={on} onChange={(e) => onChange(e.target.checked)} data-testid="new-task-local" />
      <span className="min-w-0">
        <span className="inline-flex items-center gap-1.5 text-zinc-200">
          <Laptop className="h-3.5 w-3.5 text-zinc-400" /> Run on this computer
        </span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  )
}
