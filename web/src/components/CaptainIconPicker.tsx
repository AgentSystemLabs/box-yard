// The Captain icon picker: Settings › Coordinator › Captain icon (every Captain's) and a project's settings › General ›
// Captain icon (its own, or "Use default"). It shows the pick with its name; "Choose icon" opens the catalogue in place,
// not in a dialog over the dialog: a search, then every icon by group, 44px each, as one radio group. A pick only
// changes the form's draft, which Save applies. The icons' components load when it opens (CaptainIcon.tsx), and only
// the settings that hold it (lazy parts) import this, so the first screen carries neither.
import { useDeferredValue, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ChevronDown, Search } from "lucide-react"
import { CAPTAIN_ICON_GROUPS, captainIconInfo, captainIcons, searchCaptainIcons, type CaptainIconId, type CaptainIconInfo } from "../../../shared/captainIcons"
import type { ProjectColor } from "../../../shared/projectColors"
import { CaptainGlyph, useCaptainIconCatalog } from "./CaptainIcon"
import { Loading } from "./Loading"
import { projectColorStyle } from "./TaskIcon"
import { cx, inputClass } from "./ui"

/** What "Use default" gives a project's Captain now: its preview and its name ("Your project's image"). */
export interface CaptainIconDefault {
  preview: ReactNode
  label: string
}

const TILE = "grid h-11 w-11 shrink-0 place-items-center rounded-lg"
const RADIO =
  "focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none aria-checked:bg-zinc-800 aria-checked:ring-1 aria-checked:ring-yard-500/70"

/** The next radio for an arrow key: ←/→ go through them in order; ↑/↓ go to the nearest one in the row above or below. */
function nextRadio(radios: HTMLElement[], from: HTMLElement, key: string): HTMLElement | undefined {
  const i = radios.indexOf(from)
  if (key === "Home") return radios[0]
  if (key === "End") return radios.at(-1)
  if (key === "ArrowRight") return radios[Math.min(i + 1, radios.length - 1)]
  if (key === "ArrowLeft") return radios[Math.max(i - 1, 0)]
  const at = from.getBoundingClientRect()
  const down = key === "ArrowDown"
  const rows = radios.map((r) => ({ r, box: r.getBoundingClientRect() })).filter(({ box }) => (down ? box.top > at.top + 1 : box.top < at.top - 1))
  // No layout to go by (or no row there): one along, as ←/→.
  if (!rows.length || at.height === 0) return radios[down ? Math.min(i + 1, radios.length - 1) : Math.max(i - 1, 0)]
  const top = down ? Math.min(...rows.map(({ box }) => box.top)) : Math.max(...rows.map(({ box }) => box.top))
  const x = at.left + at.width / 2
  return rows.filter(({ box }) => Math.abs(box.top - top) < 1).sort((a, b) => Math.abs(a.box.left + a.box.width / 2 - x) - Math.abs(b.box.left + b.box.width / 2 - x))[0]?.r
}

/**
 * Pick a Captain icon. `value` null is "Use default", offered only with `useDefault` (a project's picker), which says
 * what the default shows. `color` tints the icons as the Captain will be (its project's colour); without one they take
 * the yard's. `status` is a line under it: which icon shows now, and why.
 */
export function CaptainIconPicker({
  value,
  onChange,
  color = null,
  useDefault,
  status,
  testId = "captain-icon-picker",
  id,
  label = "Captain icon",
}: {
  value: CaptainIconId | null
  onChange: (id: CaptainIconId | null) => void
  color?: ProjectColor | null
  useDefault?: CaptainIconDefault
  status?: ReactNode
  testId?: string
  /** The toggle's id, for its field's `<label htmlFor>`. */
  id?: string
  /** What the icons are, for a screen reader. */
  label?: string
}) {
  const ids = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const toggle = useRef<HTMLButtonElement>(null)
  const info = value ? captainIconInfo(value) : undefined
  const tint = color ? "text-(--pc)" : "text-yard-300"
  const close = () => {
    setOpen(false)
    setQuery("")
    toggle.current?.focus()
  }
  // Esc clears the search, then closes the catalogue, before the dialog around it (Modal skips a handled key).
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return
    e.preventDefault()
    if (query && e.target instanceof HTMLInputElement) setQuery("")
    else close()
  }
  return (
    <div data-testid={testId} style={projectColorStyle(color)} className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden data-testid={`${testId}-preview`} className={cx(TILE, "bg-zinc-800/80", tint)}>
          {value ? <CaptainGlyph id={value} className="h-6 w-6" /> : useDefault?.preview}
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span id={`${ids}-current`} data-testid={`${testId}-current`} className="block truncate font-medium text-zinc-100">
            {info ? info.label : useDefault ? "Default" : "Captain's cap"}
          </span>
          {!value && useDefault && <span className="block truncate text-xs text-zinc-500">{useDefault.label}</span>}
        </span>
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          aria-controls={`${ids}-panel`}
          aria-describedby={`${ids}-current`}
          id={id}
          data-testid={`${testId}-toggle`}
          onClick={() => (open ? close() : setOpen(true))}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none sm:min-h-9"
        >
          {open ? "Done" : "Choose icon"}
          <ChevronDown aria-hidden className={cx("h-4 w-4 text-zinc-500 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {status && (
        <p data-testid={`${testId}-status`} className="text-xs leading-relaxed text-zinc-500">
          {status}
        </p>
      )}
      {open && (
        <div id={`${ids}-panel`} onKeyDown={onPanelKey} className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-2">
          <IconCatalog
            value={value}
            onChange={onChange}
            tint={tint}
            useDefault={useDefault}
            query={query}
            onQuery={setQuery}
            label={label}
            testId={testId}
          />
        </div>
      )}
    </div>
  )
}

/** The search and the grid, once the catalogue's components are here. */
function IconCatalog({
  value,
  onChange,
  tint,
  useDefault,
  query,
  onQuery,
  label,
  testId,
}: {
  value: CaptainIconId | null
  onChange: (id: CaptainIconId | null) => void
  tint: string
  useDefault?: CaptainIconDefault
  query: string
  onQuery: (q: string) => void
  label: string
  testId: string
}) {
  const catalog = useCaptainIconCatalog(true)
  const grid = useRef<HTMLDivElement>(null)
  // Typing stays quick: the grid catches up a moment later.
  const deferred = useDeferredValue(query)
  const groups = useMemo(() => {
    const found = new Set(searchCaptainIcons(deferred).map((i) => i.id))
    return CAPTAIN_ICON_GROUPS.map((g) => ({ name: g.name, icons: captainIcons().filter((i) => i.group === g.name && found.has(i.id)) })).filter((g) => g.icons.length)
  }, [deferred])
  const count = groups.reduce((n, g) => n + g.icons.length, 0)
  const showDefault = Boolean(useDefault) && !deferred.trim()
  // One tab stop: the picked icon if it's in view, else the first.
  const tabStop: CaptainIconId | "default" | undefined =
    value === null && showDefault ? "default" : value && groups.some((g) => g.icons.some((i) => i.id === value)) ? value : showDefault ? "default" : groups[0]?.icons[0]?.id
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return
    const radios = [...(grid.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])]
    const from = e.target as HTMLElement
    if (!radios.includes(from)) return
    e.preventDefault()
    const to = nextRadio(radios, from, e.key)
    if (!to || to === from) return
    to.focus()
    to.click()
  }
  if (!catalog) return <Loading kind="field" label="Loading icons" />
  const radio = (i: CaptainIconInfo) => {
    const Icon = catalog[i.id]
    return (
      <button
        key={i.id}
        type="button"
        role="radio"
        aria-checked={value === i.id}
        aria-label={i.label}
        title={i.label}
        data-icon={i.id}
        tabIndex={tabStop === i.id ? 0 : -1}
        onClick={() => onChange(i.id)}
        className={cx(TILE, RADIO, tint, "hover:bg-zinc-800/70")}
      >
        <Icon aria-hidden className="h-5 w-5" />
      </button>
    )
  }
  return (
    <div className="space-y-2">
      <label className="relative block">
        <span className="sr-only">Search {label}s</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={`Search ${captainIcons().length} icons`}
          autoComplete="off"
          spellCheck={false}
          data-testid={`${testId}-search`}
          className={cx(inputClass, "pl-9")}
        />
      </label>
      <p aria-live="polite" className="sr-only">
        {deferred.trim() ? `${count} ${count === 1 ? "icon" : "icons"}` : ""}
      </p>
      <div
        ref={grid}
        role="radiogroup"
        aria-label={label}
        onKeyDown={onGridKey}
        data-testid={`${testId}-grid`}
        className="max-h-[min(22rem,50dvh)] space-y-3 overflow-y-auto overscroll-contain pr-1"
      >
        {showDefault && useDefault && (
          <button
            type="button"
            role="radio"
            aria-checked={value === null}
            aria-label={`Use default: ${useDefault.label}`}
            data-icon="default"
            tabIndex={tabStop === "default" ? 0 : -1}
            onClick={() => onChange(null)}
            className={cx("flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-zinc-200 hover:bg-zinc-800/70", RADIO)}
          >
            <span aria-hidden className={cx("grid h-8 w-8 shrink-0 place-items-center", tint)}>
              {useDefault.preview}
            </span>
            <span className="min-w-0">
              <span className="block font-medium">Use default</span>
              <span className="block truncate text-xs text-zinc-500">{useDefault.label}</span>
            </span>
          </button>
        )}
        {groups.map((g) => (
          <div key={g.name}>
            {/* The group's name is for the eye; each icon says its own. */}
            <div aria-hidden className="px-1 pb-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
              {g.name}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] justify-items-center gap-1">{g.icons.map(radio)}</div>
          </div>
        ))}
        {!count && (
          <p data-testid={`${testId}-empty`} className="px-1 py-6 text-center text-sm text-zinc-500">
            No icons match “{deferred.trim()}”. Try a word like ship, star or cat.
          </p>
        )}
      </div>
    </div>
  )
}
