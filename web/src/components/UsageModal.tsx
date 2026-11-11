// Usage: what Box Yard cost over the last 7, 30, 60 or 90 days, from the sidebar's Usage button (UsageHost.tsx). Daily
// cost stacks LLM spend by model on compute by provider; daily tokens stack input, cache writes, cache reads and output.
// Tapping a bar segment, a legend item, a day's line or a table row narrows everything to it, and the table goes one
// level finer each time, down to tasks and boxes. What it's narrowed to stays in a row of chips at the top while the
// numbers scroll, with its share of the range's total. One request per range: filters fold the ledger in the browser (shared/usageLedger.ts), and every
// number on screen adds up to the totals above it. Estimates wear "≈".
import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Settings as SettingsIcon, X } from "lucide-react"
import { Modal } from "./Modal"
import { Loading } from "./Loading"
import { SubscriptionLimits } from "./LoginLimits"
import { useUsageToSettings } from "./UsageHost"
import { Button, Select, TAP_AREA, cx, useMinuteClock } from "./ui"
import { prefetchUsageLedger, useUsageBudget, useUsageLedger } from "../lib/queries"
import { money, pct } from "../lib/usage"
import { axisMoney, compact, dayLabel, labelledDays, localDayStarts, longDayLabel, niceScale, roundedParts } from "../lib/usageChart"
import {
  OTHER_COLOR,
  TOKEN_COLORS,
  USAGE_COLORS,
  USAGE_GROUP_LABEL,
  USAGE_RANGES,
  aggregateUsage,
  filterLabel,
  modelSlots,
  nextGroup,
  type TokenKind,
  type UsageFilter,
  type UsageGroup,
  type UsageLedger,
  type UsageRangeDays,
  type UsageTableRow,
  type UsageView,
} from "../../../shared/usageLedger"
import type { BudgetStatus } from "../../../shared/types"

const FOCUS = "focus-visible:ring-2 focus-visible:ring-yard-400 focus-visible:outline-none"
const GROUPS: UsageGroup[] = ["project", "task", "model", "provider", "role", "box", "login"]
const FILTER_NAMES: Record<keyof UsageFilter, string> = { projectId: "Project", taskId: "Task", model: "Model", provider: "Provider", role: "Role", kind: "Only" }
const TABLE_ROWS = 20

/** "≈ $3.20" for an estimate. */
const usd = (n: number, estimate = false) => `${estimate && n > 0 ? "≈ " : ""}${money(n)}`

export function UsageModal({ days: range, onDays, onClose }: { days: UsageRangeDays; onDays: (d: UsageRangeDays) => void; onClose: () => void }) {
  const spendingId = useId()
  const now = useMinuteClock()
  const today = new Date(now).setHours(0, 0, 0, 0)
  const days = useMemo(() => localDayStarts(range, today), [range, today])
  const q = useUsageLedger(days)
  const ledger = q.data
  const qc = useQueryClient()
  // Another range's numbers start on their way as a pointer comes to its button, as the sidebar's Usage button does.
  const prefetch = (d: UsageRangeDays) => d !== range && void prefetchUsageLedger(qc, localDayStarts(d, today))
  const [filter, setFilter] = useState<UsageFilter>({})
  const [group, setGroup] = useState<UsageGroup>("project")
  const [day, setDay] = useState<number | null>(null)
  const slots = useMemo(() => (ledger ? modelSlots(ledger) : null), [ledger])
  const view = useMemo(() => (ledger && slots ? aggregateUsage(ledger, filter, group, slots) : null), [ledger, slots, filter, group])
  // A day picked in one range means nothing in another.
  const shownDay = view && day !== null && day < view.days.length ? day : null
  // The whole range's cost, added in the ledger's order as aggregateUsage adds it: what a filter's total is a share of.
  const rangeUsd = useMemo(() => {
    let sum = 0
    for (const r of ledger?.llm ?? []) sum += r.costUsd
    for (const r of ledger?.compute ?? []) sum += r.costUsd
    return sum
  }, [ledger])
  const set = useMemo(() => (Object.keys(filter) as (keyof UsageFilter)[]).filter((k) => filter[k] !== undefined).map((key) => ({ key, label: ledger ? filterLabel(ledger, key, filter[key]!) : "" })), [ledger, filter])
  // A row's second line that only repeats a filter (every task's project, once narrowed to that project) says nothing.
  const said = useMemo(() => set.map((f) => f.label), [set])

  const narrow = (f: UsageFilter, drillFrom?: UsageGroup) => {
    const next = { ...filter, ...f }
    setFilter(next)
    if (drillFrom) setGroup(nextGroup(drillFrom, next))
  }
  const drop = (key: keyof UsageFilter) =>
    setFilter((f) => {
      const { [key]: _, ...rest } = f
      return rest
    })

  return (
    <Modal size="wide" title="Usage" description="Subscription allowances, model usage and box costs" onClose={onClose} className="max-sm:h-dvh [&_[data-dismiss]]:h-11 [&_[data-dismiss]]:w-11">
      <div className="@container min-w-0 space-y-8" data-testid="usage-modal">
        <SubscriptionLimits />

        <section aria-labelledby={spendingId} className="min-w-0 space-y-4 border-t border-zinc-800 pt-6" data-testid="usage-spending">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id={spendingId} className="text-base font-semibold text-zinc-100">Cost &amp; tokens</h3>
              {/* The dates are the picked range's, not the loaded one's: they change with the button, before the numbers do. */}
              <p className="mt-1 text-xs text-zinc-500">
                {dayLabel(days[0]!)} – {dayLabel(days[days.length - 1]!)} · API-equivalent US dollars, not your subscription bill · ≈ estimated
              </p>
            </div>
            <RangePicker value={range} onChange={(d) => { onDays(d); setDay(null) }} onPrefetch={prefetch} />
          </div>
          {view && <FilterChips set={set} view={view} rangeUsd={rangeUsd} onDrop={drop} onClear={() => setFilter({})} />}
          {!view ? (
            q.isError ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 py-6 text-sm text-zinc-400">
                Couldn't load usage.
                <Button type="button" className="min-h-11 sm:min-h-11" onClick={() => void q.refetch()}>Retry costs</Button>
              </div>
            ) : (
              <Loading kind="rows" label="Loading usage" />
            )
          ) : (
            // Dimmed while they are still the last range's numbers.
            <div aria-busy={q.isPlaceholderData} className={cx("space-y-4", q.isPlaceholderData && "opacity-60")}>
              {view.totals.turns === 0 && view.totals.computeHours === 0 && view.totals.costUsd === 0 && view.totals.tokens.total === 0 && (
                <p className="text-sm text-zinc-400" data-testid="usage-empty">No recorded usage in this range{Object.keys(filter).length ? " for these filters" : ""}.</p>
              )}
              <Totals view={view} />
              <div className="grid items-start gap-4 @4xl:grid-cols-2">
                <CostChart view={view} day={shownDay} onDay={setDay} onNarrow={narrow} />
                <TokenChart view={view} day={shownDay} onDay={setDay} />
              </div>
              <Breakdown view={view} group={group} said={said} onGroup={setGroup} onDrill={(row) => row.filter && narrow(row.filter, group)} />
              <HowEstimated ledger={ledger!} />
            </div>
          )}
        </section>
        <CloudLimits />
      </div>
    </Modal>
  )
}

function RangePicker({ value, onChange, onPrefetch }: { value: UsageRangeDays; onChange: (d: UsageRangeDays) => void; onPrefetch: (d: UsageRangeDays) => void }) {
  return (
    <div role="group" aria-label="Range" className="grid w-full grid-cols-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 @sm:w-auto">
      {USAGE_RANGES.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value === d}
          aria-label={`Last ${d} days`}
          onClick={() => onChange(d)}
          onPointerEnter={() => onPrefetch(d)}
          onPointerDown={() => onPrefetch(d)}
          onFocus={() => onPrefetch(d)}
          className={cx("min-h-11 rounded-md px-3 text-sm font-medium whitespace-nowrap", FOCUS, value === d ? "bg-zinc-700 text-zinc-50" : "text-zinc-400 hover:text-zinc-100")}
        >
          {d}
          <span className="@sm:hidden">d</span>
          <span className="hidden @sm:inline"> days</span>
        </button>
      ))}
    </div>
  )
}

function FilterChips({ set, view, rangeUsd, onDrop, onClear }: { set: { key: keyof UsageFilter; label: string }[]; view: UsageView; rangeUsd: number; onDrop: (k: keyof UsageFilter) => void; onClear: () => void }) {
  // How to narrow is said in each chart's readout line.
  if (!set.length) return null
  const t = view.totals
  return (
    // Stays at the top of the dialog's scrolling body (over its padding, bleeding to its edges), so a tap on a table row far below shows
    // what it did and how much of the range is left. The chips shrink to a few letters, then scroll sideways; "Clear all"
    // stays put. Their share of the range is a line of its own under them until the dialog is wide enough for one row.
    <div role="group" aria-label="Filters" className="sticky -top-5 z-10 -mx-4 flex min-w-0 flex-wrap items-center gap-x-1.5 border-b border-zinc-800 bg-zinc-950 px-4 py-1.5 sm:-mx-5 sm:px-5 @lg:flex-nowrap @lg:gap-x-3" data-testid="usage-filters">
      <div className="scroll-thin flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto p-0.5">
        {set.map(({ key: k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => onDrop(k)}
            aria-label={`Remove filter ${FILTER_NAMES[k]}: ${label}`}
            title={`Remove the filter ${FILTER_NAMES[k]}: ${label}`}
            className={cx("inline-flex min-h-11 max-w-56 min-w-28 shrink items-center gap-1.5 rounded-full border border-yard-500/40 bg-yard-500/10 pr-2 pl-3 text-xs text-yard-100 hover:bg-yard-500/20", FOCUS)}
          >
            {/* The value says what kind it is ("Opus 5.5", "Task agents"): on a phone the room goes to it. */}
            <span className="hidden shrink-0 text-yard-300/80 @md:inline">{FILTER_NAMES[k]}</span>
            <span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </button>
        ))}
      </div>
      <p
        className="order-last basis-full px-0.5 pb-0.5 text-xs text-zinc-400 tabular-nums @lg:order-none @lg:shrink-0 @lg:basis-auto @lg:pb-0"
        title={set.length > 1 ? "These filters' share of the range's total" : "This filter's share of the range's total"}
        data-testid="usage-filter-share"
      >
        <span className="font-medium text-zinc-200">{usd(t.costUsd, t.estimatedUsd > 0)}</span> of {money(rangeUsd)} · {pct(t.costUsd, rangeUsd)}
      </p>
      {set.length > 1 && (
        <button type="button" onClick={onClear} aria-label="Clear all filters" className={cx("min-h-11 shrink-0 rounded-md px-2 text-xs text-zinc-400 hover:text-zinc-100", FOCUS)}>
          <span className="@md:hidden">Clear</span>
          <span className="hidden @md:inline">Clear all</span>
        </button>
      )}
    </div>
  )
}

function Tile({ label, value, sub, testId }: { label: string; value: string; sub: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5">
      <div className="text-xs text-zinc-400">{label}</div>
      <div data-testid={testId} className="mt-0.5 truncate text-xl font-semibold text-zinc-50 tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500 tabular-nums">{sub}</div>
    </div>
  )
}

function Totals({ view }: { view: UsageView }) {
  const t = view.totals
  const n = view.days.length
  const estimated = t.estimatedUsd > 0
  const runs = `${t.turns.toLocaleString("en-US")} ${t.turns === 1 ? "run" : "runs"}`
  const tokens = <Tile testId="usage-tokens" label="Tokens" value={compact(t.tokens.total)} sub={`${compact(t.tokens.total / n)} a day on average`} />
  // Without box time the total is the model cost: one tile says it, not three with the same figure.
  if (!(t.computeUsd > 0) && !(t.computeHours > 0))
    return (
      <div className="grid grid-cols-2 gap-2">
        <Tile testId="usage-total" label="Total" value={usd(t.costUsd, estimated)} sub={`${usd(t.costUsd / n, estimated)} a day · ${runs} · no box time`} />
        {tokens}
      </div>
    )
  const llmEstimated = view.cost.some((s) => s.kind === "llm" && s.estimated)
  const computeEstimated = view.cost.some((s) => s.kind === "compute" && s.estimated)
  return (
    <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
      <Tile testId="usage-total" label="Total" value={usd(t.costUsd, estimated)} sub={`${usd(t.costUsd / n, estimated)} a day on average`} />
      <Tile label="Model cost" value={usd(t.llmUsd, llmEstimated)} sub={`${runs} · ${pct(t.llmUsd, t.costUsd)}`} />
      <Tile label="Box cost" value={usd(t.computeUsd, computeEstimated)} sub={`${t.computeHours.toFixed(1)} box-hours · ${pct(t.computeUsd, t.costUsd)}`} />
      {tokens}
    </div>
  )
}

/** One stack of a chart: its colour, its daily values, and what tapping it does. */
type Stack = { key: string; label: string; color: string; daily: number[]; total: number; estimated?: boolean; pressed?: boolean; onPick?: () => void }

const colorOf = (i: number) => (i < 0 ? OTHER_COLOR : USAGE_COLORS[i]!)

function CostChart({ view, day, onDay, onNarrow }: { view: UsageView; day: number | null; onDay: (d: number | null) => void; onNarrow: (f: UsageFilter) => void }) {
  const plot = useRef<HTMLDivElement>(null)
  const stacks: Stack[] = view.cost.map((s) => ({ key: s.key, label: s.label, color: colorOf(s.color), daily: s.daily, total: s.totalUsd, estimated: s.estimated, onPick: s.filter ? () => onNarrow(s.filter!) : undefined }))
  return (
    <ChartCard title="Daily cost" sub="Models and boxes · US dollars" testId="usage-cost-chart" action={day !== null && <AllDays n={view.days.length} plot={plot} onDay={onDay} />}>
      <StackedBars plot={plot} days={view.days} stacks={stacks} byDay={view.costByDay} format={(n) => money(n)} unit={0.01} axis={axisMoney} day={day} onDay={onDay} noun="cost" />
    </ChartCard>
  )
}

function TokenChart({ view, day, onDay }: { view: UsageView; day: number | null; onDay: (d: number | null) => void }) {
  const plot = useRef<HTMLDivElement>(null)
  // Cache reads dwarf the rest; tapping a kind shows it alone, on its own scale.
  const [only, setOnly] = useState<TokenKind | null>(null)
  const stacks: Stack[] = view.tokens
    .filter((t) => !only || t.kind === only)
    .map((t) => ({ key: t.kind, label: t.label, color: TOKEN_COLORS[t.kind], daily: t.daily, total: t.total, pressed: only === t.kind, onPick: () => setOnly(only === t.kind ? null : t.kind) }))
  const byDay = only ? view.tokens.find((t) => t.kind === only)!.daily : view.tokensByDay
  if (view.totals.tokens.total === 0)
    return (
      <ChartCard title="Daily tokens" sub="Input, cache writes, cache reads and output" testId="usage-token-chart">
        <p className="mt-3 text-sm text-zinc-500">No model calls here: boxes use no tokens.</p>
      </ChartCard>
    )
  const legend: Stack[] = view.tokens.map((t) => ({ key: t.kind, label: t.label, color: TOKEN_COLORS[t.kind], daily: t.daily, total: t.total, pressed: only === t.kind, onPick: () => setOnly(only === t.kind ? null : t.kind) }))
  return (
    <ChartCard
      title="Daily tokens"
      sub={only ? `${legend.find((s) => s.pressed)!.label} only: tap it again for all four` : "Input, cache writes, cache reads and output"}
      testId="usage-token-chart"
      action={day !== null && <AllDays n={view.days.length} plot={plot} onDay={onDay} />}
    >
      <StackedBars plot={plot} days={view.days} stacks={stacks} legend={legend} legendFormat={compact} byDay={byDay} format={(n) => `${compact(n)} tokens`} axis={compact} day={day} onDay={onDay} noun="tokens" />
    </ChartCard>
  )
}

function ChartCard({ title, sub, testId, action, children }: { title: string; sub: string; testId: string; action?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} data-testid={testId} className="@container/chart min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:p-4">
      {/* As tall as its action, so nothing below moves when "All N days" comes and goes. */}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 id={id} className="min-w-0 text-sm font-semibold text-zinc-100">{title}</h4>
        {action}
      </div>
      <p className="text-xs text-zinc-500">{sub}</p>
      {children}
    </section>
  )
}

/** In a chart's title row while a day is picked: lets the day go. Focus goes to the plot, where ←/→ pick one again. */
function AllDays({ n, plot, onDay }: { n: number; plot: RefObject<HTMLDivElement | null>; onDay: (d: number | null) => void }) {
  return (
    <button
      type="button"
      title={`Back to all ${n} days`}
      onClick={() => {
        onDay(null)
        plot.current?.focus()
      }}
      className={cx(TAP_AREA, "inline-flex h-7 shrink-0 items-center rounded-md bg-zinc-800 px-2 text-xs font-medium whitespace-nowrap text-zinc-200 hover:bg-zinc-700", FOCUS)}
      data-testid="usage-all-days"
    >
      All {n} days
    </button>
  )
}

/**
 * Stacked daily bars with a y-axis, a legend and a readout. The readout shows the hovered day (mouse), else the picked
 * one (tap, click, a drag along the plot, ‹ ›, or ←/→ on the focused chart), else the whole range; the other days dim
 * while one is picked. A segment and a legend item narrow to their series. On a touch screen the first tap on a day
 * picks it and a second tap on a segment narrows, so a 3px bar of a 90-day chart never filters by accident.
 */
function StackedBars({
  plot,
  days,
  stacks,
  legend = stacks,
  legendFormat,
  byDay,
  format,
  unit,
  axis,
  day,
  onDay,
  noun,
}: {
  /** The focusable plot, for the card's "All N days". */
  plot: RefObject<HTMLDivElement | null>
  days: number[]
  stacks: Stack[]
  legend?: Stack[]
  /** The legend's figures when they can be shorter than the readout's ("94M", not "94M tokens"). */
  legendFormat?: (n: number) => string
  byDay: number[]
  format: (n: number) => string
  /** What `format` rounds to (a cent), where a day's parts must add up to its total as shown. */
  unit?: number
  axis: (n: number) => string
  day: number | null
  onDay: (d: number | null) => void
  noun: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const pointer = useRef<string>("mouse")
  // A press on the plot that may become a drag along it, and whether it did (its click then picks nothing more).
  const press = useRef<{ x: number; from: number | null; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const readoutId = useId()
  const n = days.length
  const { top, ticks } = niceScale(Math.max(0, ...byDay))
  const shown = hover ?? day
  const week = n <= 7
  const labels = labelledDays(n)
  const total = byDay.reduce((a, b) => a + b, 0)

  const pickSegment = (i: number, s: Stack) => {
    const touch = pointer.current !== "mouse"
    if (touch && day !== i) return onDay(i)
    onDay(i)
    s.onPick?.()
  }
  const onKey = (e: KeyboardEvent) => {
    const at = day ?? n
    const next = e.key === "ArrowLeft" ? Math.max(0, at - 1) : e.key === "ArrowRight" ? Math.min(n - 1, day === null ? n - 1 : at + 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null
    if (next === null) return
    e.preventDefault()
    onDay(next)
  }
  /** The day under a pointer on the bars; null where they have no width (not laid out). */
  const dayAt = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return r.width > 0 ? Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))) : null
  }
  const onPress = (e: PointerEvent<HTMLElement>) => {
    pointer.current = e.pointerType
    dragged.current = false
    press.current = e.button === 0 ? { x: e.clientX, from: dayAt(e), moved: false } : null
  }
  // A drag along the plot picks the day under it. It starts 8px off the press and on another day, so a finger's wobble
  // during a tap stays a tap; a drag up or down scrolls the dialog (touch-pan-y) and ends this with a pointercancel.
  const onDrag = (e: PointerEvent<HTMLElement>) => {
    const p = press.current
    if (!p) return
    if (e.buttons === 0) return void (press.current = null)
    const d = dayAt(e)
    if (d === null) return
    if (!p.moved) {
      if (d === p.from || Math.abs(e.clientX - p.x) < 8) return
      p.moved = dragged.current = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
      setHover(null)
    }
    if (d !== day) onDay(d)
  }

  return (
    <div className="mt-3">
      <Readout id={readoutId} days={days} day={shown} picked={day} onDay={onDay} stacks={stacks} byDay={byDay} total={total} format={format} partFormat={legendFormat} unit={unit} />
      {/* Spoken for a picked day only: a mouse passing over the bars changes the line above without a word. */}
      <span className="sr-only" aria-live="polite" data-testid="usage-day-live">
        {day === null ? "" : `${longDayLabel(days[day]!)}: ${format(byDay[day]!)}`}
      </span>
      <div className="mt-2 flex gap-2">
        {/* y-axis labels */}
        <div aria-hidden className="relative h-40 w-10 shrink-0 text-right text-[11px] text-zinc-500 tabular-nums @lg/chart:h-52 @lg/chart:w-12">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: `${(1 - t / top) * 100}%` }}>
              {axis(t)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            ref={plot}
            role="group"
            tabIndex={0}
            aria-label={`Daily ${noun}: ←/→ pick a day`}
            aria-describedby={readoutId}
            onKeyDown={onKey}
            onPointerLeave={() => setHover(null)}
            className={cx("relative h-40 touch-pan-y touch-pinch-zoom rounded-sm select-none @lg/chart:h-52", FOCUS)}
          >
            {ticks.map((t) => (
              <div key={t} aria-hidden className={cx("absolute inset-x-0 border-t", t === 0 ? "border-zinc-600" : "border-zinc-800/80")} style={{ top: `${(1 - t / top) * 100}%` }} />
            ))}
            <div
              className={cx("absolute inset-0 flex items-end", n > 31 ? "gap-px" : "gap-0.5 @lg/chart:gap-1")}
              onPointerDown={onPress}
              onPointerMove={onDrag}
              onPointerUp={() => (press.current = null)}
              onPointerCancel={() => (press.current = null)}
              onClickCapture={(e) => {
                // The click that ends a drag: the drag has picked the day already.
                if (!dragged.current) return
                dragged.current = false
                e.stopPropagation()
              }}
            >
              {days.map((_, i) => (
                <div
                  key={i}
                  data-testid="usage-day"
                  // A picked day stands out by the others stepping back; the day under the mouse stays whole.
                  className={cx("relative flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse", i === shown && "bg-zinc-700/30", day !== null && i !== day && i !== hover && "opacity-40")}
                  onPointerEnter={(e: PointerEvent) => e.pointerType === "mouse" && !press.current?.moved && setHover(i)}
                  onClick={(e) => {
                    // The empty part above the bars picks the day.
                    if (e.target === e.currentTarget) onDay(i)
                  }}
                >
                  {stacks.map((s, k) => {
                    const v = s.daily[i] ?? 0
                    if (!(v > 0) || !(top > 0)) return null
                    const last = stacks.slice(k + 1).every((x) => !((x.daily[i] ?? 0) > 0))
                    return (
                      <div
                        key={s.key}
                        data-series={s.key}
                        onClick={() => pickSegment(i, s)}
                        className={cx("usage-fill w-full shrink-0 border-t border-zinc-950 first:border-t-0", last && "rounded-t-[2px]")}
                        style={{ height: `${(v / top) * 100}%`, "--series-color": s.color, minHeight: 1 } as CSSProperties}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
          {/* x-axis labels */}
          <div aria-hidden className="relative mt-1 h-4 text-[11px] text-zinc-500">
            {labels.map((i, k) => (
              <span
                key={i}
                // On a phone, every other date (counting back from today's), so "Oct 30" and "Nov 5" don't touch.
                className={cx("absolute top-0 whitespace-nowrap", !week && (labels.length - 1 - k) % 2 === 1 && "hidden @sm/chart:inline")}
                style={i === n - 1 && !week ? { right: 0 } : i === 0 && !week ? { left: 0 } : { left: `${((i + 0.5) / n) * 100}%`, transform: "translateX(-50%)" }}
              >
                {dayLabel(days[i]!, week)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <Legend stacks={legend} format={format} short={legendFormat} />
    </div>
  )
}

const STEP = cx(TAP_AREA, "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-zinc-400 pointer-coarse:w-11", FOCUS)

/**
 * The picked or hovered day's numbers, or the range's: text, so nothing is hover-only. Two rows that keep their height
 * whatever they show, so the bars below don't move under a pointer: the day (with ‹ › to step to its neighbours once
 * it's picked) and its total, then each series' part of it, or how to pick a day.
 */
function Readout({
  id,
  days,
  day,
  picked,
  onDay,
  stacks,
  byDay,
  total,
  format,
  partFormat = format,
  unit,
}: {
  id: string
  days: number[]
  /** The day whose numbers show: the hovered one, else the picked one. */
  day: number | null
  picked: number | null
  onDay: (d: number) => void
  stacks: Stack[]
  byDay: number[]
  total: number
  format: (n: number) => string
  /** Each series' figure, when the unit is already on the day's total ("54.7K" after "1.2M tokens"). */
  partFormat?: (n: number) => string
  unit?: number
}) {
  const n = days.length
  const value = day === null ? total : byDay[day]!
  const parts = day === null ? [] : stacks.map((s) => ({ s, v: s.daily[day] ?? 0 })).filter((p) => p.v > 0)
  // To the cent, the parts add up to the day's total beside them.
  const figures = unit ? roundedParts(parts.map((p) => p.v), value, unit) : parts.map((p) => p.v)
  const approx = (day === null ? stacks.filter((s) => s.total > 0) : parts.map((p) => p.s)).some((s) => s.estimated) ? "≈ " : ""
  // Room for the busiest day's parts, two, three or four to a row by the card's width; the hint is two lines on a phone.
  const most = Math.max(0, ...days.map((_, i) => stacks.reduce((c, s) => c + ((s.daily[i] ?? 0) > 0 ? 1 : 0), 0)))
  const rows = { "--rows-2": Math.max(2, Math.ceil(most / 2)), "--rows-3": Math.max(1, Math.ceil(most / 3)), "--rows-4": Math.max(1, Math.ceil(most / 4)) } as CSSProperties
  const label = <span className="font-medium text-zinc-200">{day === null ? `All ${n} days` : longDayLabel(days[day]!)}</span>
  // At an end the arrow stays focusable (aria-disabled, not disabled), so the keyboard doesn't lose its place.
  const step = (to: number) => to >= 0 && to < n && onDay(to)
  return (
    <div id={id} className="text-xs text-zinc-400 tabular-nums" data-testid="usage-readout">
      <div className="flex min-h-7 items-center gap-x-2 pointer-coarse:min-h-11">
        {picked === null ? (
          label
        ) : (
          <span role="group" aria-label="Day" className="inline-flex items-center gap-0.5">
            <button type="button" aria-label="Previous day" title="Previous day" aria-disabled={picked === 0} onClick={() => step(picked - 1)} className={STEP}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            {/* Room for "Wed, Sep 30", so › doesn't move under a finger stepping through days. */}
            <span className="min-w-19 text-center">{label}</span>
            <button type="button" aria-label="Next day" title="Next day" aria-disabled={picked === n - 1} onClick={() => step(picked + 1)} className={STEP}>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </span>
        )}
        <span className="text-sm font-semibold whitespace-nowrap text-zinc-50">{approx}{format(value)}</span>
      </div>
      <div
        style={rows}
        className="grid min-h-[calc(var(--rows-2)*1.125rem)] grid-cols-2 content-start gap-x-2 gap-y-0.5 @md/chart:min-h-[calc(var(--rows-3)*1.125rem)] @md/chart:grid-cols-3 @lg/chart:min-h-[calc(var(--rows-4)*1.125rem)] @lg/chart:grid-cols-4"
      >
        {day === null ? (
          // The tiles above have the daily average and the legend below each series' total: this line says how to go finer.
          <span className="col-span-full">
            <span className="pointer-coarse:hidden">Hover or drag for a day's numbers, click a colour to narrow it</span>
            <span className="hidden pointer-coarse:inline">Tap or drag for a day's numbers, then a colour to narrow it</span>
          </span>
        ) : (
          parts.map(({ s }, i) => (
            <span key={s.key} className="flex min-w-0 items-center gap-1" title={`${s.label}: ${partFormat(figures[i]!)}`}>
              <span aria-hidden className="usage-fill h-2 w-2 shrink-0 rounded-[2px]" style={{ "--series-color": s.color } as CSSProperties} />
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="shrink-0 text-zinc-300">{partFormat(figures[i]!)}</span>
            </span>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * Each series' colour, name and total, as buttons where a series narrows: two columns of name over figure while the
 * card is narrow (a phone), chips in a row from 24rem. `short` formats the figures on show, the title has `format`'s.
 */
function Legend({ stacks, format, short = format }: { stacks: Stack[]; format: (n: number) => string; short?: (n: number) => string }) {
  if (!stacks.length) return <p className="mt-3 text-sm text-zinc-500">Nothing in this range.</p>
  const item = "flex min-h-11 w-full max-w-full items-center gap-1.5 rounded-md border px-2 text-xs @sm/chart:inline-flex @sm/chart:w-auto"
  return (
    <ul className="mt-3 grid grid-cols-2 gap-1.5 @sm/chart:flex @sm/chart:flex-wrap" aria-label="Legend">
      {stacks.map((s) => {
        const figure = `${s.estimated ? "≈ " : ""}${format(s.total)}`
        const body = (
          <>
            <span aria-hidden className="usage-fill h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ "--series-color": s.color } as CSSProperties} />
            <span className="flex min-w-0 flex-col text-left @sm/chart:flex-row @sm/chart:items-center @sm/chart:gap-1.5">
              <span className="min-w-0 truncate text-zinc-200">{s.label}</span>
              <span className="text-zinc-500 tabular-nums">{s.estimated ? "≈ " : ""}{short(s.total)}</span>
            </span>
          </>
        )
        return (
          <li key={s.key} className="min-w-0">
            {s.onPick ? (
              <button
                type="button"
                aria-pressed={s.pressed}
                onClick={s.onPick}
                title={`${s.label}: ${figure}. ${s.pressed ? "Show all" : `Narrow to ${s.label}`}`}
                className={cx(item, FOCUS, s.pressed ? "border-yard-500/50 bg-yard-500/10" : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/60")}
              >
                {body}
              </button>
            ) : (
              <span className={cx(item, "border-transparent")} title={`${s.label}: ${figure}. Several models together: narrow by the table's Model rows`}>
                {body}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The table's columns, shared by its header, rows and Total so the figures line up. Narrow: the name, then total and
 * share. From 42rem: name, models, boxes, tokens, total, share.
 */
const COLS = "grid grid-cols-[minmax(0,1fr)_auto_3rem] gap-x-3 px-1 @2xl:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_4.5rem_6rem_3.5rem]"
const WIDE_CELL = "hidden text-right @2xl:block"

function Breakdown({
  view,
  group,
  said,
  onGroup,
  onDrill,
}: {
  view: UsageView
  group: UsageGroup
  /** The active filters' labels: a row's detail that repeats one is left out. */
  said: string[]
  onGroup: (g: UsageGroup) => void
  onDrill: (r: UsageTableRow) => void
}) {
  const [all, setAll] = useState(false)
  const id = useId()
  const rows = all ? view.rows : view.rows.slice(0, TABLE_ROWS)
  const t = view.totals
  return (
    <section aria-labelledby={id} data-testid="usage-breakdown" className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id} className="text-sm font-semibold text-zinc-100">Breakdown</h4>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          By
          <Select size="sm" value={group} onChange={(e) => { onGroup(e.target.value as UsageGroup); setAll(false) }} aria-label="Break down by" className="min-h-11 rounded-md sm:min-h-11">
            {GROUPS.map((g) => (
              <option key={g} value={g}>{USAGE_GROUP_LABEL[g]}</option>
            ))}
          </Select>
        </label>
      </div>
      <div className={cx(COLS, "mt-2 border-b border-zinc-800 pb-1 text-[11px] text-zinc-500 uppercase")}>
        <span className="min-w-0 truncate">{USAGE_GROUP_LABEL[group]}</span>
        <span className={WIDE_CELL}>Models</span>
        <span className={WIDE_CELL}>Boxes</span>
        <span className={WIDE_CELL}>Tokens</span>
        <span className="text-right">Total</span>
        <span className="text-right">Share</span>
      </div>
      <ul className="divide-y divide-zinc-800/60">
        {rows.map((r) => (
          <li key={r.key}>
            {r.filter ? (
              <button type="button" onClick={() => onDrill(r)} title={`Narrow to ${r.label}`} className={cx("block min-h-11 w-full rounded-md text-left hover:bg-zinc-800/40", FOCUS)} data-testid="usage-row">
                <RowBody r={r} total={t.costUsd} said={said} />
              </button>
            ) : (
              <div data-testid="usage-row"><RowBody r={r} total={t.costUsd} said={said} /></div>
            )}
          </li>
        ))}
        {view.rows.length > TABLE_ROWS && (
          <li className="py-1">
            <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className={cx("min-h-11 text-sm text-sky-400 hover:underline", FOCUS)}>
              {all ? `Show the top ${TABLE_ROWS} only` : `Show all ${view.rows.length}`}
            </button>
          </li>
        )}
        <li className={cx(COLS, "items-baseline py-2.5 text-sm")} data-testid="usage-total-row">
          <span className="font-medium text-zinc-300">Total</span>
          <span className={cx(WIDE_CELL, "text-zinc-300 tabular-nums")}>{money(t.llmUsd)}</span>
          <span className={cx(WIDE_CELL, "text-zinc-300 tabular-nums")}>{usd(t.computeUsd, t.computeUsd > 0)}</span>
          <span className={cx(WIDE_CELL, "text-zinc-300 tabular-nums")}>{compact(t.tokens.total)}</span>
          <span className="text-right font-semibold text-zinc-50 tabular-nums">{usd(t.costUsd, t.estimatedUsd > 0)}</span>
          <span className="text-right text-xs text-zinc-500 tabular-nums">{pct(t.costUsd, t.costUsd)}</span>
        </li>
      </ul>
      {view.rows.length === 0 && <p className="py-3 text-sm text-zinc-500">Nothing in this range.</p>}
    </section>
  )
}

/**
 * Narrow: the name gets the full width, its numbers go on the line below, with the total and its share in the header's
 * columns. From 42rem: one row of columns.
 */
function RowBody({ r, total, said }: { r: UsageTableRow; total: number; said: string[] }) {
  const est = r.estimated
  const boxes = r.computeUsd > 0 || r.computeHours > 0
  // The line under the name says what the total doesn't: its split when it has both parts, a box's hours, the tokens.
  const parts = [
    boxes && r.llmUsd > 0 ? `Models ${money(r.llmUsd)} · Boxes ${usd(r.computeUsd, est)}` : null,
    boxes && !(r.llmUsd > 0) ? `${r.computeHours.toFixed(1)} box-hours` : null,
    r.tokens > 0 ? `${compact(r.tokens)} tokens` : null,
  ]
  return (
    <span className={cx(COLS, "items-baseline py-2.5 @2xl:items-center")}>
      <span className="col-span-3 min-w-0 @2xl:col-span-1">
        <span className="line-clamp-2 text-sm text-zinc-100 wrap-anywhere" title={r.label}>{r.label}</span>
        {r.detail && !said.includes(r.detail) && <span className="line-clamp-1 text-xs text-zinc-500 wrap-anywhere">{r.detail}</span>}
      </span>
      <span className="mt-0.5 min-w-0 text-xs text-zinc-500 tabular-nums @2xl:hidden">{parts.filter(Boolean).join(" · ")}</span>
      <span className={cx(WIDE_CELL, "text-sm text-zinc-300 tabular-nums")}>{r.llmUsd > 0 ? money(r.llmUsd) : "—"}</span>
      <span className={cx(WIDE_CELL, "text-sm text-zinc-300 tabular-nums")}>{boxes ? usd(r.computeUsd, est) : "—"}</span>
      <span className={cx(WIDE_CELL, "text-sm text-zinc-300 tabular-nums")}>{r.tokens > 0 ? compact(r.tokens) : "—"}</span>
      <span className="mt-0.5 text-right text-sm font-medium text-zinc-100 tabular-nums @2xl:mt-0">{usd(r.costUsd, est)}</span>
      <span className="mt-0.5 text-right text-xs text-zinc-500 tabular-nums @2xl:mt-0">{pct(r.costUsd, total)}</span>
    </span>
  )
}

function HowEstimated({ ledger }: { ledger: UsageLedger }) {
  const r = ledger.rates
  const up = Object.entries(r.upstashCpuHourUsd).map(([size, usd]) => `${size} $${usd.toFixed(2)}`).join(", ")
  return (
    <details className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 text-sm text-zinc-400 @lg:px-4" data-testid="usage-estimates">
      <summary className={cx("min-h-11 cursor-pointer content-center font-medium text-zinc-200", FOCUS)}>How these numbers are made (≈ marks an estimate)</summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li><strong className="text-zinc-200">Models</strong>: each run's cost as the Claude CLI reported it, on the day the run started: what its tokens cost at API prices, not what your subscription bills you. A run it didn't price (Codex) is an estimate.</li>
        <li><strong className="text-zinc-200">Upstash boxes</strong>: the CPU each box used, at Settings › Usage's rate per active CPU hour ({up}), plus storage; Upstash's own figure where it reports one. ≈ unless it's Upstash's own.</li>
        <li><strong className="text-zinc-200">Daytona sandboxes</strong> ≈: each sandbox's size at Daytona's list price while it was up: ${r.daytona.vcpuHour}/vCPU-hour + ${r.daytona.memoryGibHour}/GiB-hour of memory, plus its GPU's hourly price.</li>
        <li><strong className="text-zinc-200">RunPod and Vast.ai GPUs</strong> ≈: the pod's $/hr when it started (from the box history), from then until it was terminated.</li>
        <li><strong className="text-zinc-200">Docker, this computer and SSH machines</strong> are your own hardware: $0, with their hours listed.</li>
        <li>Box costs are tracked apart from model costs, and only they count toward the box spending limits below.</li>
        <li>A box's cost goes to the tasks whose turns ran on it, split evenly while several ran at once (≈). Time no turn ran is <em>Idle box time</em>.</li>
        {ledger.repriced.runs > 0 && (
          <li data-testid="usage-repriced">
            {ledger.repriced.runs} {ledger.repriced.runs === 1 ? "run was" : "runs were"} booked {money(ledger.repriced.bookedUsd)} from a dip in the CLI's running session total that never was spent; {ledger.repriced.runs === 1 ? "it is" : "they are"} counted at {money(ledger.repriced.chargedUsd)} ≈, their tokens at their session's own rate.
          </li>
        )}
      </ul>
    </details>
  )
}

/** Box spend against Settings › Usage's cloud limits (Claude isn't counted against them). */
function CloudLimits() {
  const q = useUsageBudget()
  const budget = q.data
  const toSettings = useUsageToSettings()
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:px-4" aria-label="Boxes against your cloud limits">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-zinc-100">Box spending limits</h3>
        <Button type="button" size="sm" onClick={() => toSettings("costs")} title="Settings › Usage: the daily and monthly limits and the box rates" data-testid="usage-open-limits">
          <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
          Limits and rates
        </Button>
      </div>
      <p className="mt-1 mb-2 text-xs text-zinc-500">Current box spending only. Model costs and subscription allowances do not count toward these limits.</p>
      {budget ? (
        <ul className="divide-y divide-zinc-800/60">
          <LimitRow label="Daily cloud limit" phrase="today" state={budget.daily} />
          <LimitRow label="Monthly cloud limit" phrase="in the last 30 days" state={budget.monthly} />
        </ul>
      ) : q.isError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-400">
          Box spending limits are unavailable.
          <Button type="button" className="min-h-11 sm:min-h-11" onClick={() => void q.refetch()}>Retry box limits</Button>
        </div>
      ) : <Loading kind="rows" label="Loading box spending limits" />}
    </section>
  )
}

function LimitRow({ label, phrase, state }: { label: string; phrase: string; state: BudgetStatus["daily"] }) {
  const on = state.limitUsd > 0
  const status = !on ? "no limit set" : state.exceeded ? "reached: new boxes wait, running work goes on" : `${pct(state.usedUsd, state.limitUsd)} used · ${money(Math.max(0, state.limitUsd - state.usedUsd))} left`
  const ratio = on ? Math.min(1, state.usedUsd / state.limitUsd) : 0
  const title = `Box spend ${phrase}: ${money(state.usedUsd)} of the ${money(state.limitUsd)} ${label.toLowerCase()} (${pct(state.usedUsd, state.limitUsd)})`
  return (
    <li className="py-2.5" data-testid="usage-limit">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm text-zinc-100">{label}</span>
          <span className={cx("block text-xs", state.exceeded ? "text-red-300" : state.warning ? "text-amber-300" : "text-zinc-500")}>Box spend {phrase} · {status}</span>
        </span>
        <span className="shrink-0 text-right text-sm font-medium text-zinc-100 tabular-nums">
          {money(state.usedUsd)}
          {on && <span className="block text-xs font-normal text-zinc-500">of {money(state.limitUsd)}</span>}
        </span>
      </div>
      {on && (
        <span role="meter" aria-label={title} aria-valuemin={0} aria-valuemax={state.limitUsd} aria-valuenow={Math.min(state.usedUsd, state.limitUsd)} aria-valuetext={title} title={title} className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <span className={cx("block h-full rounded-full", state.exceeded ? "bg-red-500" : state.warning ? "bg-amber-400" : "bg-sky-500")} style={{ width: `${ratio * 100}%` }} />
        </span>
      )}
    </li>
  )
}
