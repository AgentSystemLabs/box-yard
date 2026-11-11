// Settings' building blocks, on their own so the first-run setup card (Setup.tsx) can use them without pulling the
// whole Settings dialog into the first load (SettingsHost.tsx loads that on demand).
import type { ReactNode } from "react"
import { SETTINGS_SECTIONS, settingsPath, type SettingsSection } from "../lib/settingsNav"
import { SettingsCategory, SettingsField, SearchHighlight, highlightSettingsText, useSettingsSearching } from "../lib/settingsSearch"
import { cx } from "./ui"
import type { SettingSource } from "../../../shared/types"

const SOURCE_LABEL: Record<Exclude<SettingSource, "default">, string> = { ui: "saved here", env: "from env" }

/** Where a value comes from, when that's worth saying: a default says nothing, so a panel of them isn't a column of chips. */
export function SourceHint({ source, env, changed }: { source?: SettingSource; env?: string; changed: boolean }) {
  if (changed) return <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">unsaved</span>
  if (!source || source === "default") return null
  return (
    <span
      className={cx("rounded px-1.5 py-px text-[11px]", source === "ui" ? "bg-yard-500/15 text-yard-300" : "bg-zinc-800 text-zinc-400")}
      title={source === "env" && env ? `Set by the ${env} env var. Saving here overrides it.` : undefined}
    >
      {SOURCE_LABEL[source]}
      {source === "env" && env && <span className="ml-1 font-mono text-zinc-500">{env}</span>}
    </span>
  )
}

/** On a dialog's Save while there is nothing to save: plainly off, where a dimmed gold still reads as ready in dark. */
export const SAVE_IDLE = "disabled:bg-zinc-800! disabled:text-zinc-400! disabled:opacity-100!"

/**
 * One setting: label and help text on the left, the control and where its value comes from on the right. `wide`
 * stacks them, for a control that needs the row's width (a grid of cards).
 */
export function Row({ id, label, help, hint, wide, children }: { id?: string; label: string; help: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    // Two columns by the row's own width, not the window's: at 125% zoom the sidebar leaves the help text a sliver.
    <SettingsField label={label} className="@container border-t border-zinc-900 py-4 first:border-t-0 first:pt-0">
      <div className={cx("grid grid-cols-1 gap-x-8 gap-y-2", !wide && "@md:grid-cols-[minmax(0,1fr)_17rem]")}>
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-zinc-200">
            <SearchHighlight text={label} />
          </label>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">{highlightSettingsText(help)}</div>
        </div>
        <div className="min-w-0 space-y-1.5">
          {highlightSettingsText(children)}
          {hint && <div className="flex flex-wrap gap-1 empty:hidden">{hint}</div>}
        </div>
      </div>
    </SettingsField>
  )
}

/**
 * A category's title and what it holds, above its fields: Settings' panels and a project's settings tabs. `inNav`: the
 * tabs name it too, so once they fold into the dropdown right above (SettingsTabs), only a screen reader gets the title.
 */
export function PanelFrame({ title, description, inNav, children }: { title: ReactNode; description: ReactNode; inNav?: boolean; children: ReactNode }) {
  return (
    <>
      <h3 className={cx("text-base font-semibold text-zinc-50", inNav && "@max-3xl/settings-tabs:sr-only")}>{title}</h3>
      <p data-settings-description className={cx("text-sm text-zinc-500", inNav ? "@3xl/settings-tabs:mt-1" : "mt-1")}>{description}</p>
      <div className="mt-6">{children}</div>
    </>
  )
}

export function Panel({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const info = SETTINGS_SECTIONS.find((s) => s.key === section)!
  const searching = useSettingsSearching()
  return (
    <SettingsCategory section={section}>
      {/* A provider's own panel sits under Box providers in the tabs, so it keeps its title; so do search results. */}
      <PanelFrame title={<SearchHighlight text={searching ? settingsPath(section).join(" › ") : info.label} />} description={info.description} inNav={!searching && !info.parent}>
        {children}
      </PanelFrame>
    </SettingsCategory>
  )
}
