// The one loading state for content (chats, panels, settings): a still skeleton, no spinner and no motion. It holds
// its space from the first frame but stays invisible until the load has taken LOADING_DELAY_MS (lib/loading.ts), so
// a quick response goes straight to the content and a slow one never shifts the layout on its way in.
import { useDelayedFlag } from "../lib/loading"
import { cx } from "./ui"

const FILL = "bg-zinc-800/70"
const BAR = `rounded ${FILL}`
// Line widths per paragraph, so a chat skeleton reads as text rather than a grid.
const PARAGRAPHS = [
  ["w-11/12", "w-full", "w-3/5"],
  ["w-2/3", "w-1/3"],
  ["w-full", "w-5/6", "w-11/12", "w-2/5"],
]

export type LoadingKind = "chat" | "rows" | "field" | "line"

export function Loading({
  kind = "rows",
  label = "Loading",
  count,
  className,
}: {
  /**
   * chat: paragraphs of text (transcripts); rows: settings rows (label, help, control); field: one control, for a
   * row whose label is already there; line: one inline bar, for a status line.
   */
  kind?: LoadingKind
  /** What's loading, read out once the skeleton shows: "Loading the transcript". */
  label?: string
  /** Paragraphs (chat) or rows (rows). */
  count?: number
  className?: string
}) {
  const shown = useDelayedFlag(true)
  const state = { role: "status", "data-loading": shown ? "shown" : "waiting" } as const
  // Last, so `first:` styles on the rows don't move when it appears.
  const text = shown && <span className="sr-only">{label}…</span>
  if (kind === "line")
    return <span {...state} className={cx("inline-block h-2.5 w-24 max-w-full align-middle", BAR, !shown && "invisible", className)}>{text}</span>
  if (kind === "field") return <div {...state} className={cx("h-11 rounded-lg sm:h-9", FILL, !shown && "invisible", className)}>{text}</div>
  if (kind === "chat")
    return (
      <div {...state} className={cx("space-y-5", !shown && "invisible", className)}>
        {Array.from({ length: count ?? PARAGRAPHS.length }, (_, i) => (
          <div key={i} aria-hidden className="space-y-2.5">
            {PARAGRAPHS[i % PARAGRAPHS.length]!.map((w, j) => <div key={j} className={cx("h-3", BAR, w)} />)}
          </div>
        ))}
        {text}
      </div>
    )
  return (
    <div {...state} className={cx(!shown && "invisible", className)}>
      {Array.from({ length: count ?? 3 }, (_, i) => (
        // The settings Row's own grid (SettingsBlocks.tsx), so the real rows land where these were.
        <div key={i} aria-hidden className="@container border-t border-zinc-900 py-4 first:border-t-0 first:pt-0">
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 @md:grid-cols-[minmax(0,1fr)_17rem]">
            <div className="space-y-2">
              <div className={cx("h-3.5 w-28", BAR)} />
              <div className={cx("h-2.5 w-full max-w-sm", BAR)} />
              <div className={cx("h-2.5 w-2/3 max-w-xs", BAR)} />
            </div>
            <div className={cx("h-11 rounded-lg sm:h-9", FILL)} />
          </div>
        </div>
      ))}
      {text}
    </div>
  )
}
