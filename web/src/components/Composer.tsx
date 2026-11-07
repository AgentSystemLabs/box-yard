import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode, type RefObject, type Ref } from "react"
import { createPortal, flushSync } from "react-dom"
import { Clock, Maximize2, Minimize2, ArrowUpRight, Paperclip, Send, Square } from "lucide-react"
import { composerMaxHeight, isTouchDevice } from "../lib/composer"
import { useSettings } from "../lib/queries"
import { Button, cx } from "./ui"
import { ComposerAttachments } from "./ComposerAttachments"
import { DictationStatus, MicButton } from "./Dictation"
import { insertTranscript } from "../lib/dictation"
import { useDictation } from "../lib/useDictation"
import { primeSendSound } from "../lib/sendSound"
import { browseStep, readHistory, rememberPrompt, type Browse } from "../lib/promptHistory"
import { attachFiles, draftAttachments, EMPTY_DRAFT, prependDraft, readDraft, releaseFiles, removeFile, retryFile, setDraftFiles, setDraftText, useDraft, useDraftKey, writeDraft } from "../lib/composerDraft"
import { registerTakeBack, type TakeBackBox } from "../lib/takeBack"
import { PickButtons, PickConflict, PickMenuItems, PickScope, RunTargetList, RunTargetPanel, useChatPicks, type ChatPicks } from "./RunTargetMenu"
import { ComposerMenuItem, MoreButton, MoreMenu, useMoreMenu, type MoreDot } from "./ComposerMenu"
import { foldPlan, inMenu, onRow } from "../lib/composerRow"
import type { Attachment } from "../../../shared/types"
import { connectionState, useConnectionLive } from "../lib/connection"
import { SendToMenu, SendToNote, sendToHint, useSendTo } from "./SendToMenu"
import { ConnectionLine } from "./ConnectionLine"
import { ComposerTags } from "./ComposerTags"
import { tagsIn, type TextTag } from "../../../shared/runTargets"
import { GithubReferenceMenu, useGithubReferences } from "./GithubReferenceMenu"

/** What a send carries besides text and files: the "@" and "!" picks of where its tasks run and on which harness, and the Coordinator's "%" project (shared/runTargets.ts). */
export type ComposerExtra = ChatPicks

/** Lets a parent put text in the box (an example prompt) without owning the draft. */
export interface ComposerHandle {
  /** Replace the draft with `text` and focus the box, selecting `select` (e.g. a placeholder) if it's in the text. */
  fill(text: string, select?: string): void
  /** Send the draft as Enter would (a hint's one-tap "send it there" after the parent switched its target). */
  submit(): void
  clearSendTo(): void
}

/**
 * The bar a Composer sits in at the bottom of a chat: top border, padding and the safe-area inset. Every chat
 * (Coordinator, Captain tab, task page) uses it, so their composers line up when shown side by side; add only
 * horizontal spacing or a top margin to it.
 */
export const COMPOSER_FOOTER =
  "sticky bottom-0 z-10 border-t border-zinc-900 bg-zinc-950/95 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur"

/** The text's size and line height, at either container width. */
const LINE = "text-base leading-6 @min-[32rem]/composer:text-sm @min-[32rem]/composer:leading-5"
/** The first line's offset; the `icon` slot takes it too, so the icon sits on that line. */
const TEXT_TOP = "pt-3 @min-[32rem]/composer:pt-2.5"
/** The text's box metrics, shared by the textarea and the history ghost drawn over it: one slim line at rest, in every chat. */
const TEXT = `px-3 pb-1 ${TEXT_TOP} ${LINE}`

/**
 * A button on the row: 44px (a finger's size) below 32rem, where lib/composerRow.ts counts it as one slot; a mouse gets
 * 32px from there. Tools passed in (Pull requests) match it.
 */
const TOOL = "h-11 w-11 shrink-0 !p-0 pointer-fine:@min-[32rem]/composer:h-8 pointer-fine:@min-[32rem]/composer:w-8"

const NO_TAGS: TextTag[] = []

/**
 * The message box shared by the orchestrator chat and task threads: Enter
 * sends, Shift+Enter adds a line, files can be picked, dropped or pasted.
 * `onSubmit` gets the text and the uploaded files; the box then clears itself.
 * If it returns the send's promise, a failed send puts the text and files back (focus
 * never left), and a successful one on a touch device blurs the box to close the keyboard.
 * While the server's live stream is down, a send stays in the box and goes once it's back (ConnectionLine).
 * With a `historyKey`, Up in the empty box shows the prompts sent from it (lib/promptHistory.ts), and a queued
 * message's Cancel puts the message back in its draft (lib/takeBack.ts).
 * With `stop` (a turn is running), a Stop button before Send ends that turn.
 * With `runTargets` (the Coordinator's and Captains' chats), "@" and "!" open the lists of where tasks run and which
 * harness runs them, and in the Coordinator's "%" the list of projects; the Where, Harness and Project buttons in the
 * row put that trigger in the text and open the shared picker (RunTargetMenu.tsx), with Where and Harness in a sheet.
 * The picks stay in the text and go to
 * `onSubmit` as `extra.runsOn`, `extra.agent` and `extra.project`, and while the draft names one its tag is drawn in colour
 * (ComposerTags.tsx).
 * The draft lives in lib/composerDraft.ts under `draftKey` (else `historyKey`), not in the parent, so typing re-renders
 * only this box and never the (long) message list next to it. Kept there per target, it outlives the box: leave the
 * chat and come back, and the text and files (uploads still going included) are as they were. A send clears it.
 */
export function Composer({
  onSubmit,
  placeholder,
  label,
  className = cx(COMPOSER_FOOTER, "px-3"),
  textareaRef,
  panelRef,
  handleRef,
  historyKey,
  draftKey,
  files: allowFiles = true,
  tools,
  toolsMenu,
  toolSlots,
  toolsDot,
  target,
  icon,
  hint,
  runTargets = false,
  runTargetsProject = null,
  githubProject = runTargetsProject,
  stop = null,
  onDestinationPick,
}: {
  onDestinationPick?: () => void
  onSubmit: (text: string, attachments: Attachment[], extra?: ComposerExtra) => void | Promise<unknown>
  placeholder: string
  label?: string
  className?: string
  textareaRef?: Ref<HTMLTextAreaElement>
  handleRef?: Ref<ComposerHandle>
  /** The panel that accepts dropped files, message list included. It must be `relative`. */
  panelRef: RefObject<HTMLElement | null>
  /** Whose sent prompts Up/Down walk through ("coordinator", "captain:<projectId>", "task:<taskId>"). */
  historyKey?: string
  /**
   * Whose draft the box shows and keeps (lib/composerDraft.ts): its target, e.g. "coordinator", "captain:<projectId>",
   * "task:<taskId>", "thread:<threadId>". Defaults to `historyKey`; without either, the draft goes with the box.
   * Changing it swaps the box to that target's draft.
   */
  draftKey?: string
  /** false: text only (a side thread): no attach button, and pasted or dropped files are left alone. */
  files?: boolean
  /** Controls after the mic. */
  tools?: ReactNode
  /**
   * The same tools as More menu lines (ComposerMenuItem). With it, the tools fold into the menu when the box is too
   * narrow for them (lib/composerRow.ts); without it, they always stay on the row.
   */
  toolsMenu?: ReactNode
  /** How many 44px buttons wide the tools are on a narrow box (default 1 when there are tools). */
  toolSlots?: number
  /** A tool's dot (a side question's new answer), on the More button while the tools are folded into it. */
  toolsDot?: MoreDot | null
  /** Accessible target icon/control, inset beside the text; callers supply its label. */
  target?: ReactNode
  /**
   * Who the box messages (ChatIcons.tsx's ComposerIcon), at the text's leading edge on its first line. Unlike `target`
   * it adds no height: the text only starts after it. A press on it puts the caret in the text.
   */
  icon?: ReactNode
  /** A line above the buttons that depends on the draft (a task's "send this to the Captain?"). Called on every keystroke, so keep it cheap. */
  hint?: (draft: string) => ReactNode
  /** "@" (or the Where button) picks where the message's tasks run, "!" (or the Harness button) their agent CLI: the Coordinator's and Captains' chats only. */
  runTargets?: boolean
  /** Whose lists: a project's Captain (its identity may rule runners out), or null for the Coordinator. */
  runTargetsProject?: string | null
  /** Current task/thread's project; the Coordinator uses its % project pick. */
  githubProject?: string | null
  /** While a turn runs: Stop, before Send, ends it (the task's agent, the Coordinator or a Captain). `label` says whose. */
  stop?: { label: string; onStop: () => void } | null
}) {
  // The same slim box with a target or an icon: the text only moves over for it.
  const textMetrics = cx(TEXT, target || icon ? "pl-11" : null)
  // A box without a target has nobody to come back to it: its draft goes with it.
  const key = useDraftKey(draftKey ?? historyKey)
  const keyRef = useRef(key)
  keyRef.current = key
  const { text: value, files } = useDraft(key)
  const setValue = useCallback((next: string | ((prev: string) => string)) => setDraftText(keyRef.current, next), [])
  // An older prompt shown as a gray ghost while browsing with Up/Down; the value stays empty until Enter takes it.
  const [browse, setBrowse] = useState<Browse>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const overflowingRef = useRef(overflowing)
  overflowingRef.current = overflowing
  const [expanded, setExpanded] = useState(false)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const maxMb = useSettings().data?.maxUploadMb ?? 20
  const boxRef = useRef<HTMLDivElement>(null)
  const sendTo = useSendTo({ enabled: /^(coordinator$|captain:|task:)/.test(key), draftKey: key, value, setValue, input, onPick: onDestinationPick })
  const picks = useChatPicks({ enabled: runTargets, projectId: runTargetsProject, value, setValue, input })
  const github = useGithubReferences({ projectId: githubProject ?? picks.picked.project?.value ?? null, draftKey: key, value, setValue, input, blocked: picks.open || sendTo.open })
  // The "%project", "@runner" and "!harness" words the lists name. While there's one, the textarea's text is
  // transparent and ComposerTags draws it under the textarea, tags in colour.
  const tags = useMemo(() => {
    if (!runTargets) return NO_TAGS
    const found = tagsIn(value, picks.lists)
    // A pick that's only its item's (the scope line's "Only their part") is underlined, dashed like its chip there.
    const partial = new Set(picks.scoped.filter((p) => p.scope === "inline").map((p) => `${p.kind}:${p.start}`))
    return partial.size ? found.map((t) => (partial.has(`${t.kind}:${t.start}`) ? { ...t, partial: true } : t)) : found
  }, [runTargets, value, picks.lists, picks.scoped])
  const tinted = tags.length > 0
  const more = useMoreMenu()
  // Which buttons fold into More below which box width, from the ones this box has now (lib/composerRow.ts).
  const showExpand = overflowing || expanded
  const toolWidth = tools ? (toolSlots ?? 1) : 0
  const fold = foldPlan({
    fixed: 2 + (stop ? 1 : 0) + (toolsMenu ? 0 : toolWidth),
    picks: runTargets ? picks.kinds.length : 0,
    expand: showExpand ? 1 : 0,
    tools: toolsMenu ? toolWidth : 0,
    attach: (allowFiles ? 1 : 0) + (sendTo.enabled ? 1 : 0),
  }, { toolsLast: sendTo.enabled })

  // Uploads run in the draft store, so they finish (or fail, with Retry) while the box is away.
  const add = (picked: File[]) => attachFiles(key, picked, maxMb)
  const retry = (fileKey: number) => retryFile(key, fileKey)
  const remove = (fileKey: number) => removeFile(key, fileKey)

  const uploading = files.some((f) => f.status === "uploading")
  // A failed file holds the send (the tray says so), rather than the message going without it.
  const failed = files.some((f) => f.status === "error")
  const ready = draftAttachments(files)
  // Picks that can't go together (Codex on an SSH machine) wait for a fix; the line over the buttons says why.
  const canSend = !sendTo.open && !uploading && !failed && !picks.conflict && Boolean(value.trim() || ready.length)

  const setTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      input.current = el
      if (typeof textareaRef === "function") textareaRef(el)
      else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = el
    },
    [textareaRef],
  )

  // The empty box's height at its current width (0 until measured): a box that short has no room to shrink.
  const floor = useRef(0)

  // Grow the box with its text up to a cap, then scroll inside it. Runs on every value change
  // (typing, paste, draft restore, clearing after send), when attachments change and on resize.
  // `grow`: the box can't need to get shorter, so check without resetting its height. That reads the layout the next
  // frame needs anyway and writes nothing while the text fits, where a full measure costs two extra layouts and style
  // recalcs on every key.
  const resize = useCallback((grow = false) => {
    const el = input.current
    const row = el?.parentElement
    if (!el || !row) return
    const max = composerMaxHeight(window.visualViewport?.height ?? window.innerHeight, expanded)
    let full: number
    if (grow) {
      full = el.scrollHeight
      if (full <= el.clientHeight) return
      // Already capped and scrolling: the height stays, and typing at the end stays in view (its padding too).
      if (el.clientHeight >= max && el.style.overflowY === "auto") {
        if (document.activeElement === el && el.selectionEnd === el.value.length) el.scrollTop = full
        return
      }
      el.style.height = `${Math.min(full, max)}px`
    } else {
      // Hold the row's height while measuring so the panel (and the message list scroll) doesn't move.
      row.style.minHeight = `${row.offsetHeight}px`
      el.style.height = "auto"
      // A ghost prompt sizes the box like real text would, so a long one shows in full.
      full = Math.max(el.scrollHeight, ghost.current?.scrollHeight ?? 0)
      if (!el.value && !ghost.current) floor.current = full
      el.style.height = `${Math.min(full, max)}px`
      row.style.minHeight = ""
    }
    const over = full > max
    el.style.overflowY = over ? "auto" : "hidden"
    // Only on a change: a same-value setState from a layout effect still costs an extra commit per keystroke.
    if (over !== overflowingRef.current) setOverflowing(over)
    // Typing or pasting at the end of a capped box: keep the caret in view.
    if (over && document.activeElement === el && el.selectionEnd === el.value.length) el.scrollTop = el.scrollHeight
  }, [expanded])

  useLayoutEffect(() => resize(), [resize, files.length, browse])
  // Text added at the end can't take a line away, and a box at its floor can't shrink: either way it can only grow.
  const measured = useRef(value)
  useLayoutEffect(() => {
    const before = measured.current
    if (value === before) return
    measured.current = value
    resize(value.startsWith(before) || (input.current?.clientHeight ?? 0) <= floor.current)
  }, [resize, value])

  // Anything that puts text in the box (typing, paste, dictation, an example prompt) ends browsing, and so
  // does another chat's history. Only while browsing: a same-value setState right after a keystroke's render
  // still costs a commit.
  useEffect(() => {
    if (value && browse) setBrowse(null)
  }, [value, browse])
  useEffect(() => setBrowse(null), [historyKey])

  useEffect(() => {
    const el = input.current
    if (!el) return
    // Width changes (window or panel resize) rewrap the text, so re-measure.
    let width = el.offsetWidth
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width) return
      width = el.offsetWidth
      // The container's width picks the text size, so the empty box's height is measured again.
      floor.current = 0
      resize()
    })
    ro.observe(el)
    const remeasure = () => resize()
    window.addEventListener("resize", remeasure)
    window.visualViewport?.addEventListener("resize", remeasure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", remeasure)
      window.visualViewport?.removeEventListener("resize", remeasure)
    }
  }, [resize])

  // An emptied box (after sending) goes back to its normal size.
  useEffect(() => {
    if (!value) setExpanded(false)
  }, [value])

  // Sent while the live stream is down: it waits in the box (Send now tries anyway) instead of failing.
  const [held, setHeld] = useState(false)
  const live = useConnectionLive()
  const submit = (now = false) => {
    // Still listening: stop, let the last words land, then send (dictation calls submit again).
    if (dictation.active) return dictation.stopAndSend()
    if (!canSend) return
    // Inside the tap or key press, so the "sent" cue may play when the server accepts it.
    primeSendSound()
    if (!now && !connectionState().live) return setHeld(true)
    setHeld(false)
    const text = value.trim()
    const sent = files
    const destination = sendTo.chosen ?? undefined
    // A failed send goes back to the draft it came from, even if the box has moved on to another chat or closed.
    const from = key
    const extra = picks.extra()
    more.close()
    const pending = sendTo.chosen ? sendTo.send(text, ready, extra) : Object.keys(extra).length ? onSubmit(text, ready, extra) : onSubmit(text, ready)
    writeDraft(from, EMPTY_DRAFT)
    const done = () => releaseFiles(sent)
    if (!pending) {
      rememberPrompt(historyKey, text)
      return done()
    }
    pending.then(
      () => {
        done()
        rememberPrompt(historyKey, text)
        // The on-screen keyboard closes; the list (pinned by the send) follows the viewport as it grows.
        if (isTouchDevice() && input.current && document.activeElement === input.current) input.current.blur()
      },
      // Back in the box, unless something new was typed meanwhile.
      () => {
        writeDraft(from, (draft) => draft.text ? draft : { ...draft, text: value, destination: draft.destination ?? destination })
        if (readDraft(from).files.length) done()
        else setDraftFiles(from, sent)
      },
    )
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  // Back: a held message goes, as the box has it now. An emptied box holds nothing.
  useEffect(() => {
    if (held && live && canSend) submitRef.current(true)
  }, [held, live, canSend])
  useEffect(() => {
    if (held && !value.trim() && !files.length) setHeld(false)
  }, [held, value, files.length])
  // Another chat's draft never goes in a held message's place: it stays in the draft it was written in.
  useEffect(() => setHeld(false), [key])

  // Dictation: final words go into the draft at the caret. flushSync makes the new value (and a fresh
  // `submit`) current at once, so "send when I release" right after sees every word.
  const form = useRef<HTMLFormElement>(null)
  const dictation = useDictation({
    root: () => form.current,
    focus: () => input.current?.focus(),
    insert: (text) => {
      const el = input.current
      if (!el) return
      const next = insertTranscript(el.value, el.selectionStart, el.selectionEnd, text)
      if (next.value === el.value) return
      flushSync(() => setValue(next.value))
      el.setSelectionRange(next.caret, next.caret)
    },
    send: () => submitRef.current(),
  })

  const clearSendTo = useRef(sendTo.clear)
  clearSendTo.current = sendTo.clear
  useImperativeHandle(
    handleRef,
    () => ({
      fill: (text, select) => {
        flushSync(() => setValue(text))
        const el = input.current
        if (!el) return
        el.focus()
        const at = select ? text.indexOf(select) : -1
        if (at >= 0) el.setSelectionRange(at, at + select!.length)
        else el.setSelectionRange(text.length, text.length)
      },
      submit: () => submitRef.current(),
      clearSendTo: () => clearSendTo.current(),
    }),
    [],
  )

  // A queued message Cody cancels comes back here (lib/takeBack.ts), ahead of any draft, with its files.
  const take = useRef<TakeBackBox["take"]>(null!)
  take.current = (text, attachments) => {
    // Undo puts the box back as it was, unless Cody has changed it since.
    let undo!: () => void
    flushSync(() => {
      undo = prependDraft(keyRef.current, text, attachments)
    })
    const el = input.current
    el?.focus()
    el?.setSelectionRange(text.length, text.length)
    return undo
  }
  const targeted = Boolean(draftKey ?? historyKey)
  useEffect(() => {
    if (!targeted) return
    return registerTakeBack(key, { panel: () => panelRef.current, take: (text, attachments) => take.current(text, attachments) })
  }, [key, targeted, panelRef])

  const onPaste = (e: ClipboardEvent) => {
    if (!allowFiles) return
    const pasted = Array.from(e.clipboardData.files)
    if (!pasted.length) return
    e.preventDefault()
    add(pasted)
  }

  // Drop files anywhere on the panel. Window-level handlers stop a missed drop from opening the file in the tab.
  const addRef = useRef(add)
  addRef.current = add
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || !allowFiles) return
    const hasFiles = (e: globalThis.DragEvent) => Boolean(e.dataTransfer?.types?.includes("Files"))
    let depth = 0
    const enter = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      e.stopPropagation()
      depth++
      setDragging(true)
    }
    const leave = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return
      e.stopPropagation()
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const drop = (e: globalThis.DragEvent) => {
      depth = 0
      setDragging(false)
      const dropped = Array.from(e.dataTransfer?.files ?? [])
      if (!dropped.length) return
      e.preventDefault()
      e.stopPropagation()
      addRef.current(dropped)
    }
    const stray = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    panel.addEventListener("dragenter", enter)
    panel.addEventListener("dragleave", leave)
    panel.addEventListener("dragover", over)
    panel.addEventListener("drop", drop)
    window.addEventListener("dragover", stray)
    window.addEventListener("drop", stray)
    return () => {
      panel.removeEventListener("dragenter", enter)
      panel.removeEventListener("dragleave", leave)
      panel.removeEventListener("dragover", over)
      panel.removeEventListener("drop", drop)
      window.removeEventListener("dragover", stray)
      window.removeEventListener("drop", stray)
    }
  }, [panelRef, allowFiles])

  return (
    <form
      ref={form}
      className={className}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {dragging &&
        panelRef.current &&
        createPortal(
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-zinc-950/85">
            <div className="rounded-2xl border-2 border-dashed border-yard-500 px-8 py-6 text-center text-sm font-medium text-yard-400">
              <Paperclip className="mx-auto mb-2 h-6 w-6" />
              Drop files to attach
            </div>
          </div>,
          panelRef.current,
        )}
      <ConnectionLine held={held} onSendNow={() => submit(true)} onCancel={() => setHeld(false)} />
      {/* Like the Claude and ChatGPT composers: attachments, then the text at full width, then a row of buttons. */}
      {picks.open && (picks.panel ? <RunTargetPanel picks={picks} returnFocus={() => input.current} /> : <RunTargetList list={picks.list} anchor={boxRef} />)}
      {github.open && <GithubReferenceMenu picker={github} anchor={boxRef} />}
      {sendTo.open && <SendToMenu picker={sendTo} anchor={boxRef} input={input} />}
      <div
        ref={boxRef}
        className="@container/composer rounded-xl border border-zinc-800 bg-zinc-900 focus-within:border-yard-500/50"
        onMouseDown={(e) => {
          // A press on the box's empty space (around the text, between the buttons) puts the caret in the text.
          const target = e.target as HTMLElement
          if (target.closest("button, a, input, textarea, [data-attachment]")) return
          e.preventDefault()
          input.current?.focus()
        }}
      >
        <ComposerAttachments files={files} onRemove={remove} onRetry={retry} />
        <div className="px-1 pt-1.5 empty:hidden">
          <DictationStatus machine={dictation} />
        </div>
        <div className="relative">
          {/* Centred on the first line: 24px down below 32rem, 20px from there. */}
          {target && <div data-testid="composer-target" className="absolute top-0 left-0 z-10 flex h-12 w-11 items-center justify-center @min-[32rem]/composer:h-10">{target}</div>}
          {Boolean(icon) && !target && (
            // The text's own line height and top padding, so the icon centres on its first line at either text size.
            <div data-testid="composer-icon" className={cx(LINE, TEXT_TOP, "absolute top-0 left-0 z-10 w-11")}>
              <div className="flex h-lh items-center justify-center">{icon}</div>
            </div>
          )}
          {tinted && <ComposerTags text={value} tags={tags} className={textMetrics} scrolls={overflowing} source={input} />}
          <textarea
            ref={setTextarea}
            rows={1}
            aria-label={label}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              picks.onCaret()
              github.onCaret()
              sendTo.onCaret()
            }}
            onSelect={() => { picks.onCaret(); github.onCaret(); sendTo.onCaret() }}
            onPaste={onPaste}
            onFocus={() => { picks.onFocus(true); github.onFocus(true); sendTo.onFocus(true) }}
            onBlur={() => {
              setBrowse(null)
              picks.onFocus(false)
              github.onFocus(false)
              sendTo.onFocus(false)
            }}
            {...picks.inputProps}
            {...github.inputProps}
            {...sendTo.inputProps}
            onKeyDown={(e) => {
              // Mid-composition (IME), Enter and the arrows belong to the input method.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (sendTo.onKeyDown(e)) return
              if (github.onKeyDown(e)) return
              // The "@", "!" or "%" list, while open, takes ↑/↓, Enter, Tab and Esc: Enter picks instead of sending.
              if (picks.onKeyDown(e)) return
              if (e.key === "Escape" && more.open) {
                e.preventDefault()
                e.stopPropagation()
                return more.close()
              }
              const step = browseStep(browse, e, !value, () => readHistory(historyKey))
              if (step.handled) {
                e.preventDefault()
                // Escape only clears the ghost: it doesn't also close a panel.
                e.stopPropagation()
              }
              if (step.browse !== browse) setBrowse(step.browse)
              if (step.select !== undefined) {
                const text = step.select
                flushSync(() => setValue(text))
                e.currentTarget.setSelectionRange(text.length, text.length)
              }
              if (step.handled) return
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={browse ? "" : placeholder}
            aria-description={browse ? `Earlier prompt: ${browse.text}. Enter to use it, Escape to clear.` : undefined}
            // Reserve the same inset for text and its history ghost; the icon never covers either.
            className={cx(
              textMetrics,
              "scroll-thin block w-full resize-none overflow-y-hidden bg-transparent placeholder:text-zinc-600 placeholder-shown:truncate focus:outline-none",
              // Over the tags' layer, which draws the text; the caret, the selection and the IME's marks stay its own.
              tinted ? "relative text-transparent caret-zinc-100 forced-colors:text-[color:CanvasText]" : "text-zinc-100",
            )}
          />
          {browse && (
            // Same box metrics as the text, so taking it with Enter doesn't move a letter.
            <div
              ref={ghost}
              aria-hidden
              data-testid="history-ghost"
              className={cx(textMetrics, "pointer-events-none absolute inset-x-0 top-0 max-h-full overflow-hidden whitespace-pre-wrap wrap-anywhere text-zinc-500")}
            >
              {browse.text}
            </div>
          )}
        </div>
        <SendToNote picker={sendTo} />
        {hint && !browse && !sendTo.chosen && <div className="px-1.5 empty:hidden">{hint(value)}</div>}
        {runTargets && <PickScope scoped={picks.scoped} />}
        {picks.conflict && <PickConflict text={picks.conflict} />}
        {/* One row at every width (lib/composerRow.ts): what doesn't fit folds into More, and Send never moves. */}
        <div data-testid="composer-row" className="flex flex-nowrap items-center gap-1 px-1.5 pb-1.5">
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
          {/* If a tool is wider than counted, this part scrolls rather than pushing Send to a second line. */}
          <div className="-m-0.5 flex min-w-0 items-center gap-1 overflow-x-auto p-0.5 [scrollbar-width:none]">
            {allowFiles && (
              <Button type="button" variant="ghost" size="sm" className={cx(TOOL, onRow(fold.attach))} title="Attach files" onClick={() => picker.current?.click()}>
                <Paperclip className="h-4 w-4" />
              </Button>
            )}
            {sendTo.enabled && <Button type="button" variant="ghost" size="sm" className={cx(TOOL, onRow(fold.attach))} title={sendToHint()} aria-label="Send to…" onClick={() => { more.close(); sendTo.openSheet() }}><ArrowUpRight className="h-4 w-4" aria-hidden /></Button>}
            {fold.more !== null && <MoreButton more={more} className={cx(TOOL, inMenu(fold.more))} dot={toolsMenu && toolsDot ? { label: toolsDot.label, className: cx(toolsDot.className, inMenu(fold.tools)) } : null} />}
            {runTargets && (
              <span className={cx("flex shrink-0 items-center gap-1", onRow(fold.picks))}>
                <PickButtons picks={picks} className={TOOL} />
              </span>
            )}
            <MicButton machine={dictation} />
            {tools && <span className={cx("flex shrink-0 items-center gap-1 empty:hidden", toolsMenu ? onRow(fold.tools) : null)}>{tools}</span>}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {showExpand && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cx(TOOL, onRow(fold.expand))}
                title={expanded ? "Shrink editor" : "Expand editor"}
                aria-label={expanded ? "Shrink editor" : "Expand editor"}
                aria-pressed={expanded}
                onClick={() => {
                  setExpanded((on) => !on)
                  input.current?.focus()
                }}
              >
                {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            )}
            {stop && (
              <Button type="button" variant="subtle" size="sm" className={TOOL} title={stop.label} aria-label={stop.label} onClick={stop.onStop}>
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" className={TOOL} disabled={!canSend} aria-label={held ? "Waiting to send" : "Send"}>
              {held ? <Clock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
      {more.open && fold.more !== null && (
        <MoreMenu more={more} anchor={boxRef}>
          {/* The row's order, so a line sits where its button would. */}
          {allowFiles && (
            <ComposerMenuItem
              data-testid="more-attach"
              icon={Paperclip}
              label="Attach files"
              className={inMenu(fold.attach)}
              onClick={() => {
                more.close()
                picker.current?.click()
              }}
            />
          )}
          {sendTo.enabled && <ComposerMenuItem data-testid="more-send-to" icon={ArrowUpRight} label="Send to…" detail="Type > or press Cmd/Ctrl+Shift+Enter" className={inMenu(fold.attach)} onClick={() => { more.close(); sendTo.openSheet() }} />}
          {runTargets && <PickMenuItems picks={picks} className={inMenu(fold.picks)} onDone={more.close} />}
          {toolsMenu && <div className={cx("flex flex-col", inMenu(fold.tools))}>{toolsMenu}</div>}
          {showExpand && (
            <ComposerMenuItem
              data-testid="more-expand"
              icon={expanded ? Minimize2 : Maximize2}
              label={expanded ? "Shrink editor" : "Expand editor"}
              aria-pressed={expanded}
              className={inMenu(fold.expand)}
              onClick={() => {
                more.close()
                setExpanded((on) => !on)
                input.current?.focus()
              }}
            />
          )}
        </MoreMenu>
      )}
    </form>
  )
}
