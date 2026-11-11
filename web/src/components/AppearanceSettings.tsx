import { useRef, type KeyboardEvent } from "react"
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import { setTheme, useTheme, type ThemePreference } from "../lib/theme"
import { useDraft } from "../lib/settingsDraft"
import { Panel, Row } from "./SettingsBlocks"
import { cx } from "./ui"

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

export function AppearancePanel() {
  const saved = useTheme()
  const [theme, set] = useDraft("theme", "appearance", saved, setTheme)
  const group = useRef<HTMLDivElement>(null)
  // Arrows move the choice, as in a native radio group. It's a draft like the rest: Save applies it.
  const onKey = (e: KeyboardEvent) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!delta) return
    e.preventDefault()
    const at = THEMES.findIndex((t) => t.value === theme)
    const next = THEMES[(at + delta + THEMES.length) % THEMES.length]!.value
    set(next)
    group.current?.querySelector<HTMLElement>(`[data-theme-choice=${next}]`)?.focus()
  }
  return (
    <Panel section="appearance">
      {/* No id: the row's <label> would name one radio. The group's aria-label names them all. */}
      <Row label="Theme" help="System follows your device. Kept in this browser. Applies when you Save.">
        <div ref={group} role="radiogroup" aria-label="Theme" onKeyDown={onKey} className="grid grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          {THEMES.map(({ value, label, icon: Icon }) => {
            const on = value === theme
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-theme-choice={value}
                onClick={() => set(value)}
                className={cx(
                  "flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md px-1 text-sm",
                  on ? "bg-zinc-700 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
                )}
              >
                <Icon aria-hidden className={cx("h-4 w-4 shrink-0", on ? "text-yard-400" : "text-zinc-500")} />
                <span className="truncate">{label}</span>
              </button>
            )
          })}
        </div>
      </Row>
    </Panel>
  )
}
