// Settings' building blocks, on their own so the first-run setup card (Setup.tsx) can use them without pulling the
// whole Settings dialog into the first load (SettingsHost.tsx loads that on demand).
import { useId, useState, type ReactNode } from "react"
import { SETTINGS_SECTIONS, settingsPath, type SettingsSection } from "../lib/settingsNav"
import { SettingsCategory, SettingsField, SearchHighlight, highlightSettingsText, useSettingsSearching } from "../lib/settingsSearch"
import { TAP_AREA, cx } from "./ui"
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

/** A setting's name, wherever it's shown: Settings' rows, a project's settings and New project. */
export const SETTING_LABEL = "text-sm font-medium text-zinc-200"
const SETTING_HELP = "text-xs leading-relaxed text-zinc-500"

/**
 * The rest of a help text, after the sentence that says what the setting does: closed until More is pressed, and open
 * while Settings' search is on, so a match in it shows. It stays in the page while closed, which is how search finds it.
 */
export function HelpMore({ about, children }: { about: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const searching = useSettingsSearching()
  const id = useId()
  return (
    <>
      <span id={id} hidden={!open && !searching}>
        {" "}
        {highlightSettingsText(children)}
      </span>
      {!searching && (
        <>
          {" "}
          <button
            type="button"
            data-settings-search-ignore
            aria-expanded={open}
            aria-controls={id}
            aria-label={`${open ? "Less" : "More"} about ${about}`}
            onClick={() => setOpen(!open)}
            // A word in the sentence, so its line's height (over .settings-body's 44px for buttons): TAP_AREA is its 44px to a finger.
            className={cx(TAP_AREA, "min-h-0! min-w-0! rounded text-zinc-300 underline underline-offset-2 hover:text-zinc-100 pointer-coarse:after:-inset-x-2!")}
          >
            {open ? "Less" : "More"}
          </button>
        </>
      )}
    </>
  )
}

/**
 * One setting: label and help text on the left, the control and where its value comes from on the right. `wide`
 * stacks them, for a control that needs the row's width (a grid of cards). `more` is the rest of a long help, behind
 * More (HelpMore): `help` is then the one sentence that says what the setting does.
 */
export function Row({ id, label, help, more, hint, wide, children }: { id?: string; label: string; help: ReactNode; more?: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    // Two columns by the row's own width, not the window's: at 125% zoom the sidebar leaves the help text a sliver.
    <SettingsField label={label} className="@container border-t border-zinc-900 py-4 first:border-t-0 first:pt-0">
      <div className={cx("grid grid-cols-1 gap-x-8 gap-y-2", !wide && "@md:grid-cols-[minmax(0,1fr)_17rem]")}>
        <div className="min-w-0">
          <label htmlFor={id} className={SETTING_LABEL}>
            <SearchHighlight text={label} />
          </label>
          <div className={cx("mt-1", SETTING_HELP)}>
            {highlightSettingsText(help)}
            {more && <HelpMore about={label}>{more}</HelpMore>}
          </div>
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
 * A setting with its control under its label, where a form stacks them (a project's settings, New project): Row's label
 * and help styles, so those read as Settings does. The help sits outside the `<label>`, so it isn't part of the
 * control's name and its More button isn't nested in one.
 */
export function StackedField({ label, htmlFor, hint, more, children }: { label: string; htmlFor?: string; hint?: ReactNode; more?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      {htmlFor ? (
        // Its control by id, for a field with other controls beside it: a wrapping label would name the first of them.
        <>
          <label htmlFor={htmlFor} className={cx("block", SETTING_LABEL)}>
            {label}
          </label>
          {children}
        </>
      ) : (
        <label className="block space-y-1.5">
          <span className={cx("block", SETTING_LABEL)}>{label}</span>
          {children}
        </label>
      )}
      {hint && (
        <p className={SETTING_HELP}>
          {hint}
          {more && <HelpMore about={label}>{more}</HelpMore>}
        </p>
      )}
    </div>
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
      {/* Under the dropdown it's the panel's first line: smaller there, so it doesn't outrank the field labels. */}
      <p data-settings-description className={cx("text-sm text-zinc-500", inNav ? "@3xl/settings-tabs:mt-1 @max-3xl/settings-tabs:text-xs @max-3xl/settings-tabs:leading-relaxed" : "mt-1")}>{description}</p>
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
