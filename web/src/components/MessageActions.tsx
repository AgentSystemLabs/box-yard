// A chat message's actions: Reply, which opens the message's reply thread (SideThread.tsx), and Copy, which copies
// the message as it was written (its Markdown). The Coordinator or the Captain reads each message sent to a thread and
// answers it there, sends it on to the task's agent, or posts it in the main chat (server/sideThreads.ts), so there's
// nothing to pick first. They only show in a chat with threads.
// With a mouse, a message up to about a screen tall has them in a small toolbar on its top-right edge (as on
// claude.ai), on hover and keyboard focus; it moves into the message's top corner rather than lie on the card above. A
// message taller than about the chat's height has Reply and Copy pills down its right side instead: a mouse over the
// message shows them at the top of the part on screen, in a gutter of their own, and a click on its text puts them at
// the click's height, so they're never a scroll away.
// On touch nothing lies over the chat's text. A tap on a message tints it and puts Reply and Copy in a row under it,
// in room the message makes for them (the rows after it move down, the tapped message stays where it is); a tap on
// it again, a tap anywhere else or Esc puts them away. A long message gets them as a bar across its end, which stays
// at the bottom of the chat while that end is further down. The keyboard reaches both the same way. The chat's newest reply needs no tap: it ends with both
// as quiet buttons (StandingActions).
// Selecting text in a long message while its pills or bar are out turns them into "Reply quoting selection" and "Copy
// selection". All are placed inside the message (no portal) and show and hide at once, with no fade. Text stays
// selectable: nothing here sets user-select on it or handles a long press. Copy says "Copied" in place.
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react"
import { createPortal } from "react-dom"
import { Check, Copy, Quote, Reply, type LucideIcon } from "lucide-react"
import { useReplyTo } from "./SideThread"
import { rejoinListBottom, releaseListBottom } from "./StickyScroll"
import { copyText } from "../lib/clipboard"
import { onSuspend } from "../lib/resume"
import { toast } from "../lib/toast"
import { COPIED_MS, TAP_AREA, cx } from "./ui"

/**
 * The classes for the element a MessageActions sits in (a bubble, a reply, a notice card): the hover group and the
 * actions' positioning box. With a mouse a long message's pills get a gutter on the right, so they never cover the
 * text; on touch the message makes room under itself for its row (`data-under`) or its bar (`data-dock`). Child-scoped
 * `:has()`, so only this block restyles.
 */
export const MESSAGE_BLOCK = "group/msg relative has-[>[data-gutter]]:pr-12 has-[>[data-under]]:mb-14 has-[>[data-dock]]:mb-16"

/** What a tap on a message means by itself; tapping one of these inside it doesn't show the actions. */
const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role=button], [role=link], [role=menuitem]"

/** A toolbar button (a mouse). Reply says its word; Copy is its icon (`w-7`). */
const BUTTON =
  "inline-flex h-6 items-center justify-center gap-1.5 rounded-md text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"

const TITLE = "Reply in a thread: a question is answered there, and an instruction goes on to whoever acts on it"

/** A button in a row under a message (touch): quiet, drawn 36px tall and 44px to a finger in its 44px row. */
const ROW_BUTTON = cx(
  TAP_AREA,
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none",
)
/** The row itself, under its message in the room MESSAGE_BLOCK makes (`data-under`). */
const ROW = "absolute top-full z-10 flex h-11 items-center gap-1.5 select-none"
/** How far under its message the row reaches: its 44px. */
const ROW_ROOM = 44

/**
 * A long message's bar (touch): a band in the chat's own colour across the message's end, so where it stays at the
 * bottom of the chat the text ends above it, as it does above the composer, and no line shows half under it. In it,
 * two 44px halves in one border.
 */
const BAND = "pointer-events-auto sticky bottom-0 bg-zinc-950 py-1 select-none"
const BAR = "flex h-[46px] items-stretch rounded-full border bg-zinc-900"
const BAR_HALF =
  "flex min-w-0 flex-1 items-center justify-center gap-1.5 text-xs font-medium first:rounded-l-full last-of-type:rounded-r-full hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none focus-visible:ring-inset"

/** A long message's two pills with a mouse (Reply, Copy: 44px wide in its 48px gutter, 52px tall) and the gap between them. */
const PILLS_HEIGHT = 52 * 2 + 4
const PILL =
  "flex h-[52px] w-11 flex-col items-center justify-center gap-0.5 rounded-full border bg-zinc-900 text-[10px] font-medium shadow-lg shadow-black/40 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"

/** Where a short message's toolbar is with a mouse: half over the message's top edge, or in its top corner. */
type Place = "above" | "inside"
/** A tapped message (touch): which end of it its row is under, and whether it has no box of its own for the tint to fill. */
interface Under {
  right: boolean
  bare: boolean
}

/** Keeps the actions' clicks and keys from the row under them (a notice card opens its task, a notice row folds). */
const stop = (e: SyntheticEvent) => e.stopPropagation()

/** A finger, not a mouse: nothing hovers, or the pointer is coarse. */
const TOUCH = ["(hover: none)", "(pointer: coarse)"]
const isTouch = () => TOUCH.some((q) => window.matchMedia?.(q).matches)
const watchTouch = (changed: () => void) => {
  const lists = TOUCH.map((q) => window.matchMedia?.(q))
  for (const l of lists) l?.addEventListener?.("change", changed)
  return () => {
    for (const l of lists) l?.removeEventListener?.("change", changed)
  }
}
const useTouch = () => useSyncExternalStore(watchTouch, isTouch, () => false)

/**
 * Copies, and says so for COPIED_MS, like CopyButton (ui.tsx): the chat's toasts leave out plain confirmations.
 * `after` runs once that's said, or at once when the browser refused.
 */
function useCopied(after?: () => void) {
  const [copied, setCopied] = useState(false)
  const flash = useRef<ReturnType<typeof setTimeout>>(undefined)
  const then = useRef(after)
  then.current = after
  useEffect(() => () => clearTimeout(flash.current), [])
  const forget = useCallback(() => {
    clearTimeout(flash.current)
    setCopied(false)
  }, [])
  const copy = useCallback(async (text: string) => {
    clearTimeout(flash.current)
    if (!(await copyText(text))) {
      setCopied(false)
      then.current?.()
      return void toast.error("Couldn't copy", "The browser blocked clipboard access.")
    }
    setCopied(true)
    flash.current = setTimeout(() => {
      setCopied(false)
      then.current?.()
    }, COPIED_MS)
  }, [])
  return { copied, copy, forget }
}

/** A button's word as CSS content (`after:content-[…]`), so it's never part of the message's text: a copy, a search, a row's textContent. */
const word = (content: string) => <span aria-hidden className={content} />

/**
 * `anchorId`: the chat message's id, which its reply thread hangs off. Without one, or outside a chat with threads, it shows nothing.
 * `standing`: the message ends with its StandingActions, so on touch a tap on it shows no row (a long one keeps its bar, which quotes).
 */
export const MessageActions = memo(function MessageActions({ text, anchorId, className, standing = false }: { text: string; anchorId?: string; className?: string; standing?: boolean }) {
  const replyTo = useReplyTo()
  const reply = anchorId && text.trim() ? replyTo : null
  const touch = useTouch()
  const bar = useRef<HTMLDivElement>(null)
  const pills = useRef<HTMLDivElement>(null)
  /** Taller than about the chat's height: the pills or the bar instead of the toolbar or the row. */
  const long = useLongBlock(bar, Boolean(reply))
  /** Touch: the message's actions are out under it, since a tap on it (or the keyboard reaching them). */
  const [tapped, setTapped] = useState<Under | null>(null)
  /** A mouse, a short message: where the toolbar has room, as of the hover or focus that showed it. */
  const [place, setPlace] = useState<Place>("above")
  /** A mouse, a long message: the pills' top in the message, where it was clicked (null: hidden). */
  const [pill, setPill] = useState<number | null>(null)
  /** Text selected in a long message while its pills or bar are out: they quote it. */
  const [quote, setQuote] = useState<string | null>(null)
  /** The quote when they were pressed: on a phone the selection may be gone by the click. */
  const pressed = useRef<string | null>(null)
  /** Just copied: Copy says so in place, and the toolbar or pills stay up while it does. A row or bar stays anyway. */
  const { copied, copy: copyNow, forget } = useCopied(() => setPill(null))

  /** The row or bar is out (touch), for the handlers that open it. */
  const isOut = useRef(false)
  isOut.current = tapped !== null
  // Put away: a chat that was following its bottom when they came out (holdStill) follows it again.
  const wasOut = useRef(false)
  useLayoutEffect(() => {
    const block = bar.current?.parentElement
    if (wasOut.current && !tapped && block) rejoinListBottom(block)
    wasOut.current = tapped !== null
  }, [tapped])

  useEffect(() => {
    const block = bar.current?.parentElement
    if (!block || !reply) return
    if (!touch && !long) {
      // A mouse or the keyboard shows the toolbar by itself (CSS); this only finds where it has room.
      const settle = () => setPlace(placeFor(block))
      block.addEventListener("mouseenter", settle)
      block.addEventListener("focusin", settle)
      return () => {
        block.removeEventListener("mouseenter", settle)
        block.removeEventListener("focusin", settle)
      }
    }
    // A short message that ends with its standing actions needs no row on a tap.
    if (touch && !long && standing) return
    const tap = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.(INTERACTIVE)
      if ((hit && hit !== block && block.contains(hit)) || !window.getSelection()?.isCollapsed) return
      if (!touch) return setPill(pillTop(block, e.clientY))
      if (!isOut.current) holdStill(block, long)
      setTapped((was) => (was ? null : under(block)))
    }
    block.addEventListener("click", tap)
    return () => block.removeEventListener("click", tap)
  }, [reply, long, standing, touch])

  const shown = touch ? tapped !== null : pill !== null

  useEffect(() => {
    if (!shown) return
    const hide = () => {
      forget()
      setTapped(null)
      setPill(null)
    }
    const away = (e: Event) => {
      if (!bar.current?.parentElement?.contains(e.target as Node)) hide()
    }
    // Esc puts them away first, before whatever the chat does with Esc.
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
    // A finger puts them away when its tap ends, not when it lands: the rows under the message move up as its row
    // goes, and a tap that started on one of them would end on whatever slid under it.
    const press = touch ? "click" : "pointerdown"
    document.addEventListener(press, away, true)
    document.addEventListener("keydown", key, true)
    // The app going to the background (a phone's home-screen app is frozen, not closed): put them away, so a thaw
    // doesn't bring back actions whose tap is long over.
    const off = onSuspend(hide)
    return () => {
      document.removeEventListener(press, away, true)
      document.removeEventListener("keydown", key, true)
      off()
    }
  }, [shown, forget, touch])

  // A long message's pills or bar scrolled out of view: they're gone, rather than waiting where Cody left them.
  const out = long && shown
  useEffect(() => {
    const el = pills.current
    if (!out || !el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e || e.isIntersecting) return
        setTapped(null)
        setPill(null)
      },
      { root: el.closest(SCROLLER) },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [out])

  // The bar stays clear of what floats over the chat's bottom edge ("Jump to latest" comes and goes with the scroll).
  const docked = touch && out
  useLayoutEffect(() => {
    const el = pills.current
    const block = bar.current?.parentElement
    if (!docked || !el || !block) return
    const view = block.closest(SCROLLER)
    let frame = 0
    const dock = () => {
      frame = 0
      const { bottom, beside, above } = dockFor(el)
      el.style.bottom = `${bottom}px`
      el.style.paddingRight = beside ? `${beside}px` : ""
      el.style.paddingBottom = above ? `${above}px` : ""
    }
    dock()
    const scrolled = () => {
      frame ||= requestAnimationFrame(dock)
    }
    view?.addEventListener("scroll", scrolled, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      view?.removeEventListener("scroll", scrolled)
      el.style.bottom = ""
      el.style.paddingRight = ""
      el.style.paddingBottom = ""
    }
  }, [docked])

  // Text selected in the message while they're out: they offer to quote it (the pills, beside the selection's end).
  useEffect(() => {
    const block = bar.current?.parentElement
    if (!out || !block) return setQuote(null)
    const read = () => {
      const sel = window.getSelection()
      const within = sel && !sel.isCollapsed && sel.rangeCount > 0 && block.contains(sel.anchorNode) && block.contains(sel.focusNode)
      const picked = within ? sel.toString().trim() : ""
      setQuote(picked || null)
      if (!picked || touch) return
      const rects = sel!.getRangeAt(0).getClientRects()
      const end = backwards(sel!) ? rects[0] : rects[rects.length - 1]
      if (end) setPill(pillTop(block, end.top + end.height / 2))
    }
    document.addEventListener("selectionchange", read)
    return () => document.removeEventListener("selectionchange", read)
  }, [out, touch])

  if (!reply) return null

  const open = () => {
    const quoted = pressed.current ?? quote
    pressed.current = null
    setTapped(null)
    setPill(null)
    if (!quoted) return reply(anchorId!, text)
    reply(anchorId!, text, `${quoteLines(quoted)}\n\n`)
    window.getSelection()?.removeAllRanges()
  }

  /** The selection while the pills or bar quote it, else the whole message as written. */
  const copy = () => {
    const picked = pressed.current ?? quote
    pressed.current = null
    void copyNow(picked ?? text)
  }
  /** Read out once; the buttons show it. */
  const said = (
    <span role="status" className="sr-only">
      {copied ? "Copied" : ""}
    </span>
  )
  const quoting = out && quote !== null

  if (touch) {
    // Its standing actions have them.
    if (standing && !long) return <div ref={bar} hidden />
    // The keyboard (or a screen reader) reaching the buttons brings them out, as a tap on the message does.
    const reach = () => {
      const block = bar.current?.parentElement
      if (!block) return
      if (!isOut.current) holdStill(block, long)
      setTapped((was) => was ?? under(block))
    }
    // Still, and drawn from this state: the message the row or bar under it belongs to.
    const tint = tapped && (
      <span aria-hidden data-message-tint className={cx("pointer-events-none absolute bg-zinc-400/10", tapped.bare ? "-inset-x-2 -inset-y-1 rounded-lg" : "inset-0 rounded-[inherit]")} />
    )
    if (long) {
      return (
        <>
          {tint}
          {/* As tall as the message and the room under it: the bar rests in that room, under the tint, and sticks to the
              bottom of the chat while the message's end is further down. */}
          <div
            ref={bar}
            data-reply-pill
            data-open={tapped ? "" : undefined}
            data-dock={tapped ? "" : undefined}
            data-quote={quoting || undefined}
            onClick={stop}
            onAuxClick={stop}
            onKeyDown={stop}
            className={cx("peer/bar pointer-events-none absolute top-0 -bottom-14.5 z-10 flex flex-col justify-end", tapped?.bare ? "-inset-x-2" : "inset-x-0", className)}
          >
            <div ref={pills} role="toolbar" aria-label="Message actions" onFocus={reach} className={tapped ? cx(BAND, tapped.bare && "px-2") : "sr-only"}>
              <div className={cx(BAR, quoting ? "border-yard-400/60" : "border-zinc-700")}>
                <button
                  type="button"
                  data-testid="message-reply"
                  aria-label={quoting ? "Reply quoting selection" : "Reply in a thread"}
                  title={quoting ? "Reply in a thread, quoting the selected text" : TITLE}
                  // Pressing it keeps the selection it quotes, and the focus where it is.
                  onPointerDown={() => (pressed.current = quote)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={open}
                  className={cx(BAR_HALF, quoting ? "text-yard-200" : "text-zinc-300")}
                >
                  {quoting ? <Quote className="h-4 w-4" aria-hidden /> : <Reply className="h-4 w-4" aria-hidden />}
                  {word(quoting ? "after:content-['Quote']" : "after:content-['Reply']")}
                </button>
                <span aria-hidden className={cx("my-2.5 w-px shrink-0", quoting ? "bg-yard-400/40" : "bg-zinc-700")} />
                <button
                  type="button"
                  data-testid="message-copy"
                  aria-label={quoting ? "Copy selection" : "Copy message"}
                  title={quoting ? "Copy the selected text" : "Copy message"}
                  onPointerDown={() => (pressed.current = quote)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={copy}
                  data-copied={copied || undefined}
                  className={cx(BAR_HALF, copied ? "text-emerald-300" : quoting ? "text-yard-200" : "text-zinc-300")}
                >
                  {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {word(copied ? "after:content-['Copied']" : "after:content-['Copy']")}
                </button>
              </div>
              {said}
            </div>
          </div>
        </>
      )
    }
    return (
      <>
        {tint}
        <div
          ref={bar}
          role="toolbar"
          aria-label="Message actions"
          data-message-actions
          data-open={tapped ? "" : undefined}
          data-under={tapped ? "" : undefined}
          onClick={stop}
          onAuxClick={stop}
          onKeyDown={stop}
          onFocus={reach}
          // Under the end of the message that's on its side of the chat, its glyphs in line with the message's edge.
          className={cx(tapped ? cx(ROW, tapped.right ? (tapped.bare ? "-right-2" : "right-0") : tapped.bare ? "-left-2" : "left-0") : "sr-only", className)}
        >
          <button type="button" data-testid="message-reply" aria-label="Reply in a thread" title={TITLE} onClick={open} className={cx(ROW_BUTTON, "text-zinc-400 hover:text-zinc-100")}>
            <Reply className="h-4 w-4" aria-hidden />
            {word("after:content-['Reply']")}
          </button>
          <button
            type="button"
            data-testid="message-copy"
            aria-label="Copy message"
            title={copied ? "Copied" : "Copy message"}
            data-copied={copied || undefined}
            onClick={copy}
            className={cx(ROW_BUTTON, copied ? "text-emerald-400" : "text-zinc-400 hover:text-zinc-100")}
          >
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {word(copied ? "after:content-['Copied']" : "after:content-['Copy']")}
          </button>
          {said}
        </div>
      </>
    )
  }

  if (long) {
    return (
      // The gutter: a column down the message's right edge. Clicked, the pills sit in it at the click's height;
      // otherwise they're hidden at the top of the message's visible part (sticky), where a mouse over the message or
      // keyboard focus shows them without a scroll.
      <div
        ref={bar}
        data-reply-pill
        data-gutter
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
              ? "pointer-events-auto absolute right-0"
              : copied
                ? "pointer-events-auto sticky top-2"
                : "sticky top-2 opacity-0 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
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
    )
  }

  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label="Message actions"
      data-message-actions
      data-open={copied || undefined}
      data-inside={place === "inside" || undefined}
      onClick={stop}
      onAuxClick={stop}
      onKeyDown={stop}
      className={cx(
        // Half over the message's top edge; in its top corner when that would lie on the card above.
        "absolute -top-3.5 right-2 z-10 flex items-center gap-px rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 shadow-lg shadow-black/40 data-inside:top-0.5",
        // Hidden (and not catching clicks) until the message is hovered or focused.
        "pointer-events-none opacity-0",
        "group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 data-open:pointer-events-auto data-open:opacity-100",
        className,
      )}
    >
      {/* Each word is CSS content, like the pills'. */}
      <button type="button" data-testid="message-reply" aria-label="Reply in a thread" title={TITLE} onClick={open} className={cx(BUTTON, "px-1.5 after:content-['Reply']")}>
        <Reply className="h-3.5 w-3.5" aria-hidden />
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
        // It grows a word only for as long as it says "Copied".
        className={cx(BUTTON, copied ? "px-1.5 text-emerald-400! after:content-['Copied']" : "w-7")}
      >
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
      {said}
    </div>
  )
})

/**
 * How the chat's newest reply ends on touch, where nothing hovers: Reply and Copy as quiet buttons in a row of their
 * own, which need no tap on the message first (a mouse has the hover toolbar). `children` (its next steps) follow in a
 * block of their own, under a rule: those send a message, these don't.
 */
export function StandingActions({ text, anchorId, children }: { text: string; anchorId?: string; children?: ReactNode }) {
  const replyTo = useReplyTo()
  const touch = useTouch()
  const reply = touch && anchorId && text.trim() ? replyTo : null
  const { copied, copy } = useCopied()
  return (
    <>
      {reply && (
        // A long reply's bar has them while it's out (`peer/bar`, MessageActions): they aren't offered twice.
        <div data-message-row className="mt-1 -ml-2 flex h-11 items-center gap-1.5 peer-data-open/bar:hidden">
          <button type="button" data-testid="message-row-reply" aria-label="Reply in a thread" title={TITLE} onClick={() => reply(anchorId!, text)} className={cx(ROW_BUTTON, "text-zinc-400 hover:text-zinc-100")}>
            <Reply className="h-4 w-4" aria-hidden />
            Reply
          </button>
          <button
            type="button"
            data-testid="message-row-copy"
            aria-label="Copy message"
            title="Copy message"
            data-copied={copied || undefined}
            onClick={() => void copy(text)}
            className={cx(ROW_BUTTON, copied ? "text-emerald-400" : "text-zinc-400 hover:text-zinc-100")}
          >
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
          <span role="status" className="sr-only">
            {copied ? "Copied" : ""}
          </span>
        </div>
      )}
      {children && <div data-next-steps className={cx(reply && "mt-1 border-t border-zinc-800/80 pt-1")}>{children}</div>}
    </>
  )
}

/** A chat's scroller (StickyScroll): what "on screen" means for a message in it. */
const SCROLLER = "[data-scroller]"

/**
 * Before a message makes room under itself for its row or bar: a chat that follows its bottom lets go of it
 * (StickyScroll), or it would scroll by that room and the message would jump up from under the finger that tapped it.
 * A short message whose row wouldn't be on screen keeps following instead, which brings the row into view.
 */
function holdStill(block: HTMLElement, long: boolean) {
  const view = block.closest(SCROLLER)
  if (!long && view && block.getBoundingClientRect().bottom + ROW_ROOM > view.getBoundingClientRect().bottom) return
  releaseListBottom(block)
}
/** What floats over a chat's bottom edge ("Jump to latest", the new-cards pill): the pills and the bar stay above it. */
const FLOATING = "[data-chat-float] button"

/** The toolbar's width, about (Reply's word and Copy's icon), and how far it stands out over its message's top edge. */
const TOOLBAR = { width: 100, reach: 14 }

/**
 * Whether the toolbar may cover this point: it's on screen, in the chat's scroller, not under a sticky header, and
 * not on something with a click of its own (the card above and its Retry, a link, a chip).
 */
function clear(block: HTMLElement, view: Element | null, x: number, y: number) {
  const at = document.elementFromPoint(x, y)
  if (!at || (view && !view.contains(at)) || at.closest("header")) return false
  // The toolbar itself, when it's already out.
  if (block.contains(at)) return true
  const taps = at.closest(INTERACTIVE)
  return !taps || taps.contains(block)
}

/** Where `block`'s toolbar has room (a mouse). */
function placeFor(block: HTMLElement): Place {
  if (typeof document.elementFromPoint !== "function") return "above"
  const { width, reach } = TOOLBAR
  const r = block.getBoundingClientRect()
  const view = block.closest(SCROLLER)
  // Its corners and middle, a little inside its edges (it stands 8px in from the message's right edge), at its far
  // edge too: it reaches only a pixel or two onto the card above.
  const xs = [r.right - 16, r.right - 8 - width / 2, r.right - width]
  return [r.top - reach + 1, r.top - 3].every((y) => xs.every((x) => clear(block, view, x, y))) ? "above" : "inside"
}

/** A tapped message's row (touch): under its right end when it's on the right of the chat, as Cody's bubbles are. */
function under(block: HTMLElement): Under {
  const r = block.getBoundingClientRect()
  const view = block.closest(SCROLLER)?.getBoundingClientRect()
  return {
    right: Boolean(view && r.left - view.left > view.right - r.right + 1),
    bare: !(parseFloat(getComputedStyle(block).paddingLeft) > 0),
  }
}

/** The narrowest the bar's capsule gets beside what floats over the chat's bottom: its two halves, each with its word. */
const BAR_MIN = 144

/**
 * Where a long message's bar (`band`, touch) docks at the bottom of its chat: on the chat's edge, its capsule
 * `beside` (to the left of) what floats there and as far `above` the edge, or `bottom` px up, over it, when that
 * leaves the capsule no room. The band's own place isn't read: only where it would stand, so docking it never moves
 * what's measured.
 */
function dockFor(band: HTMLElement) {
  const scroller = band.closest(SCROLLER)
  const box = band.parentElement?.getBoundingClientRect()
  // A sticky edge is the scroller's padding edge: this much lower is the chat's own.
  const edged = scroller ? -(parseFloat(getComputedStyle(scroller).paddingBottom) || 0) : 0
  if (!box) return { bottom: edged, beside: 0, above: 0 }
  const edge = Math.min(scroller?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight)
  // The band on the chat's edge, or under its message's end when that is in view.
  const bottom = Math.min(edge, box.bottom)
  const top = bottom - band.offsetHeight
  let left = box.right
  let lift = edge
  let low = 0
  for (const el of document.querySelectorAll(FLOATING)) {
    const f = el.getBoundingClientRect()
    if (!f.height || f.right <= box.left || f.left >= box.right || f.top >= bottom || f.bottom <= top) continue
    left = Math.min(left, f.left)
    lift = Math.min(lift, f.top)
    low = Math.max(low, f.bottom)
  }
  if (left === box.right) return { bottom: edged, beside: 0, above: 0 }
  const beside = Math.round(box.right - left) + 8
  const room = box.width - beside - (parseFloat(getComputedStyle(band).paddingLeft) || 0)
  return room >= BAR_MIN
    ? { bottom: edged, beside, above: Math.max(0, Math.round(edge - low)) }
    : { bottom: Math.round(edge - lift) + 4 + edged, beside: 0, above: 0 }
}

/**
 * The pills' top in `block` for a click at `y` (viewport, a mouse): centred on it, inside the message and inside the
 * part of it on screen.
 */
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
