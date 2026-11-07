// List controls shared by the project Tasks tab and the Yard view: tab bar, search box, sort select, quiet-runs toggle.
import { Moon } from "lucide-react"
import { cx } from "./ui"

/** A copy of `params` with `key` set, or removed when `value` is empty. */
export function withParam(params: URLSearchParams, key: string, value: string | null) {
  const next = new URLSearchParams(params)
  if (value) next.set(key, value)
  else next.delete(key)
  return next
}

/** True when a key press should go to a text field, not a page shortcut. */
export function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  return Boolean(e.metaKey || e.ctrlKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable=true]"))
}

/** The "Show quiet runs" switch. `count` is how many quiet runs it would show (or is showing). */
export function QuietSwitch({ checked, onChange, count, className }: { checked: boolean; onChange: (show: boolean) => void; count?: number; className?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title="Quiet runs are schedule runs that found nothing to do and changed nothing."
      className={cx(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium whitespace-nowrap transition sm:min-h-9",
        checked ? "border-yard-500/40 bg-yard-500/10 text-yard-300" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
        className,
      )}
    >
      <Moon className="h-3.5 w-3.5" />
      Show quiet runs
      {count !== undefined && <span className={cx("tabular-nums", checked ? "text-yard-300/70" : "text-zinc-500")}>{count}</span>}
    </button>
  )
}
