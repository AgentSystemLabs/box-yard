// A chat message's actions: Reply, which opens the message's reply thread (SideThread.tsx), and Copy, which copies
// the message as it was written (its Markdown). The Coordinator or the Captain reads each message sent to a thread and
// answers it there, sends it on to the task's agent, or posts it in the main chat (server/sideThreads.ts), so there's
// nothing to pick first. They only show in a chat with threads.
// A message up to about a screen tall has them in a small toolbar on its top-right edge (as on claude.ai): with a
// mouse it shows on hover and keyboard focus; on touch a tap on the message shows it, a tap anywhere else hides it. On
// touch it lies over the space above the message, or over the message's top corner when there's no room above, so
// showing it never moves the transcript. A message taller than about the chat's height has Reply and Copy pills down
// its right side instead: a mouse over the message shows them at the top of the part on screen, in a gutter of their
// own, and a tap or click on its text puts them at the tap's height, so they're never a scroll away. On touch they lie
// over the message's right edge while they're out, so a phone keeps its whole width for the text. Selecting text in
// it while the pills are out turns them into "Reply quoting selection" and "Copy selection", beside the selection. A
// tap elsewhere, Esc, or scrolling them away puts them back; keyboard focus shows them at the top of the message's
// visible part, where they stick. Both are placed inside the message (no portal) and show and hide at once, with no
// fade. Text stays selectable: nothing here sets user-select or handles a long press. Copy says "Copied" in place and
// stays up that long. The newest reply (`standing`) also has both as a quiet row under it on touch, where nothing
// hovers.
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react"
import { createPortal } from "react-dom"
import { Check, Copy, Quote, Reply, type LucideIcon } from "lucide-react"
import { useReplyTo } from "./SideThread"
import { copyText } from "../lib/clipboard"
import { onSuspend } from "../lib/resume"
import { toast } from "../lib/toast"
import { COPIED_MS, TAP_AREA, cx } from "./ui"

/**
 * The classes for the element a MessageActions sits in (a bubble, a reply, a notice card): the hover group and the
 * toolbar's positioning box. With a mouse a long message's pills get a gutter on the right, so they never cover the
 * text; on touch they only show on a tap, over the right edge. Child-scoped `:has()`, so only this block restyles.
 */
export const MESSAGE_BLOCK = "group/msg relative pointer-fine:has-[>[data-reply-pill]]:pr-12"

/** What a tap on a message means by itself; tapping one of these inside it doesn't show the toolbar. */
const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role=button], [role=link], [role=menuitem]"

const BUTTON =
  "inline-flex h-6 w-7 items-center justify-center gap-1.5 pointer-coarse:h-11 pointer-coarse:w-auto pointer-coarse:min-w-11 pointer-coarse:px-3 rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"

const TITLE = "Reply in a thread: a question is answered there, and an instruction goes on to whoever acts on it"

/** A standing row's button: drawn small and quiet, 44px to a finger (its row is that tall). */
const ROW_BUTTON = cx(
  TAP_AREA,
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none",
)

/** A long message's pill: 44px wide in its 48px gutter, at least 44px to a finger. */
const PILL_HEIGHT = 52
/** Its two pills (Reply, Copy) and the gap between them. */
const PILLS_HEIGHT = PILL_HEIGHT * 2 + 4
const PILL =
  "flex w-11 flex-col items-center justify-center gap-0.5 rounded-full border bg-zinc-900 text-[10px] font-medium shadow-lg shadow-black/40 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"
/** The touch toolbar's height with a little air: the room it needs above its message. */
const TOOLBAR_ROOM = 52

/** Keeps the toolbar's clicks and keys from the row under it (a notice card opens its task, a notice row folds). */
const stop = (e: SyntheticEvent) => e.stopPropagation()

/**
 * `anchorId`: the chat message's id, which its reply thread hangs off. Without one, or outside a chat with threads, it shows nothing.
 * `standing`: on touch the actions also stand in a row here, in the message's flow (the chat's newest reply), instead
 * of the toolbar a tap shows.
 */
export const MessageActions = memo(function MessageActions({ text, anchorId, className, standing = false }: { text: string; anchorId?: string; className?: string; standing?: boolean }) {
  const replyTo = useReplyTo()
  const reply = anchorId && text.trim() ? replyTo : null
  const bar = useRef<HTMLDivElement>(null)
  const pills = useRef<HTMLDivElement>(null)
  /** Taller than about the chat's height: the gutter pill instead of the toolbar. */
  const long = useLongBlock(bar, Boolean(reply))
  /** Touch, a short message: the toolbar, shown by a tap on the message until a tap anywhere else. */
  const [tapped, setTapped] = useState(false)
  /** Touch: no room above the message when it was tapped, so the toolbar lies over its top corner. */
  const [inside, setInside] = useState(false)
  /** A long message: the pill's top in the message, where it was tapped (null: hidden). */
  const [pill, setPill] = useState<number | null>(null)
  /** Text selected in the message while the pill is out: the pill quotes it. */
  const [quote, setQuote] = useState<string | null>(null)
  /** The quote when the pill was pressed: on a phone the selection may be gone by the click. */
  const pressed = useRef<string | null>(null)
  /** Just copied: Copy says so in place, and the bar or pills stay up while it does. */
  const [copied, setCopied] = useState(false)
  const flash = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(flash.current), [])

  useEffect(() => {
    const block = bar.current?.parentElement
    // A short message with a standing row needs no toolbar on a tap.
    if (!block || !reply || (!long && (standing || !window.matchMedia?.("(hover: none)").matches))) return
    const tap = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.(INTERACTIVE)
      if ((hit && hit !== block && block.contains(hit)) || !window.getSelection()?.isCollapsed) return
      if (!long) {
        setInside(!roomAbove(block))
        return setTapped(true)
      }
      setPill(pillTop(block, e.clientY))
    }
    block.addEventListener("click", tap)
    return () => block.removeEventListener("click", tap)
  }, [reply, long, standing])

  const shown = tapped || pill !== null

  useEffect(() => {
    if (!shown) return
    const hide = () => {
      clearTimeout(flash.current)
      setCopied(false)
      setTapped(false)
      setPill(null)
    }
    const away = (e: Event) => {
      if (!bar.current?.parentElement?.contains(e.target as Node)) hide()
    }
    // Esc puts it away first, before whatever the chat does with Esc.
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
    document.addEventListener("pointerdown", away, true)
    document.addEventListener("keydown", key, true)
    // The app going to the background (a phone's home-screen app is frozen, not closed): put it away, so a thaw
    // doesn't bring back a toolbar whose tap is long over.
    const off = onSuspend(hide)
    return () => {
      document.removeEventListener("pointerdown", away, true)
      document.removeEventListener("keydown", key, true)
      off()
    }
  }, [shown])

  // The pills scrolled out of view: they're gone, rather than waiting where Cody left them.
  const out = pill !== null
  useEffect(() => {
    const el = pills.current
    if (!out || !el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e && !e.isIntersecting) setPill(null)
      },
      { root: el.closest(SCROLLER) },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [out])

  // Text selected in the message while the pill is out: the pill offers to quote it, beside the selection's end.
  useEffect(() => {
    const block = bar.current?.parentElement
    if (!out || !block) return setQuote(null)
    const read = () => {
      const sel = window.getSelection()
      const within = sel && !sel.isCollapsed && sel.rangeCount > 0 && block.contains(sel.anchorNode) && block.contains(sel.focusNode)
      const picked = within ? sel.toString().trim() : ""
      setQuote(picked || null)
      if (!picked) return
      const rects = sel!.getRangeAt(0).getClientRects()
      const end = backwards(sel!) ? rects[0] : rects[rects.length - 1]
      if (end) setPill(pillTop(block, end.top + end.height / 2))
    }
    document.addEventListener("selectionchange", read)
    return () => document.removeEventListener("selectionchange", read)
  }, [out])

  if (!reply) return null

  const open = () => {
    const quoted = pressed.current ?? quote
    pressed.current = null
    setTapped(false)
    setPill(null)
    if (!quoted) return reply(anchorId!, text)
    reply(anchorId!, text, `${quoteLines(quoted)}\n\n`)
    window.getSelection()?.removeAllRanges()
  }

  /** The selection while the pills quote it, else the whole message as written. */
  const copy = async () => {
    const picked = pressed.current ?? quote
    pressed.current = null
    clearTimeout(flash.current)
    if (!(await copyText(picked ?? text))) {
      setCopied(false)
      setTapped(false)
      setPill(null)
      return toast.error("Couldn't copy", "The browser blocked clipboard access.")
    }
    // Said in place, like CopyButton (ui.tsx): the chat's toasts leave out plain confirmations.
    setCopied(true)
    flash.current = setTimeout(() => {
      setCopied(false)
      setTapped(false)
      setPill(null)
    }, COPIED_MS)
  }
  /** Read out once; the buttons show it. */
  const said = (
    <span role="status" className="sr-only">
      {copied ? "Copied" : ""}
    </span>
  )
  // The newest reply's actions where a finger finds them without a tap on the message first.
  const row = standing && (
    <div data-message-row onClick={stop} onAuxClick={stop} onKeyDown={stop} className="mt-1 -ml-2 hidden min-h-11 items-center gap-1 pointer-coarse:flex">
      <button type="button" data-testid="message-row-reply" aria-label="Reply in a thread" title={TITLE} onClick={open} className={cx(ROW_BUTTON, "text-zinc-400 hover:text-zinc-100")}>
        <Reply className="h-4 w-4" aria-hidden />
        Reply
      </button>
      <button type="button" data-testid="message-row-copy" aria-label="Copy message" title="Copy message" data-copied={copied || undefined} onClick={copy} className={cx(ROW_BUTTON, copied ? "text-emerald-400" : "text-zinc-400 hover:text-zinc-100")}>
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        {copied ? "Copied" : "Copy"}
      </button>
      {!long && said}
    </div>
  )

  if (long) {
    const quoting = pill !== null && quote !== null
    return (
      <>
        {row}
        {/* The gutter: a column down the message's right edge. Tapped, the pills sit in it at the tap's height; otherwise
            they're hidden at the top of the message's visible part (sticky), where a mouse over the message or keyboard
            focus shows them without a scroll. */}
        <div
          ref={bar}
          data-reply-pill
          data-open={pill !== null || undefined}
          data-quote={quoting || undefined}
          onClick={stop}
          onAuxClick={stop}
          onKeyDown={stop}
          className={cx("pointer-events-none absolute inset-y-0 right-0.5 z-10 w-11", className)}
        >
          <div
            ref={pills}
            style={pill === null ? undefined : { top: pill }}
            className={cx(
              "flex w-11 flex-col gap-1",
              // The hover is on the message's own group, not a :has() on the list.
              pill !== null
                ? "pointer-events-auto absolute"
                : copied
                  ? "pointer-events-auto sticky top-2"
                  : "sticky top-2 opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 pointer-fine:group-hover/msg:pointer-events-auto pointer-fine:group-hover/msg:opacity-100",
            )}
          >
            <button
              type="button"
              data-testid="message-reply"
              aria-label={quoting ? "Reply quoting selection" : "Reply in a thread"}
              title={quoting ? "Reply in a thread, quoting the selected text" : TITLE}
              // Pressing it keeps the selection it quotes, and the focus where it is.
              onPointerDown={() => (pressed.current = quote)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={open}
              style={{ height: PILL_HEIGHT }}
              // The label is CSS content, so it's never part of the message's text (a copy, a search, a row's textContent).
              className={cx(PILL, quoting ? "border-yard-400/60 text-yard-200 after:content-['Quote']" : "border-zinc-700 text-zinc-300 after:content-['Reply']")}
            >
              {quoting ? <Quote className="h-4 w-4" aria-hidden /> : <Reply className="h-4 w-4" aria-hidden />}
            </button>
            <button
              type="button"
              data-testid="message-copy"
              aria-label={quoting ? "Copy selection" : "Copy message"}
              title={quoting ? "Copy the selected text" : "Copy message"}
              onPointerDown={() => (pressed.current = quote)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={copy}
              data-copied={copied || undefined}
              style={{ height: PILL_HEIGHT }}
              className={cx(
                PILL,
                copied ? "border-emerald-500/50 text-emerald-300 after:content-['Copied']" : "after:content-['Copy']",
                !copied && (quoting ? "border-yard-400/60 text-yard-200" : "border-zinc-700 text-zinc-300"),
              )}
            >
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            </button>
            {said}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {row}
      <div
        ref={bar}
        role="toolbar"
        aria-label="Message actions"
        data-message-actions
        data-open={tapped || copied || undefined}
        data-inside={(tapped && inside) || undefined}
        onClick={stop}
        onAuxClick={stop}
        onKeyDown={stop}
        className={cx(
          // The larger touch toolbar lies over the space above its message rather than its first two lines, and nothing
          // moves to make room for it. Without room there (the top of the chat, under a header) it takes the top corner.
          "absolute -top-3.5 right-2 z-10 flex items-center gap-px rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 shadow-lg shadow-black/40 pointer-coarse:top-0 pointer-coarse:-translate-y-full pointer-coarse:data-inside:top-1 pointer-coarse:data-inside:translate-y-0",
          // Hidden (and not catching clicks) until the message is hovered, focused or tapped.
          "pointer-events-none opacity-0",
          "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 data-open:pointer-events-auto data-open:opacity-100",
          // The standing row has them on touch.
          standing && "pointer-coarse:hidden",
          className,
        )}
      >
        {/* On touch each says what it does: in CSS content, like the pills'. */}
        <button type="button" data-testid="message-reply" aria-label="Reply in a thread" title={TITLE} onClick={open} className={cx(BUTTON, "pointer-coarse:text-xs pointer-coarse:font-medium pointer-coarse:after:content-['Reply']")}>
          <Reply className="h-3.5 w-3.5 pointer-coarse:h-4 pointer-coarse:w-4" aria-hidden />
        </button>
        {/* A mouse press leaves the focus where it is, so the bar goes when the mouse does. */}
        <button
          type="button"
          data-testid="message-copy"
          aria-label="Copy message"
          title={copied ? "Copied" : "Copy message"}
          data-copied={copied || undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={copy}
          className={cx(
            BUTTON,
            "pointer-coarse:text-xs pointer-coarse:font-medium",
            // With a mouse the icon-only button grows a word for as long as it says it.
            copied ? "text-xs font-medium text-emerald-400! after:content-['Copied'] pointer-fine:w-auto pointer-fine:px-1.5" : "pointer-coarse:after:content-['Copy']",
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5 pointer-coarse:h-4 pointer-coarse:w-4" aria-hidden /> : <Copy className="h-3.5 w-3.5 pointer-coarse:h-4 pointer-coarse:w-4" aria-hidden />}
        </button>
        {said}
      </div>
    </>
  )
})

/** A chat's scroller (StickyScroll): what "on screen" means for a message in it. */
const SCROLLER = "[data-scroller]"
/** What floats over a chat's bottom edge ("Jump to latest", the new-cards pill): the pill stays above it. */
const FLOATING = "[data-chat-float] button"

/** The touch toolbar's width, about: Reply and Copy with their words. */
const TOOLBAR_WIDTH = 176

/**
 * Whether the touch toolbar fits above `block`: the spot it would take is on screen, in the chat's scroller, not
 * under a sticky header, and not over something with a tap of its own (the card above and its Retry, a link, a chip).
 */
function roomAbove(block: HTMLElement) {
  if (typeof document.elementFromPoint !== "function") return true
  const r = block.getBoundingClientRect()
  const view = block.closest(SCROLLER)
  // Its corners and middle, a little inside its edges.
  for (const y of [r.top - TOOLBAR_ROOM + 4, r.top - 6]) {
    for (const x of [r.right - 24, r.right - TOOLBAR_WIDTH / 2, r.right - TOOLBAR_WIDTH + 8]) {
      const at = document.elementFromPoint(x, y)
      if (!at || (view && !view.contains(at)) || at.closest("header")) return false
      const taps = at.closest(INTERACTIVE)
      if (taps && !taps.contains(block)) return false
    }
  }
  return true
}

/** The pills' top in `block` for a press at `y` (viewport): centred on it, inside the message and inside the part of it on screen. */
function pillTop(block: HTMLElement, y: number) {
  const r = block.getBoundingClientRect()
  const view = block.closest(SCROLLER)?.getBoundingClientRect()
  const visTop = Math.max(r.top, view?.top ?? 0, 0)
  let visBottom = Math.min(r.bottom, view?.bottom ?? window.innerHeight, window.innerHeight)
  for (const el of document.querySelectorAll(FLOATING)) {
    const f = el.getBoundingClientRect()
    // Over the gutter, in the lower half of what shows.
    if (f.height && f.right > r.right - 48 && f.left < r.right && f.top < visBottom && f.top > (visTop + visBottom) / 2) visBottom = f.top
  }
  const top = visTop - r.top + 4
  const bottom = visBottom - r.top - PILLS_HEIGHT - 4
  return Math.round(Math.max(top, Math.min(bottom, y - r.top - PILLS_HEIGHT / 2)))
}

/** Whether the selection runs from its end back to its start (its focus is before its anchor). */
function backwards(sel: Selection) {
  if (!sel.anchorNode || !sel.focusNode) return false
  if (sel.anchorNode === sel.focusNode) return sel.focusOffset < sel.anchorOffset
  return Boolean(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING)
}

/** Taller than this share of the chat's height (its scroller's, or the window's): a long message. */
const LONG_SHARE = 0.9

/** Every watched message's height, the scroller it's in, and what to tell it: one ResizeObserver for them all. */
const watched = new Map<Element, { height: number; view: Element | null; set: (long: boolean) => void }>()
/** The scrollers those messages are in, and how many: the same observer reports a scroller's resize. */
const views = new Map<Element, number>()
let heights: ResizeObserver | null = null
const isLong = (w: { height: number; view: Element | null }) => w.height > (w.view?.clientHeight || window.innerHeight) * LONG_SHARE
const recheck = (view?: Element) => {
  for (const w of watched.values()) if (!view || w.view === view) w.set(isLong(w))
}
const recheckAll = () => recheck()

/** Whether the message `ref` sits in is taller than about the chat's height (`on` false: never, and not watched). */
function useLongBlock(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [long, setLong] = useState(false)
  useEffect(() => {
    const block = ref.current?.parentElement
    if (!on || !block || typeof ResizeObserver === "undefined") return
    heights ??= new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = watched.get(e.target)
        if (!w) {
          if (views.has(e.target)) recheck(e.target)
          continue
        }
        w.height = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height
        w.set(isLong(w))
      }
    })
    if (!watched.size) window.addEventListener("resize", recheckAll)
    const view = block.closest(SCROLLER)
    watched.set(block, { height: 0, view, set: setLong })
    heights.observe(block)
    if (view) {
      if (!views.has(view)) heights.observe(view)
      views.set(view, (views.get(view) ?? 0) + 1)
    }
    return () => {
      watched.delete(block)
      heights?.unobserve(block)
      if (view) {
        const left = (views.get(view) ?? 1) - 1
        if (left) views.set(view, left)
        else {
          views.delete(view)
          heights?.unobserve(view)
        }
      }
      if (!watched.size) window.removeEventListener("resize", recheckAll)
    }
  }, [ref, on])
  return on && long
}

export interface MenuItem {
  icon: LucideIcon
  label: string
  run: () => void
}

/** The ··· menu: in a portal (a transcript's scroller would clip it), under the button or above it when there's no room. */
export function MessageMenu({ trigger, items, onClose, label = "Message actions", className }: { trigger: RefObject<HTMLButtonElement | null>; items: MenuItem[]; onClose: () => void; label?: string; className?: string }) {
  const panel = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const place = () => {
      const t = trigger.current?.getBoundingClientRect()
      const el = panel.current
      if (!t || !el) return
      const vw = document.documentElement.clientWidth || window.innerWidth
      const left = Math.max(8, Math.min(t.right - el.offsetWidth, vw - 8 - el.offsetWidth))
      const below = window.innerHeight - t.bottom - 12
      setStyle(el.offsetHeight > below && t.top > below ? { left, bottom: window.innerHeight - t.top + 4 } : { left, top: t.bottom + 4 })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [trigger])

  // A hidden menu cannot take focus in browsers. Wait for placement to make it visible before moving focus.
  useLayoutEffect(() => {
    if (style.visibility !== "hidden") panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true })
  }, [style.visibility])

  // A press anywhere else closes it; the ··· button toggles it itself.
  useEffect(() => {
    const down = (e: Event) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return
      closeRef.current()
    }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [trigger])

  const move = (e: KeyboardEvent) => {
    e.stopPropagation()
    const all = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault()
      onClose()
      trigger.current?.focus({ preventScroll: true })
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus()
    }
  }

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={move}
      className={cx("fixed z-40 w-max max-w-[calc(100vw-1rem)] min-w-48 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-2xl shadow-black/50", className)}
    >
      {items.map(({ icon: Icon, label, run }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            trigger.current?.focus({ preventScroll: true })
            run()
          }}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm whitespace-nowrap text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:bg-zinc-800 focus-visible:outline-none pointer-fine:min-h-0 pointer-fine:py-1.5"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          {label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

/** The message as a Markdown quote, to paste into another chat. */
export function quoteLines(text: string) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}
