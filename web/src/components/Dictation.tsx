import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { Mic, X } from "lucide-react"
import { keyLabel, type DictationError, type DictationMachine } from "../lib/dictation"
import { dictationSupported, isMac, useDictationSettings, useDictationState } from "../lib/useDictation"
import { isTouchDevice } from "../lib/composer"
import { Button, cx } from "./ui"

const ERROR_TEXT: Record<DictationError, string> = {
  denied:
    "Microphone access is blocked for this site. Click the lock or microphone icon in the address bar, allow the microphone, then try again.",
  "no-mic": "No microphone was found. Plug one in or pick one in your system's sound settings, then try again.",
  network: "Speech recognition couldn't reach its service. Check your connection and try again.",
  failed: "Dictation stopped unexpectedly. Try again.",
}

/** The composer's mic: press and hold to talk, release to stop; a click (or Enter/Space on it) toggles. */
export function MicButton({ machine }: { machine: DictationMachine }) {
  const settings = useDictationSettings()
  const state = useDictationState(machine)
  if (!settings.enabled || !dictationSupported()) return null
  const on = state.phase !== "idle"
  // A phone has no key to hold, and it's tapped, not clicked.
  const touch = isTouchDevice()
  const chord = touch || settings.key === "off" ? "" : ` (hold ${keyLabel(settings.key, isMac())})`
  const label = on ? "Stop dictation" : `Dictate: hold to talk, ${touch ? "tap" : "click"} to toggle${chord}`
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cx("h-11 w-11 shrink-0 touch-none !p-0 select-none pointer-fine:@min-[32rem]/composer:h-8 pointer-fine:@min-[32rem]/composer:min-h-0 pointer-fine:@min-[32rem]/composer:w-8 pointer-fine:@min-[32rem]/composer:min-w-0", on && "bg-red-500/15 !text-red-400 hover:bg-red-500/25")}
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-testid="mic"
      // Keep focus (and the caret) in the textarea.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        machine.press()
      }}
      onPointerUp={() => machine.release()}
      onPointerCancel={() => machine.release()}
      onClick={(e) => {
        // Pointer clicks are handled by down/up; detail 0 is a keyboard or assistive-tech click.
        if (e.detail === 0) machine.toggle()
      }}
    >
      <Mic className="h-4 w-4" aria-hidden />
    </Button>
  )
}

/** "Listening…" with the words heard so far (gray until final), or why dictation stopped. */
export function DictationStatus({ machine }: { machine: DictationMachine }) {
  const state = useDictationState(machine)
  if (state.error)
    return (
      <div role="alert" className="flex items-start gap-2 px-2 pb-2 text-xs text-amber-300">
        <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{ERROR_TEXT[state.error]}</span>
        <button type="button" className="-my-3 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-500 hover:text-zinc-200 pointer-fine:-my-1 pointer-fine:h-6 pointer-fine:w-6" aria-label="Dismiss" onClick={() => machine.clearError()}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  if (state.phase === "idle") return null
  return (
    <div className="flex items-baseline gap-2 px-2 pb-1.5 text-xs">
      {/* Only the phase is announced: the words change several times a second, and land in the text anyway. */}
      <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center gap-1.5 font-medium text-red-400">
        <span aria-hidden className="h-2 w-2 rounded-full bg-red-500" />
        {state.phase === "stopping" ? "Finishing…" : "Listening…"}
      </span>
      <Interim text={state.interim} />
    </div>
  )
}

/**
 * The words heard so far. Longer than the line, they lose their oldest words, whole ones, and start with "…": the
 * newest stay in view.
 */
function Interim({ text }: { text: string }) {
  const line = useRef<HTMLSpanElement>(null)
  const dots = useRef<HTMLSpanElement>(null)
  const all = useRef<HTMLSpanElement>(null)
  // Where the shown words start in `text`: 0 while they all fit.
  const [from, setFrom] = useState(0)
  const measure = useCallback(() => {
    const words = all.current?.firstChild
    const room = line.current?.getBoundingClientRect().width ?? 0
    const width = all.current?.getBoundingClientRect().width ?? 0
    if (!(words instanceof Text) || width <= room + 0.5) return setFrom(0)
    // The first word that fits with every word after it, behind the "…".
    const need = width + (dots.current?.getBoundingClientRect().width ?? 0) - room
    const range = document.createRange()
    range.setStart(words, 0)
    const starts = Array.from(words.data.matchAll(/\s+(?=\S)/g), (m) => m.index + m[0].length)
    let lo = 0
    let hi = starts.length - 1
    // One word wider than the line: it's shown from its start, cut at its end.
    let fits = starts.at(-1) ?? 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      range.setEnd(words, starts[mid]!)
      if (range.getBoundingClientRect().width >= need - 0.5) {
        fits = starts[mid]!
        hi = mid - 1
      } else lo = mid + 1
    }
    setFrom(fits)
  }, [])
  // Measured on new words, and whenever the line changes width (a resized panel) or the words do (a font that just loaded).
  useLayoutEffect(measure, [measure, text])
  useLayoutEffect(() => {
    const ro = new ResizeObserver(measure)
    if (line.current) ro.observe(line.current)
    if (all.current) ro.observe(all.current)
    return () => ro.disconnect()
  }, [measure])
  return (
    <span ref={line} aria-hidden className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap text-zinc-500 italic">
      {/* Never seen: the "…" and every word at their full width, to measure against the line. */}
      <span className="invisible absolute top-0 left-0">
        <span ref={dots}>…</span>
        <span ref={all}>{text}</span>
      </span>
      <span data-testid="interim">{from > 0 && from < text.length ? `…${text.slice(from)}` : text}</span>
    </span>
  )
}
