// The composer's More (⋯) menu: the row buttons that don't fit the box's width (lib/composerRow.ts), as labelled lines.
// Which lines show is the same container query as the row's, so every button is on the row or in the menu, never both
// and never neither. The menu is portalled over the box (a clipping footer can't cut it) inside a box-wide
// `composer` container, so its queries read the box's width.
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { MoreHorizontal, type LucideIcon } from "lucide-react"
import { Button, cx } from "./ui"
import { useAbove } from "../lib/useAbove"

/** The More button and its menu: open or not, and who closes it. */
export interface MoreMenuState {
  open: boolean
  id: string
  button: RefObject<HTMLButtonElement | null>
  menu: RefObject<HTMLDivElement | null>
  toggle(byKeyboard: boolean): void
  /** Close it; `refocus` puts the focus back on the More button (Esc from inside the menu). */
  close(refocus?: boolean): void
  /** The menu's lines are in the page: opened from the keyboard, the first one takes the focus. */
  shown(): void
}

export function useMoreMenu(): MoreMenuState {
  const [open, setOpen] = useState(false)
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const byKey = useRef(false)
  const close = useCallback((refocus = false) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }, [])
  const toggle = useCallback((byKeyboard: boolean) => {
    byKey.current = byKeyboard
    setOpen((on) => !on)
  }, [])
  // From the keyboard, the focus goes to the first line; from a press, the caret stays in the text. The menu calls it
  // once its lines are in the page: it places itself in a layout effect first, after this hook's own effects ran.
  const shown = useCallback(() => {
    if (!byKey.current) return
    byKey.current = false
    firstShown(menu.current)?.focus()
  }, [])
  useEffect(() => {
    if (!open) return
    // A press anywhere else closes it, but not one in a dialog a line opened (Pull requests).
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (!t || menu.current?.contains(t) || button.current?.contains(t) || t.closest?.("[role=dialog]")) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", away, true)
    return () => document.removeEventListener("pointerdown", away, true)
  }, [open])
  return { open, id, button, menu, toggle, close, shown }
}

/** Inside the menu, closes it: a line a caller passed in (Composer `toolsMenu`) calls it once it has done its job. */
const CloseMore = createContext<() => void>(() => {})
export const useCloseMore = () => useContext(CloseMore)

function firstShown(menu: HTMLElement | null): HTMLElement | undefined {
  const lines = Array.from(menu?.querySelectorAll<HTMLElement>("button") ?? [])
  return lines.find((b) => (typeof b.checkVisibility === "function" ? b.checkVisibility() : true))
}

/**
 * Something in the menu wants a look (a side question's new answer): a dot on the ⋯ button, which its name says too.
 * `className` says when the dot shows (only while that line is in the menu) and its colour.
 */
export interface MoreDot {
  label: string
  className: string
}

/** The ⋯ button at the row's start. `className` sizes it like the row's other buttons and says when it shows. */
export function MoreButton({ more, className, dot }: { more: MoreMenuState; className?: string; dot?: MoreDot | null }) {
  return (
    <Button
      ref={more.button}
      type="button"
      variant="ghost"
      size="sm"
      data-testid="composer-more"
      className={cx("relative", className, more.open && "bg-zinc-800 text-zinc-100")}
      aria-label={dot ? `More (${dot.label})` : "More"}
      title="More: the buttons that don't fit"
      aria-expanded={more.open}
      aria-controls={more.open ? more.id : undefined}
      // The caret stays in the text, where a picked @ ! % goes.
      onMouseDown={(e) => e.preventDefault()}
      // detail 0 is a keyboard or assistive-tech click.
      onClick={(e) => more.toggle(e.detail === 0)}
    >
      <MoreHorizontal className="h-4 w-4" aria-hidden />
      {dot && <span data-testid="composer-more-dot" aria-hidden className={cx("absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full pointer-coarse:top-2.5 pointer-coarse:right-2", dot.className)} />}
    </Button>
  )
}

/** The open menu, just over `anchor` (the composer's box). Esc closes it; the lines say when each shows. */
export function MoreMenu({ more, anchor, children }: { more: MoreMenuState; anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const at = useAbove(anchor)
  const placed = at !== null
  const { shown } = more
  useLayoutEffect(() => {
    if (placed) shown()
  }, [placed, shown])
  if (!at) return null
  return createPortal(
    // As wide as the box, border included, so `@…/composer` reads the same width here as in the box.
    <div style={{ left: at.left, width: at.width, bottom: at.bottom }} className="@container/composer pointer-events-none fixed z-50 border border-transparent">
      <div
        ref={more.menu}
        id={more.id}
        role="group"
        aria-label="More"
        data-testid="composer-more-menu"
        style={{ maxHeight: at.maxHeight }}
        className="scroll-thin pointer-events-auto flex w-72 max-w-full flex-col overflow-y-auto overscroll-contain rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-xl shadow-black/40"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          // Only the menu: Esc doesn't also close a panel.
          e.preventDefault()
          e.stopPropagation()
          more.close(true)
        }}
      >
        <CloseMore.Provider value={more.close}>{children}</CloseMore.Provider>
      </div>
    </div>,
    document.body,
  )
}

/** A line of the More menu: 44px tall, an icon, a name, what it's set to, and (for @ ! %) the character it types. */
export function ComposerMenuItem({
  icon: Icon,
  label,
  detail,
  keyHint,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: ReactNode; detail?: ReactNode; keyHint?: string }) {
  return (
    <button
      type="button"
      // A press keeps the caret in the text (no blur), on a phone too.
      onMouseDown={(e) => e.preventDefault()}
      {...rest}
      className={cx(
        "flex min-h-11 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none aria-pressed:text-yard-200",
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {detail && <span className="truncate text-xs text-zinc-500">{detail}</span>}
      </span>
      {keyHint && (
        <kbd aria-hidden className="shrink-0 rounded border border-zinc-700 px-1.5 font-mono text-xs text-zinc-400">
          {keyHint}
        </kbd>
      )}
    </button>
  )
}
