// The click-opened pickers (Harness, Where tasks run, Send to…): one compact sheet, a search field over a list.
// - Typing always goes to the search field, wherever the focus is; ↑/↓ move the highlight, Enter picks it, Esc clears
//   the search, then leaves the open level, then closes. Backspace in an empty search leaves the level too.
// - The focus stays in the field (a combobox over a listbox), so a mouse and the keys share one highlight: the row
//   under the pointer is the row Enter picks.
// - On a touch screen the field waits for a tap, so the keyboard doesn't cover the list on open.
// - It is short and scrolls inside. On a wider window it is pinned near the top and grows down; on a phone it is a
//   sheet of one height, over the keyboard once that is up. Either way the field stays put while the list changes
//   (Modal placement "picker").
// - One highlight: the keys move it and the pointer takes it along, so there is no second, hover-only shade to tell
//   from it.
import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import { Search } from "lucide-react"
import { cx } from "./ui"
import { DismissButton, Modal, ModalStep } from "./Modal"
import { matchRanges } from "../../../shared/runTargetSearch"

const coarse = () => typeof matchMedia === "function" && Boolean(matchMedia("(pointer: coarse)")?.matches)

/** `items` with the ones that share a key side by side: groups in the order their first item came, each in its own order. */
export function groupTogether<T>(items: T[], keyOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()].flat()
}

/** `text` with the search's `words` (lowercase) marked where they hit it, so a row shows why it is in the results. */
export const Marked = memo(function Marked({ text, words }: { text: string; words: string[] }) {
  const ranges = words.length ? matchRanges(text, words) : []
  if (!ranges.length) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(<mark key={from} className="bg-transparent font-semibold text-yard-300">{text.slice(from, to)}</mark>)
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
})

export interface PickerSheetProps<T> {
  /** The sheet's name, a word a level: ["Harness", "Claude Code"]. */
  trail: string[]
  onClose: () => void
  /** A level is open: Back, Esc and Backspace in an empty search leave it before the sheet closes. */
  back?: () => void
  returnFocus?: () => HTMLElement | null
  query: string
  onQuery: (query: string) => void
  placeholder: string
  /** The search field's accessible name. */
  searchLabel: string
  listId: string
  options: T[]
  active: number
  setActive: (index: number) => void
  keyOf: (option: T) => string
  /** Why a row can't be picked (its tooltip), or null. */
  disabled?: (option: T) => string | null
  /** A heading over the first row of each run of rows that share it. */
  groupOf?: (option: T, index: number) => string | undefined
  onPick: (option: T) => void
  row: (option: T, on: boolean) => ReactNode
  /** Extra attributes for a row (data-token). */
  rowProps?: (option: T) => Record<string, string | undefined>
  /** Loading or an error, in place of the list. */
  status?: ReactNode
  /** What to say when nothing matches. */
  empty: ReactNode
  /** The footer's words: what Default is, what the highlighted row types. */
  note?: ReactNode
  /** What Enter does to a row, when it isn't "pick": "open" for one with more under it. */
  enterWord?: (option: T) => string | undefined
  /** After the list, inside the scroll (a "type more to narrow" line). */
  more?: ReactNode
  testId?: string
  kind?: string
}

export function PickerSheet<T>({
  trail, onClose, back, returnFocus, query, onQuery, placeholder, searchLabel, listId, options, active, setActive, keyOf,
  disabled, groupOf, onPick, row, rowProps, status, empty, note, enterWord, more, testId, kind,
}: PickerSheetProps<T>) {
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // The highlight follows the pointer too, but only the keys (and a new search) scroll the list to it.
  const follow = useRef(true)
  const level = trail.join(" › ")
  const off = (o: T) => Boolean(disabled?.(o))

  // A level opens: the field takes the focus, so typing filters at once. A finger gets the list, and the keyboard
  // waits for a tap on the field (it would cover half the sheet); once it's up, it stays up through the levels.
  useEffect(() => {
    if (coarse() && document.activeElement !== input.current) list.current?.focus({ preventScroll: true })
    else input.current?.focus({ preventScroll: true })
  }, [level])

  useEffect(() => {
    if (!follow.current || !list.current) return
    if (active <= 0) list.current.scrollTop = 0
    else document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" })
  }, [listId, active, options])

  const move = (to: (i: number) => number) => {
    follow.current = true
    for (let i = active, n = 0; n < options.length; n++) {
      i = (to(i) + options.length) % options.length
      if (!off(options[i]!)) return setActive(i)
    }
  }
  const pick = (o: T | undefined) => {
    if (o !== undefined && !off(o)) onPick(o)
  }
  const search = (next: string) => {
    follow.current = true
    onQuery(next)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return
    const target = e.target as HTMLElement
    const typing = target === input.current
    if (!typing && target.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]")) return
    const onButton = !typing && Boolean(target.closest("button, a[href]"))
    if (e.key === "Escape") {
      // The search first; the level and the sheet after (Modal).
      if (!query) return
      e.preventDefault()
      e.stopPropagation()
      return search("")
    }
    if (e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      return move(e.key === "ArrowDown" ? (i) => i + 1 : (i) => i - 1)
    }
    if (e.key === "Home" || e.key === "End") {
      // With words in the field, Home and End are the caret's.
      if (typing && query) return
      e.preventDefault()
      return move(e.key === "Home" ? (i) => (i === active ? 0 : i + 1) : (i) => (i === active ? options.length - 1 : i - 1))
    }
    if (e.key === "Enter") {
      if (onButton) return
      e.preventDefault()
      return pick(options[active])
    }
    if (e.key === "Backspace") {
      if (!query && back) {
        e.preventDefault()
        back()
      } else if (!typing && query) {
        e.preventDefault()
        search(query.slice(0, -1))
      }
      return
    }
    // A letter typed anywhere else in the sheet (the list has the focus on a touch screen) is the search's.
    if (e.key.length === 1 && !typing && !(e.key === " " && (onButton || !query))) {
      e.preventDefault()
      search(query + e.key)
      input.current?.focus({ preventScroll: true })
    }
  }

  const shown = !status && options.length > 0
  const current = shown ? options[active] : undefined
  return (
    <Modal
      label={level}
      placement="picker"
      size="md"
      onClose={onClose}
      returnFocus={returnFocus}
      className="@container/picker max-h-[min(28rem,78dvh,100%)]! max-w-lg! max-sm:h-[26rem] [&_[data-dismiss]]:transition-none"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      <ModalStep active={Boolean(back)} back={back ?? onClose} label="Back to choices" />
      <div data-testid={testId} data-kind={kind} className="flex min-h-0 flex-1 flex-col">
        <div data-testid={testId && `${testId}-title`} className="flex min-h-11 shrink-0 items-center gap-1 pr-1.5 pl-1.5">
          {back && <DismissButton kind="back" onClick={back} label="Back to choices" />}
          <h2 className={cx("min-w-0 flex-1 truncate text-sm font-medium text-zinc-100", !back && "pl-2")}>
            {trail.map((word, i) => (
              <span key={i} className={i < trail.length - 1 ? "text-zinc-500" : undefined}>
                {i > 0 && <span aria-hidden> › </span>}
                {word}
              </span>
            ))}
          </h2>
          {!back && <DismissButton kind="close" onClick={onClose} />}
        </div>
        <label className="mx-2 mb-2 flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-control bg-zinc-900 px-2.5 focus-within:border-yard-500 focus-within:ring-1 focus-within:ring-yard-500">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded={shown}
            aria-controls={listId}
            aria-activedescendant={current !== undefined ? `${listId}-${active}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            placeholder={placeholder}
            value={query}
            onChange={(e) => search(e.target.value)}
            // The label around it carries the focus ring.
            className="min-w-0 flex-1 bg-transparent py-2 text-base text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-none!"
          />
        </label>
        {status}
        {!status && !options.length && <div role="status" className="px-4 py-3 text-sm text-zinc-400">{empty}</div>}
        <div ref={list} id={listId} role="listbox" tabIndex={-1} aria-label={level} aria-busy={status ? true : undefined} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-zinc-800/80 py-1.5 focus-visible:outline-none!">
          {shown && options.map((o, i) => {
            const on = i === active
            const why = disabled?.(o) ?? null
            const group = groupOf?.(o, i)
            const heading = group && (i === 0 || groupOf!(options[i - 1]!, i - 1) !== group) ? group : null
            return (
              <div key={keyOf(o)} role="presentation">
                {heading && <div role="presentation" className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{heading}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={on}
                  aria-disabled={why ? true : undefined}
                  title={why ? `Can't pick it now: ${why}` : undefined}
                  {...rowProps?.(o)}
                  // A press keeps the focus in the search field.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => {
                    if (why || on) return
                    follow.current = false
                    setActive(i)
                  }}
                  onClick={() => pick(o)}
                  className={cx(
                    "mx-1.5 flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm",
                    why ? "cursor-not-allowed opacity-50" : "cursor-pointer active:bg-zinc-700/70",
                    on && !why ? "bg-zinc-800 text-zinc-50" : "text-zinc-200",
                  )}
                >
                  {row(o, on && !why)}
                </div>
              </div>
            )
          })}
          {shown && more}
        </div>
        <div className="flex min-h-8 shrink-0 items-center gap-3 border-t border-zinc-800/80 px-4 py-1.5 text-[11px] text-zinc-500">
          <span className="min-w-0 flex-1 truncate">{note}</span>
          <span aria-hidden className="shrink-0 pointer-coarse:hidden">↑↓ move · ↵ {(current !== undefined && enterWord?.(current)) || "pick"} · esc {query ? "clear" : back ? "back" : "close"}</span>
        </div>
      </div>
    </Modal>
  )
}
