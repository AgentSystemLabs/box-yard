// The category tabs of a settings dialog, with the panel beside them: Settings and a project's settings both use it.
// Under @3xl of its container (a phone, a narrow window, 125% zoom) the tabs fold into a dropdown above the panel.
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react"
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
const MARK_TITLE = { problem: "Needs a fix", unsaved: "Unsaved changes" }

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
  selectTrailing,
  selectHidden,
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
  /** Beside the dropdown, e.g. Settings' search button. */
  selectTrailing?: ReactNode
  /** Hides the dropdown's band alone (Settings' search field takes its place). */
  selectHidden?: boolean
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
  // The open category stays in view in a list taller than the dialog, on open and when a link or search moves it.
  useEffect(() => {
    if (!navHidden) navRef.current?.querySelector<HTMLElement>(`[data-section=${selected}]`)?.scrollIntoView?.({ block: "nearest" })
  }, [selected, navHidden])
  return (
    // A container of its own, by name: the tabs fold by it, and a panel's title hides by it (PanelFrame).
    <div className="@container/settings-tabs flex min-h-0 flex-1 flex-col">
      <div className={cx("settings-layout flex min-h-0 flex-1 flex-col @3xl/settings-tabs:flex-row", className)}>
        <div hidden={navHidden || selectHidden} className="flex shrink-0 gap-2 border-b border-zinc-900 p-3 @3xl/settings-tabs:hidden">
          <Select aria-label={selectLabel} className="min-w-0 flex-1" value={selected} onChange={(e) => onSelect(e.target.value as K)}>
            {tabs.map((t) => {
              const m = mark(t.key)
              return <option key={t.key} value={t.key}>{t.label}{m ? MARK_SUFFIX[m] : ""}</option>
            })}
          </Select>
          {selectTrailing}
        </div>
        <div
          hidden={navHidden}
          ref={navRef}
          role="tablist"
          aria-label={label}
          aria-orientation="vertical"
          onKeyDown={onNavKey}
          className="scroll-thin hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-zinc-900 p-3 @3xl/settings-tabs:flex"
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
                  // 36px to a mouse, so all of Settings' categories fit a 900px-tall window; 44px to a finger. The `!`
                  // is over .settings-body's 44px for every button (styles.css).
                  "flex min-h-9! shrink-0 items-center gap-2.5 rounded-lg px-3 py-1.5 text-left pointer-coarse:min-h-11! text-sm whitespace-nowrap transition focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none motion-reduce:transition-none",
                  on ? "bg-zinc-800/80 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                )}
              >
                <Icon className={cx("h-4 w-4 shrink-0", on ? "text-yard-400" : "text-zinc-500")} />
                {label}
                {m && (
                  <span className={cx("ml-auto h-1.5 w-1.5 shrink-0 rounded-full", m === "problem" ? "bg-red-400" : "bg-amber-400")} title={MARK_TITLE[m]}>
                    <span className="sr-only">{MARK_SUFFIX[m]}</span>
                  </span>
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
          // Focusable from code only: a dialog can open with focus here, not on its ×, and Tab then starts at the first field.
          tabIndex={-1}
          // scroll-pb: a field scrolled into view (a field to fix, a search result) brings what's under it too, its error first.
          className="scroll-thin min-h-0 flex-1 scroll-pb-24 overflow-y-auto px-4 py-5 focus-visible:outline-none! @3xl/settings-tabs:px-7 @3xl/settings-tabs:py-6"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
