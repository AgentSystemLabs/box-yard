// The keyboard shortcuts sheet. "?" opens it from anywhere but a text field, and so do the palette's "Keyboard
// shortcuts" command and the sidebar's keyboard button, so it's found without knowing a key first. It lists
// lib/shortcuts.ts with this computer's keys (⌘ on a Mac, Ctrl elsewhere) and the dictation chord from Settings ›
// Voice. Mounted once (App) as ShortcutsHost, which also owns the composer jump (⌥⇧C).
import { Fragment, useEffect, useId, useSyncExternalStore } from "react"
import { Modal, isDialogOpen } from "./Modal"
import { composerJumpTarget, isComposerJumpKey, isShortcutsKey, shortcutGroups, spokenChord, type Chord, type Shortcut, type ShortcutGroup } from "../lib/shortcuts"
import { dictationSupported, isMac, useDictationSettings } from "../lib/useDictation"

// ---------------------------------------------------------------- open state

let open = false
const listeners = new Set<() => void>()
const setOpen = (value: boolean) => {
  if (open === value) return
  open = value
  listeners.forEach((l) => l())
}
export const openShortcuts = () => setOpen(true)
export const closeShortcuts = () => setOpen(false)
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const useShortcutsOpen = () => useSyncExternalStore(subscribe, () => open, () => false)

// ---------------------------------------------------------------- host

/** Mounted once in the app: "?" and ⌥⇧C, and the sheet while it's open. */
export function ShortcutsHost() {
  const isOpen = useShortcutsOpen()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutsKey(e)) {
        // "?" closes it again, but never opens it over another dialog.
        if (!open && isDialogOpen()) return
        e.preventDefault()
        setOpen(!open)
      } else if (isComposerJumpKey(e)) {
        // Focus stays inside an open dialog. preventDefault also keeps a Mac from typing "Ç".
        if (isDialogOpen()) return
        e.preventDefault()
        if (!e.repeat) composerJumpTarget(document.activeElement)?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return isOpen ? <ShortcutsSheet onClose={closeShortcuts} /> : null
}

// ---------------------------------------------------------------- the sheet

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const mac = isMac()
  const dictation = useDictationSettings()
  const groups = shortcutGroups({ mac, dictation: dictation.enabled && dictationSupported() ? dictation.key : null })
  return (
    <Modal
      title="Keyboard shortcuts"
      description="Single keys like N, P, / and ? work when you're not typing in a field."
      size="lg"
      placement="sheet"
      onClose={onClose}
      bodyClassName="@container scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5 sm:px-5"
    >
      <div data-testid="shortcuts" className="gap-8 @min-[34rem]:columns-2">
        {groups.map((g) => (
          <Group key={g.title} group={g} mac={mac} />
        ))}
      </div>
    </Modal>
  )
}

function Group({ group, mac }: { group: ShortcutGroup; mac: boolean }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mb-5 break-inside-avoid last:mb-0">
      <h3 id={id} className="pb-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {group.title}
      </h3>
      <ul className="divide-y divide-zinc-900">
        {group.rows.map((row) => (
          <Row key={row.id} row={row} mac={mac} />
        ))}
      </ul>
    </section>
  )
}

function Row({ row, mac }: { row: Shortcut; mac: boolean }) {
  const spoken = `${row.hold ? "hold " : ""}${row.keys.map(spokenChord).join(" or ")}`
  return (
    // Wraps instead of squeezing: on a narrow phone the keys drop under the words, right-aligned.
    <li data-shortcut={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <span className="min-w-0 flex-1 basis-40 text-sm text-zinc-300">{row.label}</span>
      <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs text-zinc-500">
        <span className="sr-only">{spoken}</span>
        {row.hold && <span aria-hidden>hold</span>}
        {row.keys.map((chord, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden>or</span>}
            <Caps chord={chord} />
          </Fragment>
        ))}
      </span>
    </li>
  )
}

function Caps({ chord }: { chord: Chord }) {
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {chord.map((cap, i) => (
        <kbd
          key={i}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900 px-1.5 font-sans text-xs text-zinc-200 shadow-[inset_0_-1px_0_var(--color-zinc-800)]"
        >
          {cap}
        </kbd>
      ))}
    </span>
  )
}
