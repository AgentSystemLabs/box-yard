// The chat switcher's seams (components/ChatSwitcher.tsx): the Coordinator or Captain title in a chat header opens a
// menu of every chat, and picking one opens it with its composer focused, so Cody can type to it right away.
//
// The picked chat may not be on screen yet (a Captain tab the navigation is about to render, the Coordinator drawer
// sliding in), so the switcher leaves a request here and each chat takes its own when it mounts or hears about it. The
// sidebar, a question card's Answer and the command palette leave one too.
import { useEffect, type RefObject } from "react"
import { afterPaint } from "./afterPaint"
import { isTouchDevice } from "./composer"
import { normalizeQuery, scoreText } from "./paletteRank"

/** Fired by openCoordinator. Nothing in the app listens for it now: the Coordinator has no drawer to open. */
export const OPEN_COORDINATOR_EVENT = "box-yard:open-coordinator"
const FOCUS_EVENT = "box-yard:focus-composer"
/** A request nobody took by then (the page never showed that chat) is dropped, so it can't steal focus later. */
const PENDING_MS = 5000

let pending: { chat: string; at: number; end: boolean } | null = null

/** A press after the request (to select text, or into another field) means Cody has moved on while the chat loaded. */
const dropPending = () => void (pending = null)

/**
 * Focus `chat`'s composer (COORDINATOR_CHAT, a project id or a task id) now if it's mounted, or when it mounts. `end`
 * puts the caret after its draft (the palette's pick), not wherever it was left.
 */
export function focusComposer(chat: string, { end = false } = {}) {
  pending = { chat, at: Date.now(), end }
  window.addEventListener("pointerdown", dropPending, { capture: true, once: true })
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: chat }))
}

/**
 * Whether a pick in the sidebar takes the caret to the picked chat's box (focusComposer): with a mouse or the
 * keyboard, yes. Not on a touch screen, where the keyboard would come up over what was just opened, and not on a
 * click with a modifier (⌘/Ctrl-click and the like ask for something else).
 */
export function pickFocusesComposer(e?: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { pointerType?: string }): boolean {
  if (isTouchDevice() || e?.pointerType === "touch") return false
  return !(e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey))
}

/**
 * A sidebar row's onMouseDown: when its pick will put the caret in the picked chat's box (pickFocusesComposer), the
 * press leaves the focus where it is until then. The row taking it on the way blurred the box on screen (a render and
 * a restyle) and drew a frame before the click could start, ~8 ms of the click's wait with the CPU slowed 4×.
 */
export function keepFocusForPick(e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">) {
  if (e.button === 0 && pickFocusesComposer(e)) e.preventDefault()
}

/** Show the Coordinator: App opens its drawer when it isn't docked. */
export const openCoordinator = () => window.dispatchEvent(new Event(OPEN_COORDINATOR_EVENT))

/** A chat's half: focuses `box` when the switcher, the sidebar or the palette picked `chat`. */
export function useComposerFocus(chat: string, box: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const take = () => {
      const request = pending
      if (!request || request.chat !== chat) return
      if (Date.now() - request.at > PENDING_MS) return void (pending = null)
      const el = box.current
      if (!el) return
      // Once the chat's first frame is on screen: focusing restyles and lays out the page, which held that frame back
      // ~10 ms with the CPU slowed 4×. By then a drawer opening on the same event has started to slide in, so focusing
      // doesn't scroll to it. Only if the request still stands then: a press since, or a newer pick, has replaced it.
      // The dialog it was picked in (the palette) has closed and given its focus back by then.
      void afterPaint().then(() => {
        if (pending !== request || !el.isConnected) return
        pending = null
        // A dialog opened since (the palette again, Settings) keeps the focus.
        const dialog = document.activeElement?.closest('[aria-modal="true"]')
        if (dialog && !dialog.contains(el)) return
        // Before the focus, so preventScroll leaves the page where it is; a draft taller than the box shows its end.
        if (request.end) el.setSelectionRange(el.value.length, el.value.length)
        el.focus({ preventScroll: true })
        if (request.end) el.scrollTop = el.scrollHeight
      })
    }
    take()
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<string>).detail === chat) take()
    }
    window.addEventListener(FOCUS_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_EVENT, onFocus)
  }, [chat, box])
}

/** A word-initials match ("ktc" → "keep-the-castle") ranks between a prefix and a word start. */
const INITIALS_SCORE = 700
/** Aliases count less than the name, as in the palette (FIELD_WEIGHT.alias). */
const ALIAS_WEIGHT = 0.75

/**
 * The switcher's filter: the chats whose name matches `query`, best first (lib/paletteRank.ts's tiers: exact, prefix,
 * word start, substring, then a fuzzy subsequence), with word initials ("ktc" → "keep-the-castle") just under a
 * prefix; a tie keeps the menu's order. An empty query keeps them all, in order. `aliases` match too, a little
 * weaker ("All" for the Coordinator, as the project bar says).
 */
export function rankChats<T extends { label: string; aliases?: readonly string[] }>(items: readonly T[], query: string): T[] {
  const q = normalizeQuery(query)
  if (!q) return [...items]
  const scored: { item: T; score: number; at: number }[] = []
  items.forEach((item, at) => {
    let score = scoreName(item.label, q)
    for (const alias of item.aliases ?? []) {
      const s = scoreName(alias, q)
      if (s !== null && (score === null || s * ALIAS_WEIGHT > score)) score = s * ALIAS_WEIGHT
    }
    if (score !== null) scored.push({ item, score, at })
  })
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.item)
}

function scoreName(name: string, q: string): number | null {
  const s = scoreText(name, q)
  const initials = name
    .toLowerCase()
    .split(/[\s\-_/.:]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
  if (q.length >= 2 && !q.includes(" ") && initials.startsWith(q)) return Math.max(s ?? 0, INITIALS_SCORE)
  return s
}

/**
 * The project picker's hotkey: P, with no modifier, from anywhere but a text field, opens the Coordinator's chat
 * switcher with its filter focused. Free of the other hotkeys (lib/shortcuts.ts lists them all): ⌘K/Ctrl+K and "/"
 * (palette), "?" (the shortcuts sheet), ←/→ and Z (file preview), ⌥⇧C (composer jump), ⌥⇧V (voice), Alt/Ctrl(+Shift)+Space
 * (dictation), Ctrl+N/P (palette rows, in its field).
 */
export const PROJECT_PICKER_KEY_LABEL = "P"
export function isProjectPickerKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented" | "repeat" | "isComposing" | "target">) {
  if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat || e.isComposing) return false
  const el = e.target instanceof Element ? e.target : null
  return !el?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]")
}
