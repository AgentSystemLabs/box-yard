// Shared shell for portaled dialogs and inline conversation panels. Esc closes the topmost view, or steps back out
// of a level inside it first (useModalStep); full-screen views trap Tab, while desktop panels allow focus to return to
// the chat. A dialog backdrop closes it unless there are unsaved changes. How each kind of surface is left, and why:
// docs/dismiss.md.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, X } from "lucide-react"
import { cx } from "./ui"
import { bindPanelSwipeBack } from "../lib/panelSwipeBack"
import { focusSidebar, isChatComposer } from "../lib/sidebarFocus"

export const MODAL_SIZES = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-[54rem]",
  /** Charts and wide tables (Usage). */
  wide: "sm:max-w-6xl",
  /** File previews: images, HTML pages and PDFs. */
  full: "sm:max-w-[90vw]",
} as const

export type ModalSize = keyof typeof MODAL_SIZES

/** Open modals, oldest first. Only the last one reacts to Esc and Tab. */
const stack: string[] = []

/** How many modals are open: a popover notes it when it opens, so Esc skips it while a newer modal sits on top. */
export const modalDepth = () => stack.length

/** The open modals that cover the page: dialogs, sheets and the drawer, not an inline panel (the side panel). */
const covering = new Set<string>()

/** A dialog, sheet or drawer is open, so page-wide hotkeys back off. The side panel is part of the page: it doesn't count. */
export const isDialogOpen = () => covering.size > 0

/**
 * The one look for leaving a surface (docs/dismiss.md): Back (‹, top left) steps back through a drill-in, the way a
 * phone's navigation bar does; Close (×, top right) ends an interruption: a dialog, a sheet, a drawer. A surface shows
 * one of them, never both. 32px with a mouse, 44px to a finger; the tooltip names Esc, which does the same.
 */
export function DismissButton({ kind, onClick, label, title, className }: { kind: "back" | "close"; onClick: () => void; label?: string; title?: string; className?: string }) {
  const name = label ?? (kind === "back" ? "Back" : "Close")
  const Icon = kind === "back" ? ChevronLeft : X
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      title={title ?? `${name} (Esc)`}
      data-dismiss={kind}
      className={cx(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:w-11",
        className,
      )}
    >
      <Icon className={kind === "back" ? "h-6 w-6" : "h-5 w-5"} aria-hidden />
    </button>
  )
}

type Step = { back: () => void; label: string }
const Steps = createContext<((step: Step) => () => void) | null>(null)

/**
 * A level inside the nearest Modal: a task's side questions, a pull request's detail. While `active`, Esc and the
 * Modal's Back step back out of it (`back`) instead of closing; a titled dialog's header shows Back in place of its
 * ×, as a phone does on a sheet's later steps. Outside a Modal it does nothing.
 */
export function useModalStep(active: boolean, back: () => void, label = "Back") {
  const push = useContext(Steps)
  const backRef = useRef(back)
  backRef.current = back
  useEffect(() => {
    if (!active || !push) return
    return push({ back: () => backRef.current(), label })
  }, [active, push, label])
}

/** useModalStep as an element, for a component that renders the Modal itself (its hooks run outside it). */
export function ModalStep({ active, back, label }: { active: boolean; back: () => void; label?: string }) {
  useModalStep(active, back, label)
  return null
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Elements Tab can reach inside `root`, in order. */
export function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    el.tabIndex >= 0 && !el.matches(":disabled") && (el.checkVisibility?.() ?? true),
  )
}

type ModalProps = {
  onClose: () => void
  size?: ModalSize
  /** Shown in the header with a close button. Without it, pass `label` and draw your own chrome. */
  title?: ReactNode
  description?: ReactNode
  /** Accessible name when there is no title. */
  label?: string
  /** Unsaved changes: a backdrop click won't close the dialog. Esc and the close button still call onClose. */
  dirty?: boolean
  /** "top" pins near the top; "sheet" is a mobile drawer; "drawer" sits at the left edge, full height (the sidebar
   * on a phone); "panel" fills its existing host; the default centers it. None of them animate: they appear and go at
   * once. */
  placement?: "center" | "top" | "sheet" | "drawer" | "panel"
  /** A replaced inline view takes focus without changing the panel's original return target. */
  focusKey?: string
  /** Conversation panels: coarse touch can dismiss the full-screen panel with a right swipe. */
  swipeBack?: boolean
  /** Safe focus destination after a direct visit, when the opening control no longer exists. */
  returnFocus?: () => HTMLElement | null
  /** Renders the panel as a <form>, so the footer's submit button and Enter submit it. */
  onSubmit?: (e: FormEvent) => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
  /** Footer row, right-aligned (put Cancel before the primary action). */
  footer?: ReactNode
  /** Extra classes for the panel (e.g. a fixed height). */
  className?: string
  /** Extra classes for the body; the default pads it and scrolls it. */
  bodyClassName?: string
  /** A titled panel's own buttons at the end of its header (Pin, and Close beside another column). Hidden in a level, whose Back shows. */
  headerEnd?: ReactNode
  /** Where a panel's Back hides (beside the chat, where `headerEnd`'s Close is the way out). Never in a level. */
  backClassName?: string
  children: ReactNode
}

export function Modal({
  onClose,
  size = "md",
  title,
  description,
  label,
  dirty,
  placement = "center",
  focusKey,
  swipeBack,
  returnFocus,
  onSubmit,
  onKeyDown,
  footer,
  className,
  bodyClassName,
  headerEnd,
  backClassName,
  children,
}: ModalProps) {
  const id = useId()
  const panel = useRef<HTMLElement>(null)
  // Captured during render, before any autoFocus inside the dialog moves focus.
  const [previous] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)))
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const returnRef = useRef(returnFocus)
  returnRef.current = returnFocus
  // Levels inside it (useModalStep), newest last: Esc and Back leave the newest first.
  const [steps, setSteps] = useState<Step[]>([])
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  const pushStep = useCallback((step: Step) => {
    setSteps((all) => [...all, step])
    return () => setSteps((all) => all.filter((s) => s !== step))
  }, [])
  const step = steps.at(-1)
  const inline = placement === "panel"
  const modal = () => !inline || !panel.current || panel.current.getBoundingClientRect().width >= (panel.current.closest("aside")?.parentElement?.getBoundingClientRect().width ?? 0)

  useEffect(() => {
    const root = panel.current
    if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus({ preventScroll: true })
  }, [focusKey])

  useEffect(() => {
    stack.push(id)
    if (!inline) covering.add(id)
    const root = panel.current
    if (root && !root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus()

    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== id || e.defaultPrevented || e.isComposing || e.keyCode === 229) return
      if (e.key === "Escape") {
        e.preventDefault()
        const inner = stepsRef.current.at(-1)
        if (inner) inner.back()
        else if (inline && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && isChatComposer(e.target) && focusSidebar()) return
        else closeRef.current()
      } else if (e.key === "Tab" && panel.current && modal()) {
        const items = focusables(panel.current)
        if (!items.length) return e.preventDefault()
        const first = items[0]!
        const last = items.at(-1)!
        const inside = panel.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      stack.splice(stack.indexOf(id), 1)
      covering.delete(id)
      const target = previous?.isConnected && previous !== document.body ? previous : returnRef.current?.()
      target?.focus({ preventScroll: true })
    }
  }, [id, previous])

  useEffect(() => {
    if (!inline || !swipeBack || !panel.current) return
    return bindPanelSwipeBack(panel.current, () => closeRef.current(), () => stack.at(-1) === id)
  }, [inline, swipeBack, focusKey, id])

  const Panel = onSubmit ? "form" : "div"

  // Fixed dialogs portal to body to escape transformed chat columns; an inline panel stays in its shared host.
  const content = (
    <div
      className={cx(
        inline ? "flex h-full min-h-0 flex-col"
          : placement === "drawer" ? "fixed inset-0 z-50 flex items-stretch justify-start bg-black/60"
          : "fixed inset-0 z-50 flex justify-center bg-black/60 backdrop-blur-sm p-[env(safe-area-inset-top)_env(safe-area-inset-right)_env(safe-area-inset-bottom)_env(safe-area-inset-left)] sm:p-4",
        !inline && placement !== "drawer" && (placement === "top" ? "items-stretch sm:items-start sm:pt-[12vh]" : placement === "sheet" ? "items-end sm:items-center" : "items-stretch sm:items-center"),
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !dirty) {
          // Closing restores focus; the backdrop's default mousedown must not blur it again.
          e.preventDefault()
          onClose()
        }
      }}
    >
      <Panel
        ref={panel as never}
        role="dialog"
        aria-modal={inline ? undefined : true}
        // Unsaved changes: a newer build waits to reload the page until they're gone (lib/appUpdate.ts).
        data-dirty={dirty || undefined}
        aria-labelledby={title ? `${id}-title` : undefined}
        aria-label={title ? undefined : label}
        tabIndex={-1}
        onSubmit={onSubmit}
        onKeyDown={onKeyDown}
        className={cx(
          "flex w-full flex-col overflow-hidden border-zinc-800 bg-zinc-950 focus:outline-none",
          inline ? "h-full min-h-0"
            : placement === "drawer" ? "h-full max-w-[min(20rem,88vw)] border-r shadow-2xl"
            : "max-h-[100dvh] shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:border",
          !inline && placement !== "drawer" && MODAL_SIZES[size],
          placement === "sheet" && "max-sm:max-h-[85dvh] max-sm:rounded-t-2xl max-sm:border-t",
          className,
        )}
      >
        {title && (
          // A panel is a drill-in, so it goes Back; a dialog closes with ×, and a level inside either goes Back to it.
          <header className="flex shrink-0 items-center gap-2 border-b border-zinc-900 px-4 py-2.5 sm:px-5">
            {(inline || step) && <DismissButton kind="back" label={step?.label} onClick={step ? step.back : onClose} className={cx("-my-1 -ml-2 pointer-coarse:-my-2 pointer-coarse:-ml-3", !step && backClassName)} />}
            <div className="min-w-0 flex-1 py-0.5">
              <h2 id={`${id}-title`} className="truncate text-base font-semibold text-zinc-50">
                {title}
              </h2>
              {description && <p className="text-xs text-zinc-500">{description}</p>}
            </div>
            {!step && headerEnd}
            {!inline && !step && <DismissButton kind="close" onClick={onClose} className="-my-1 -mr-1.5 pointer-coarse:-my-2 pointer-coarse:-mr-3" />}
          </header>
        )}
        <div className={bodyClassName ?? "scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5"}><Steps.Provider value={pushStep}>{children}</Steps.Provider></div>
        {footer && <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-zinc-900 px-4 py-3 max-sm:[&>button]:w-full max-sm:[&>div]:w-full sm:flex-row sm:items-center sm:justify-end sm:px-5">{footer}</footer>}
      </Panel>
    </div>
  )
  return inline ? content : createPortal(content, document.body)
}
