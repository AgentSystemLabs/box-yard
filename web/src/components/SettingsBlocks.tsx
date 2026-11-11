// Settings' building blocks, on their own so the first-run setup card (Setup.tsx) can use them without pulling the
// whole Settings dialog into the first load (SettingsHost.tsx loads that on demand).
import { Children, createContext, isValidElement, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useSearchParams } from "wouter"
import { ChevronRight } from "lucide-react"
import { SETTINGS_PARAM, SETTINGS_SECTIONS, settingsPath, type SettingsSection } from "../lib/settingsNav"
import { SettingsCategory, SettingsField, SearchHighlight, highlightSettingsText, useSettingsSearchResults, useSettingsSearchWords } from "../lib/settingsSearch"
import { useOpenSettings } from "./SettingsHost"
import { withParam } from "./TaskFilters"
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
/** A stacked field's label with its "unsaved" chip beside it (a project's settings). */
export const LABEL_LINE = "flex flex-wrap items-center gap-x-2"

/**
 * A button that reads as a word in running text (help, a hint): its line's height, over .settings-body's 44px for every
 * button (styles.css), and still 44px to a finger (TAP_AREA). INLINE_LINK is the one that goes somewhere.
 */
const INLINE_BUTTON = cx(TAP_AREA, "min-h-0! min-w-0! rounded underline-offset-2 pointer-coarse:after:-inset-x-2!")
export const INLINE_LINK = cx(INLINE_BUTTON, "text-yard-400 hover:underline")

/**
 * Set by a dialog that can sit on top of Settings (a project's settings, opened from Settings › Projects): `param` is
 * the URL parameter that holds it open, `mayLeave` its unsaved-changes prompt (false: the user kept it open).
 */
export const OverSettings = createContext<{ param: string; mayLeave: () => Promise<boolean> } | null>(null)

/**
 * Opens a Settings category from a link in a help text. In a dialog on top of Settings, that dialog closes first:
 * Settings would otherwise change unseen behind it.
 */
export function useSettingsLink() {
  const openSettings = useOpenSettings()
  const [params, setParams] = useSearchParams()
  const over = useContext(OverSettings)
  return async (section: SettingsSection) => {
    if (!over || !params.has(SETTINGS_PARAM)) return openSettings(section)
    if (!(await over.mayLeave())) return
    // One navigation for both: two in a row would each start from the URL as it is now.
    setParams((p) => withParam(withParam(p, over.param, null), SETTINGS_PARAM, section), { replace: true })
  }
}

/** "Settings › Credentials" in a help text, as a link to that category. */
export function SettingsLink({ section, children, className, testId }: { section: SettingsSection; children: ReactNode; className?: string; testId?: string }) {
  const open = useSettingsLink()
  return (
    <button type="button" className={cx(INLINE_LINK, className)} onClick={() => void open(section)} data-testid={testId}>
      {children}
    </button>
  )
}

/**
 * Ties a control to its help text, so a screen reader reads the help with it: the help's id joins the control's
 * aria-describedby, ahead of its error's. From here, not as a prop, because a row's control is whatever has the row's
 * id (a Select, a picker's button). After every render: React rewrites the attribute when an error comes or goes.
 */
export function useHelpFor(control: () => Element | null | undefined, helpId: string | false) {
  useLayoutEffect(() => {
    const el = helpId ? control() : null
    if (!el || !helpId) return
    const ids = el.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? []
    if (!ids.includes(helpId)) el.setAttribute("aria-describedby", [helpId, ...ids].join(" "))
  })
}

/** A help text's words, for search. */
function textOfNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (isValidElement<{ children?: ReactNode }>(node)) return textOfNode(node.props.children)
  return Children.toArray(node).map(textOfNode).join("")
}

/**
 * The rest of a help text, after the sentence that says what the setting does: closed until More is pressed. Settings'
 * search opens it only for a word found in it, so other results stay short. It stays in the page while closed, which is
 * how search finds it.
 */
export function HelpMore({ about, children }: { about: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const words = useSettingsSearchWords()
  const id = useId()
  const hidden = words.length ? textOfNode(children).toLocaleLowerCase() : ""
  const found = words.some((w) => hidden.includes(w))
  const shown = open || found
  return (
    <>
      <span id={id} hidden={!shown}>
        {" "}
        {highlightSettingsText(children)}
      </span>
      {!found && (
        <>
          {" "}
          <button
            type="button"
            data-settings-search-ignore
            aria-expanded={open}
            aria-controls={id}
            aria-label={`${open ? "Less" : "More"} about ${about}`}
            onClick={() => setOpen(!open)}
            className={cx(INLINE_BUTTON, "text-zinc-300 underline hover:text-zinc-100")}
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
 * More (HelpMore): `help` is then the one sentence that says what the setting does. `changed` puts "unsaved" beside
 * the label, as StackedField does. The control with the row's `id` is described by the help (useHelpFor); with no
 * `id`, the controls are a group that the label names and the help describes.
 */
export function Row({ id, label, help, more, hint, changed, wide, children }: { id?: string; label: string; help: ReactNode; more?: ReactNode; hint?: ReactNode; changed?: boolean; wide?: boolean; children: ReactNode }) {
  const own = useId()
  const labelId = `${id ?? own}-label`
  const helpId = `${id ?? own}-help`
  useHelpFor(() => (id ? document.getElementById(id) : null), helpId)
  return (
    // Two columns by the row's own width, not the window's: at 125% zoom the sidebar leaves the help text a sliver. In
    // search results the first row keeps its rule and padding, under its category's one-line header (Panel).
    <SettingsField label={label} className="@container border-t border-zinc-900 py-4 first:border-t-0 first:pt-0 in-[.settings-searching]:first:border-t! in-[.settings-searching]:first:pt-4!">
      <div className={cx("grid grid-cols-1 gap-x-8 gap-y-2", !wide && "@md:grid-cols-[minmax(0,1fr)_17rem]")}>
        <div className="min-w-0">
          <span className={LABEL_LINE}>
            <label htmlFor={id} id={labelId} className={SETTING_LABEL}>
              <SearchHighlight text={label} />
            </label>
            <SourceHint changed={Boolean(changed)} />
          </span>
          <div className={cx("mt-1", SETTING_HELP)}>
            {/* The id is on the sentence alone, so More isn't read out as part of it. */}
            <span id={helpId}>{highlightSettingsText(help)}</span>
            {more && <HelpMore about={label}>{more}</HelpMore>}
          </div>
        </div>
        <div className="min-w-0 space-y-1.5" {...(!id && { role: "group", "aria-labelledby": labelId, "aria-describedby": helpId })}>
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
export function StackedField({ label, htmlFor, hint, more, changed, children }: { label: string; htmlFor?: string; hint?: ReactNode; more?: ReactNode; changed?: boolean; children: ReactNode }) {
  const helpId = `${useId()}-help`
  const wrap = useRef<HTMLLabelElement>(null)
  // The control the label names: the one with its id, else the first inside it.
  useHelpFor(() => (htmlFor ? document.getElementById(htmlFor) : wrap.current?.querySelector("input, select, textarea, button")), Boolean(hint) && helpId)
  return (
    <div className="min-w-0 space-y-1.5">
      {htmlFor ? (
        // Its control by id, for a field with other controls beside it: a wrapping label would name the first of them.
        <>
          <span className={LABEL_LINE}>
            <label htmlFor={htmlFor} className={SETTING_LABEL}>
              {label}
            </label>
            <SourceHint changed={Boolean(changed)} />
          </span>
          {children}
        </>
      ) : (
        <label ref={wrap} className="block space-y-1.5">
          <span className={LABEL_LINE}>
            <span className={SETTING_LABEL}>{label}</span>
            <SourceHint changed={Boolean(changed)} />
          </span>
          {children}
        </label>
      )}
      {hint && (
        <p className={SETTING_HELP}>
          <span id={helpId}>{hint}</span>
          {more && <HelpMore about={label}>{more}</HelpMore>}
        </p>
      )}
    </div>
  )
}

/**
 * A category's title and what it holds, above its fields: Settings' panels and a project's settings tabs. `inNav`: the
 * tabs name it too, so once they fold into the dropdown right above (SettingsTabs), only a screen reader gets the title.
 * `compact` is a one-line heading in their place, with the fields right under it (Settings' search results). The fields
 * keep their place in the tree either way, so starting a search doesn't reset them.
 */
export function PanelFrame({ title, description, inNav, compact, children }: { title: ReactNode; description: ReactNode; inNav?: boolean; compact?: ReactNode; children: ReactNode }) {
  return (
    <>
      {compact ? <h3 className="-mx-2">{compact}</h3> : <h3 className={cx("text-base font-semibold text-zinc-50", inNav && "@max-3xl/settings-tabs:sr-only")}>{title}</h3>}
      {/* Under the dropdown it's the panel's first line: smaller there, so it doesn't outrank the field labels. */}
      {!compact && <p data-settings-description className={cx("text-sm text-zinc-500", inNav ? "@3xl/settings-tabs:mt-1 @max-3xl/settings-tabs:text-xs @max-3xl/settings-tabs:leading-relaxed" : "mt-1")}>{description}</p>}
      <div className={compact ? undefined : "mt-6"}>{children}</div>
    </>
  )
}

export function Panel({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const info = SETTINGS_SECTIONS.find((s) => s.key === section)!
  const results = useSettingsSearchResults(section)
  return (
    <SettingsCategory section={section}>
      <PanelFrame
        title={info.label}
        description={info.description}
        // A provider's own panel sits under Box providers in the tabs, so it keeps its title.
        inNav={!info.parent}
        // In search results a category is one line, "Coordinator · 4 ›", right above its matching fields: pressing it
        // leaves search for that category.
        compact={
          results && (
            <button
              type="button"
              onClick={results.open}
              title={`Open ${info.label}`}
              // 36px to a mouse and 44px to a finger, as the category tabs are (SettingsTabs).
              className="flex min-h-9! max-w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm font-semibold text-zinc-100 hover:bg-zinc-900 pointer-coarse:min-h-11!"
            >
              <span className="min-w-0 truncate">
                <SearchHighlight text={settingsPath(section).join(" › ")} />
              </span>
              <span className="shrink-0 font-normal text-zinc-400">
                · {results.count}
                <span className="sr-only"> matching {results.count === 1 ? "field" : "fields"}</span>
              </span>
              <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>
          )
        }
      >
        {children}
      </PanelFrame>
    </SettingsCategory>
  )
}
