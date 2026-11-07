// The category tabs of a settings dialog, with the panel beside them: Settings and a project's settings both use it.
// Under @3xl of its container (a phone, a narrow window, 125% zoom) the tabs fold into a dropdown above the panel.
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react"
import type { LucideIcon } from "lucide-react"
import { stepTab } from "../lib/settingsNav"
import { Select, cx } from "./ui"

export interface SettingsTab<K extends string> {
  key: K
  label: string
  icon: LucideIcon
}

/** A tab's dot: a field to fix wins over unsaved changes. */
export type TabMark = "problem" | "unsaved" | null

const MARK_SUFFIX = { problem: " · needs a fix", unsaved: " · unsaved" }

export function SettingsTabs<K extends string>({
  tabs,
  selected,
  onSelect,
  mark,
  label,
  selectLabel,
  idPrefix,
  navHidden,
  className,
  panelRef,
  panelRole = "tabpanel",
  panelLabel,
  children,
}: {
  tabs: readonly SettingsTab<K>[]
  selected: K
  onSelect: (key: K) => void
  mark: (key: K) => TabMark
  /** The tab list's accessible name ("Settings categories"); the dropdown's is `selectLabel` ("Settings category"). */
  label: string
  selectLabel: string
  /** Tabs get the ids `<idPrefix>-tab-<key>`, the panel `<idPrefix>-panel`. */
  idPrefix: string
  /** Hides the tabs, not the panel (Settings while it shows search results). */
  navHidden?: boolean
  className?: string
  panelRef?: Ref<HTMLDivElement>
  panelRole?: "tabpanel" | "region"
  panelLabel: string
  children: ReactNode
}) {
  const navRef = useRef<HTMLDivElement>(null)
  const onNavKey = (e: ReactKeyboardEvent) => {
    const keys = tabs.map((t) => t.key)
    const delta = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key]
    const next = e.key === "Home" ? keys[0] : e.key === "End" ? keys.at(-1) : delta ? stepTab(keys, selected, delta) : undefined
    if (!next) return
    e.preventDefault()
    onSelect(next)
    navRef.current?.querySelector<HTMLElement>(`[data-section=${next}]`)?.focus()
  }
  return (
    <div className={cx("settings-layout flex min-h-0 flex-1 flex-col @3xl:flex-row", className)}>
      <div hidden={navHidden} className="shrink-0 border-b border-zinc-900 p-3 @3xl:hidden">
        <Select aria-label={selectLabel} className="w-full" value={selected} onChange={(e) => onSelect(e.target.value as K)}>
          {tabs.map((t) => {
            const m = mark(t.key)
            return <option key={t.key} value={t.key}>{t.label}{m ? MARK_SUFFIX[m] : ""}</option>
          })}
        </Select>
      </div>
      <div
        hidden={navHidden}
        ref={navRef}
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        onKeyDown={onNavKey}
        className="scroll-thin hidden w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-zinc-900 p-3 @3xl:flex"
      >
        {tabs.map(({ key, label, icon: Icon }) => {
          const on = key === selected
          const m = mark(key)
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${key}`}
              data-section={key}
              aria-selected={on}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(key)}
              className={cx(
                "flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none motion-reduce:transition-none",
                on ? "bg-zinc-800/80 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
            >
              <Icon className={cx("h-4 w-4 shrink-0", on ? "text-yard-400" : "text-zinc-500")} />
              {label}
              {m === "problem" ? (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-red-400" title="Needs a fix" />
              ) : (
                m === "unsaved" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
              )}
            </button>
          )
        })}
      </div>
      <div
        ref={panelRef}
        role={panelRole}
        id={`${idPrefix}-panel`}
        aria-label={panelLabel}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5 @3xl:px-7 @3xl:py-6"
      >
        {children}
      </div>
    </div>
  )
}
