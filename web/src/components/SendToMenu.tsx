import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { createPortal, flushSync } from "react-dom"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, X } from "lucide-react"
import type { Attachment, Project } from "../../../shared/types"
import { useDraft, writeDraft } from "../lib/composerDraft"
import { api } from "../lib/api"
import { fetchTasks, keys, newClientId, QUIET, useSendCaptainMessage, useSendChat, useSendTaskMessage } from "../lib/queries"
import { sendDestinations, sendToMention, type SendDestination } from "../lib/sendTo"
import { pickerKeyDown } from "../lib/pickerKeys"
import { useAbove } from "../lib/useAbove"
import { chordLabel, sendToChord } from "../lib/shortcuts"
import { isMacPlatform } from "../lib/dictation"
import { AppLink, cx } from "./ui"
import { Loading } from "./Loading"
import { Modal } from "./Modal"
import type { ComposerExtra } from "./Composer"

export const sendToHint = () => `Send to… (type > or ${chordLabel(sendToChord, isMacPlatform(navigator.platform))})`

/** Destination choice and delivery stay in Composer, away from transcript renders. No new server routing surface. */
export function useSendTo({ enabled, draftKey, value, setValue, input, onPick }: {
  enabled: boolean; draftKey: string; value: string; setValue: (value: string) => void
  input: RefObject<HTMLTextAreaElement | null>; onPick?: () => void
}) {
  const chosen = useDraft(draftKey).destination ?? null
  const choose = (destination: SendDestination | null) => writeDraft(draftKey, (draft) => ({ ...draft, destination: destination ?? undefined }))
  const [confirmed, confirm] = useState<SendDestination | null>(null)
  const [sheet, setSheet] = useState(false)
  const [query, setQuery] = useState("")
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissed, dismiss] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const caretRef = useRef(0)
  const id = useId()
  const mention = enabled ? sendToMention(value, caret) : null
  const scope = mention ? `${draftKey}:${mention.start}:${mention.query}` : null
  const open = enabled && (sheet || (focused && Boolean(mention) && scope !== dismissed))
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), enabled: open, ...QUIET })
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, enabled: open, ...QUIET })
  const search = sheet ? query : mention?.query ?? ""
  const matches = useMemo(() => sendDestinations(projects.data ?? [], tasks.data ?? [], search), [projects.data, tasks.data, search])
  const options = matches.slice(0, 100)
  const loading = projects.isPending || tasks.isPending
  const error = projects.isError || tasks.isError
  const taskSend = useSendTaskMessage("")
  const captainSend = useSendCaptainMessage("")
  const chatSend = useSendChat()
  const currentKey = useRef(draftKey)
  currentKey.current = draftKey
  useEffect(() => { confirm(null); setSheet(false); dismiss(null) }, [draftKey, enabled])
  useEffect(() => setActive(0), [search, sheet])
  useEffect(() => { if (!mention) dismiss(null) }, [Boolean(mention)])
  const onCaret = () => {
    if (!enabled) return
    const el = input.current
    const next = el && el.selectionStart === el.selectionEnd ? el.selectionStart : -1
    if (next !== caretRef.current) {
      caretRef.current = next
      setCaret(next)
    }
  }
  const close = () => { setSheet(false); dismiss(scope) }
  const pick = (destination: SendDestination) => {
    const el = input.current
    const token = el ? sendToMention(el.value, el.selectionStart) : null
    flushSync(() => {
      // The button/chord sheet never removes a literal > from the draft.
      if (!sheet && token) setValue(value.slice(0, token.start) + value.slice(token.end))
      choose(destination)
      confirm(null)
      close()
      onPick?.()
    })
    el?.focus()
    if (!sheet && token) el?.setSelectionRange(token.start, token.start)
    onCaret()
  }
  const openSheet = () => { setQuery(""); setSheet(true) }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (enabled && e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); openSheet(); return true
    }
    return open && !sheet && pickerKeyDown(e, { options, active, setActive, disabled: () => loading || error, pick, escape: close })
  }
  const send = (text: string, attachments: Attachment[], extra: ComposerExtra) => {
    const destination = chosen!
    const from = draftKey
    const content = { content: text, attachments }
    const message = { ...content, id: newClientId("chat"), ...extra }
    const pending = destination.kind === "task" ? taskSend.mutateAsync({ ...content, taskId: destination.id })
      : destination.kind === "captain" ? captainSend.mutateAsync({ ...message, projectId: destination.id }) : chatSend.mutateAsync(message)
    return pending.then(() => {
      if (currentKey.current === from) confirm(destination)
    })
  }
  return {
    total: matches.length, enabled, chosen, confirmed, open, sheet, query, setQuery, id, options, active, setActive, loading, error,
    pick, close, openSheet, onCaret, onFocus: (next: boolean) => { if (enabled) { setFocused(next); if (next) onCaret() } }, onKeyDown, send,
    clear: (focus = true) => { choose(null); if (focus) input.current?.focus() },
    retry: () => { void projects.refetch(); void tasks.refetch() },
    inputProps: open && !sheet ? {
      role: "combobox", "aria-autocomplete": "list" as const, "aria-haspopup": "listbox" as const,
      "aria-expanded": true, "aria-controls": id,
      "aria-activedescendant": options[active] ? `${id}-${active}` : undefined,
    } : {},
  }
}

type Picker = ReturnType<typeof useSendTo>

export function SendToNote({ picker }: { picker: Picker }) {
  const destination = picker.chosen ?? picker.confirmed
  if (!destination) return null
  return <div role="status" data-testid="send-to-note" className="flex min-w-0 items-center gap-1 px-3 text-xs text-yard-300">
    <span className="min-w-0 flex-1 py-1 wrap-anywhere">
      {picker.chosen ? "Send to " : "Sent to "}
      <AppLink href={destination.href} className="text-yard-300 underline">{destination.label}</AppLink>
      {picker.chosen && destination.kind === "task" && <span className="block text-zinc-400">{destination.detail}</span>}
      {picker.chosen && <span className="block text-zinc-400">Enter sends there · Clear returns to this chat</span>}
    </span>
    {picker.chosen && <button type="button" aria-label="Clear destination" title="Clear destination" onClick={() => picker.clear()} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-zinc-800"><X className="h-4 w-4" aria-hidden /></button>}
  </div>
}

function Choices({ picker, maxHeight }: { picker: Picker; maxHeight?: number }) {
  const { id, options, active, loading, error } = picker
  useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" }) }, [id, active])
  return <>
    {loading && <Loading kind="rows" label="Loading destinations" />}
    {error && <div role="status" className="p-3 text-sm text-amber-300">Couldn't load destinations. <button type="button" onClick={picker.retry} className="min-h-11 underline">Try again</button></div>}
    {!loading && !error && !options.length && <p role="status" className="p-3 text-sm text-zinc-400">No matching destinations.</p>}
    <ul id={id} role="listbox" aria-label="Send to destination" aria-busy={loading || undefined} style={{ maxHeight }} className="scroll-thin overflow-y-auto overscroll-contain py-1">
      {!loading && !error && options.map((d, i) => <li key={d.key} id={`${id}-${i}`} role="option" aria-selected={i === active}>
        <button type="button" onClick={() => picker.pick(d)} onMouseMove={() => i !== active && picker.setActive(i)} className={cx("flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm", i === active && "bg-zinc-800")}>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-yard-400" aria-hidden />
          <span className="min-w-0"><span className="block truncate text-zinc-100">{d.label}</span><span className="block truncate text-xs text-zinc-400">{d.detail}</span></span>
        </button>
      </li>)}
    </ul>
    {picker.total > 100 && <p className="px-3 py-2 text-xs text-zinc-400">Type more to narrow {picker.total} destinations.</p>}
  </>
}

export function SendToMenu({ picker, anchor, input }: { picker: Picker; anchor: RefObject<HTMLElement | null>; input: RefObject<HTMLTextAreaElement | null> }) {
  const at = useAbove(anchor)
  if (picker.sheet) return <Modal title="Send to…" description="Choose where this draft goes. Enter in the composer sends it; you stay in this chat." placement="sheet" size="md" onClose={picker.close} returnFocus={() => input.current}>
    <input autoFocus aria-label="Search destinations" placeholder="Search tasks, Captains or Coordinator…" value={picker.query} onChange={(e) => picker.setQuery(e.target.value)}
      role="combobox" aria-autocomplete="list" aria-expanded aria-controls={picker.id} aria-activedescendant={picker.options[picker.active] ? `${picker.id}-${picker.active}` : undefined}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        pickerKeyDown(e as unknown as KeyboardEvent<HTMLTextAreaElement>, { options: picker.options, active: picker.active, setActive: picker.setActive, disabled: () => picker.loading || picker.error, pick: picker.pick, escape: picker.close })
      }} className="mb-2 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-base text-zinc-100 focus:outline-yard-500" />
    <Choices picker={picker} maxHeight={320} />
  </Modal>
  if (!at) return null
  return createPortal(<div data-testid="send-to-menu" style={{ left: at.left, width: at.width, bottom: at.bottom }} onMouseDown={(e) => e.preventDefault()}
    className="fixed z-50 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl">
    <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">Send to…<span className="block text-zinc-400">↑↓ choose · Enter/Tab select · Esc cancel</span></div>
    <Choices picker={picker} maxHeight={Math.max(44, at.maxHeight - 70)} />
  </div>, document.body)
}
