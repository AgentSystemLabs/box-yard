// Usage: what Box Yard cost over the last 7, 30, 60 or 90 days, from the sidebar's Usage button (UsageHost.tsx). Daily
// cost stacks LLM spend by model on compute by provider; daily tokens stack input, cache writes, cache reads and output.
// Tapping a bar segment, a legend item, a day's line or a table row narrows everything to it, and the table goes one
// level finer each time, down to tasks and boxes. One request per range: filters fold the ledger in the browser
// (shared/usageLedger.ts), and every number on screen adds up to the totals above it. Estimates wear "≈".
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { Modal } from "./Modal"
import { Loading } from "./Loading"
import { SubscriptionLimits } from "./LoginLimits"
import { Button, Select, cx, useMinuteClock } from "./ui"
import { prefetchUsageLedger, useUsageBudget, useUsageLedger } from "../lib/queries"
import { money, pct } from "../lib/usage"
import { axisMoney, compact, dayLabel, labelledDays, localDayStarts, longDayLabel, niceScale } from "../lib/usageChart"
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
              <p className="mt-1 text-xs text-zinc-500">{ledger ? `${dayLabel(ledger.days[0]!)} – ${dayLabel(ledger.to - 1)} · ` : ""}US dollars · ≈ means estimated</p>
            </div>
            <RangePicker value={range} onChange={(d) => { onDays(d); setDay(null) }} onPrefetch={prefetch} />
          </div>
          <p className="text-sm text-zinc-400">Model costs are reported or estimated API-equivalent values, not your subscription bill. Box costs are tracked separately.</p>
          {ledger && <FilterChips ledger={ledger} filter={filter} onDrop={drop} onClear={() => setFilter({})} />}
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
            <div aria-busy={q.isPlaceholderData} className="space-y-4">
              {view.totals.turns === 0 && view.totals.computeHours === 0 && view.totals.costUsd === 0 && view.totals.tokens.total === 0 && (
                <p className="text-sm text-zinc-400" data-testid="usage-empty">No recorded usage in this range{Object.keys(filter).length ? " for these filters" : ""}.</p>
              )}
              <Totals view={view} />
              <div className="grid items-start gap-4 @4xl:grid-cols-2">
                <CostChart view={view} day={shownDay} onDay={setDay} onNarrow={narrow} />
                <TokenChart view={view} day={shownDay} onDay={setDay} />
              </div>
              <Breakdown view={view} group={group} onGroup={setGroup} onDrill={(row) => row.filter && narrow(row.filter, group)} />
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

function FilterChips({ ledger, filter, onDrop, onClear }: { ledger: UsageLedger; filter: UsageFilter; onDrop: (k: keyof UsageFilter) => void; onClear: () => void }) {
  const set = (Object.keys(filter) as (keyof UsageFilter)[]).filter((k) => filter[k] !== undefined)
  if (!set.length) return <p className="text-xs text-zinc-500">Tap a bar, a legend item or a row to narrow it down.</p>
  return (
    <div role="group" aria-label="Filters" className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="usage-filters">
      {set.map((k) => {
        const label = filterLabel(ledger, k, filter[k]!)
        return (
          <button
            key={k}
            type="button"
            onClick={() => onDrop(k)}
            aria-label={`Remove filter ${FILTER_NAMES[k]}: ${label}`}
            title="Remove this filter"
            className={cx("inline-flex min-h-11 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-yard-500/40 bg-yard-500/10 pr-2 pl-3 text-xs text-yard-100 hover:bg-yard-500/20", FOCUS)}
          >
            <span className="text-yard-300/80">{FILTER_NAMES[k]}</span>
            <span className="min-w-0 truncate font-medium">{label}</span>
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </button>
        )
      })}
      {set.length > 1 && (
        <button type="button" onClick={onClear} className={cx("min-h-11 rounded-md px-2 text-xs text-zinc-400 hover:text-zinc-100", FOCUS)}>
          Clear all
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
  const llmEstimated = view.cost.some((s) => s.kind === "llm" && s.estimated)
  const computeEstimated = view.cost.some((s) => s.kind === "compute" && s.estimated)
  return (
    <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
      <Tile testId="usage-total" label="Tracked cost" value={usd(t.costUsd, t.estimatedUsd > 0)} sub={`${usd(t.costUsd / n, t.estimatedUsd > 0)} a day on average`} />
      <Tile label="Model cost" value={usd(t.llmUsd, llmEstimated)} sub={`${t.turns.toLocaleString("en-US")} runs · ${pct(t.llmUsd, t.costUsd)}`} />
      <Tile label="Box cost" value={usd(t.computeUsd, computeEstimated)} sub={`${t.computeHours.toFixed(1)} box-hours · ${pct(t.computeUsd, t.costUsd)}`} />
      <Tile testId="usage-tokens" label="Tokens" value={compact(t.tokens.total)} sub={`${compact(t.tokens.total / n)} a day on average`} />
    </div>
  )
}

/** One stack of a chart: its colour, its daily values, and what tapping it does. */
type Stack = { key: string; label: string; color: string; daily: number[]; total: number; estimated?: boolean; pressed?: boolean; onPick?: () => void }

const colorOf = (i: number) => (i < 0 ? OTHER_COLOR : USAGE_COLORS[i]!)

function CostChart({ view, day, onDay, onNarrow }: { view: UsageView; day: number | null; onDay: (d: number | null) => void; onNarrow: (f: UsageFilter) => void }) {
  const stacks: Stack[] = view.cost.map((s) => ({ key: s.key, label: s.label, color: colorOf(s.color), daily: s.daily, total: s.totalUsd, estimated: s.estimated, onPick: s.filter ? () => onNarrow(s.filter!) : undefined }))
  return (
    <ChartCard title="Daily cost" sub="Models and boxes · US dollars" testId="usage-cost-chart">
      <StackedBars days={view.days} stacks={stacks} byDay={view.costByDay} format={(n) => money(n)} axis={axisMoney} day={day} onDay={onDay} noun="cost" />
    </ChartCard>
  )
}

function TokenChart({ view, day, onDay }: { view: UsageView; day: number | null; onDay: (d: number | null) => void }) {
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
    <ChartCard title="Daily tokens" sub={only ? `${legend.find((s) => s.pressed)!.label} only: tap it again for all four` : "Input, cache writes, cache reads and output"} testId="usage-token-chart">
      <StackedBars days={view.days} stacks={stacks} legend={legend} byDay={byDay} format={(n) => `${compact(n)} tokens`} axis={compact} day={day} onDay={onDay} noun="tokens" />
    </ChartCard>
  )
}

function ChartCard({ title, sub, testId, children }: { title: string; sub: string; testId: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} data-testid={testId} className="@container/chart min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:p-4">
      <h4 id={id} className="text-sm font-semibold text-zinc-100">{title}</h4>
      <p className="text-xs text-zinc-500">{sub}</p>
      {children}
    </section>
  )
}

/**
 * Stacked daily bars with a y-axis, a legend and a readout line. The readout shows the hovered day (mouse), else the
 * picked one (tap, click, or ←/→ on the focused chart), else the whole range; its lines and the legend narrow to a
 * series, like a tap on a segment does. On a touch screen the first tap on a day picks it and a second tap on a
 * segment narrows, so a 3px bar of a 90-day chart never filters by accident.
 */
function StackedBars({
  days,
  stacks,
  legend = stacks,
  byDay,
  format,
  axis,
  day,
  onDay,
  noun,
}: {
  days: number[]
  stacks: Stack[]
  legend?: Stack[]
  byDay: number[]
  format: (n: number) => string
  axis: (n: number) => string
  day: number | null
  onDay: (d: number | null) => void
  noun: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const pointer = useRef<string>("mouse")
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

  return (
    <div className="mt-3">
      <Readout id={readoutId} days={days} day={shown} stacks={stacks} byDay={byDay} total={total} format={format} noun={noun} />
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
            role="group"
            tabIndex={0}
            aria-label={`Daily ${noun}: ←/→ pick a day`}
            aria-describedby={readoutId}
            onKeyDown={onKey}
            onPointerLeave={() => setHover(null)}
            className={cx("relative h-40 rounded-sm @lg/chart:h-52", FOCUS)}
          >
            {ticks.map((t) => (
              <div key={t} aria-hidden className={cx("absolute inset-x-0 border-t", t === 0 ? "border-zinc-600" : "border-zinc-800/80")} style={{ top: `${(1 - t / top) * 100}%` }} />
            ))}
            <div className={cx("absolute inset-0 flex items-end", n > 31 ? "gap-px" : "gap-0.5 @lg/chart:gap-1")}>
              {days.map((_, i) => (
                <div
                  key={i}
                  data-testid="usage-day"
                  className={cx("relative flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse", i === shown && "bg-zinc-700/30")}
                  onPointerDown={(e: PointerEvent) => (pointer.current = e.pointerType)}
                  onPointerEnter={(e: PointerEvent) => e.pointerType === "mouse" && setHover(i)}
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
                        className={cx("w-full shrink-0 border-t border-zinc-950 first:border-t-0", last && "rounded-t-[2px]")}
                        style={{ height: `${(v / top) * 100}%`, background: s.color, minHeight: 1 }}
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
      <Legend stacks={legend} format={format} />
    </div>
  )
}

/** The picked or hovered day's numbers, or the range's: text, so nothing is hover-only. */
function Readout({ id, days, day, stacks, byDay, total, format, noun }: { id: string; days: number[]; day: number | null; stacks: Stack[]; byDay: number[]; total: number; format: (n: number) => string; noun: string }) {
  const value = day === null ? total : byDay[day]!
  const parts = stacks.map((s) => ({ s, v: day === null ? s.total : (s.daily[day] ?? 0) })).filter((p) => p.v > 0)
  const approx = noun === "cost" && parts.some((p) => p.s.estimated) ? "≈ " : ""
  return (
    <div id={id} aria-live="polite" className="flex min-h-11 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-zinc-400 tabular-nums" data-testid="usage-readout">
      <span className="font-medium text-zinc-200">{day === null ? `All ${days.length} days` : longDayLabel(days[day]!)}</span>
      <span className="text-sm font-semibold text-zinc-50">{approx}{format(value)}</span>
      {day === null ? (
        // The legend below has each series' total: until a day is picked, say what a day averages and how to pick one.
        <span>
          {approx}{format(total / days.length)} a day on average · <span className="pointer-coarse:hidden">hover or </span>tap a day for its numbers
        </span>
      ) : (
        parts.map(({ s, v }) => (
          <span key={s.key} className="inline-flex min-w-0 items-center gap-1">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
            <span className="min-w-0 truncate">{s.label}</span> {format(v)}
          </span>
        ))
      )}
    </div>
  )
}

function Legend({ stacks, format }: { stacks: Stack[]; format: (n: number) => string }) {
  if (!stacks.length) return <p className="mt-3 text-sm text-zinc-500">Nothing in this range.</p>
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Legend">
      {stacks.map((s) => {
        const body = (
          <>
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="min-w-0 truncate text-zinc-200">{s.label}</span>
            <span className="text-zinc-500 tabular-nums">{s.estimated ? "≈ " : ""}{format(s.total)}</span>
          </>
        )
        return (
          <li key={s.key} className="min-w-0">
            {s.onPick ? (
              <button
                type="button"
                aria-pressed={s.pressed}
                onClick={s.onPick}
                title={s.pressed ? "Show all" : `Narrow to ${s.label}`}
                className={cx(
                  "inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs",
                  FOCUS,
                  s.pressed ? "border-yard-500/50 bg-yard-500/10" : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/60",
                )}
              >
                {body}
              </button>
            ) : (
              <span className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md border border-transparent px-2 text-xs" title="Several models together: narrow by the table's Model rows">
                {body}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Breakdown({ view, group, onGroup, onDrill }: { view: UsageView; group: UsageGroup; onGroup: (g: UsageGroup) => void; onDrill: (r: UsageTableRow) => void }) {
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
      <div className="mt-2 hidden grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_8.5rem] gap-x-3 border-b border-zinc-800 pb-1 text-[11px] text-zinc-500 uppercase @2xl:grid">
        <span>{USAGE_GROUP_LABEL[group]}</span>
        <span className="text-right">Models</span>
        <span className="text-right">Boxes</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Total</span>
      </div>
      <ul className="divide-y divide-zinc-800/60">
        {rows.map((r) => (
          <li key={r.key}>
            {r.filter ? (
              <button type="button" onClick={() => onDrill(r)} title={`Narrow to ${r.label}`} className={cx("block min-h-11 w-full rounded-md text-left hover:bg-zinc-800/40", FOCUS)} data-testid="usage-row">
                <RowBody r={r} total={t.costUsd} />
              </button>
            ) : (
              <div data-testid="usage-row"><RowBody r={r} total={t.costUsd} /></div>
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
        <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2.5 text-sm @2xl:grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_8.5rem]" data-testid="usage-total-row">
          <span className="font-medium text-zinc-300">Total</span>
          <span className="hidden text-right text-zinc-300 tabular-nums @2xl:block">{money(t.llmUsd)}</span>
          <span className="hidden text-right text-zinc-300 tabular-nums @2xl:block">{usd(t.computeUsd, t.computeUsd > 0)}</span>
          <span className="hidden text-right text-zinc-300 tabular-nums @2xl:block">{compact(t.tokens.total)}</span>
          <span className="text-right font-semibold text-zinc-50 tabular-nums">{usd(t.costUsd, t.estimatedUsd > 0)}</span>
        </li>
      </ul>
      {view.rows.length === 0 && <p className="py-3 text-sm text-zinc-500">Nothing in this range.</p>}
    </section>
  )
}

/** Narrow: the name gets the full width, its numbers go on the line below. From 42rem: one row of columns. */
function RowBody({ r, total }: { r: UsageTableRow; total: number }) {
  const est = r.estimated
  return (
    <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-1 py-2.5 @2xl:grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_8.5rem] @2xl:items-center">
      <span className="col-span-2 min-w-0 @2xl:col-span-1">
        <span className="line-clamp-2 text-sm text-zinc-100 wrap-anywhere" title={r.label}>{r.label}</span>
        {r.detail && <span className="line-clamp-1 text-xs text-zinc-500 wrap-anywhere">{r.detail}</span>}
      </span>
      <span className="mt-0.5 text-xs text-zinc-500 tabular-nums @2xl:hidden">
        {[r.llmUsd > 0 ? `Models ${money(r.llmUsd)}` : null, r.computeUsd > 0 || r.computeHours > 0 ? `Boxes ${usd(r.computeUsd, est)}` : null, r.tokens > 0 ? `${compact(r.tokens)} tokens` : null].filter(Boolean).join(" · ")}
      </span>
      <span className="mt-0.5 text-right text-sm font-medium text-zinc-100 tabular-nums @2xl:hidden">
        {usd(r.costUsd, est)} <span className="text-xs font-normal text-zinc-500">{pct(r.costUsd, total)}</span>
      </span>
      <span className="hidden text-right text-sm text-zinc-300 tabular-nums @2xl:block">{r.llmUsd > 0 ? money(r.llmUsd) : "—"}</span>
      <span className="hidden text-right text-sm text-zinc-300 tabular-nums @2xl:block">{r.computeUsd > 0 || r.computeHours > 0 ? usd(r.computeUsd, est) : "—"}</span>
      <span className="hidden text-right text-sm text-zinc-300 tabular-nums @2xl:block">{r.tokens > 0 ? compact(r.tokens) : "—"}</span>
      <span className="hidden text-right text-sm font-medium text-zinc-100 tabular-nums @2xl:block">
        {usd(r.costUsd, est)} <span className="text-xs font-normal text-zinc-500">{pct(r.costUsd, total)}</span>
      </span>
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
        <li><strong className="text-zinc-200">Models</strong>: each run's cost as the Claude CLI reported it, on the day the run started. A run it didn't price (Codex) is an estimate.</li>
        <li><strong className="text-zinc-200">Upstash boxes</strong>: the CPU each box used, at Settings › Usage's rate per active CPU hour ({up}), plus storage; Upstash's own figure where it reports one. ≈ unless it's Upstash's own.</li>
        <li><strong className="text-zinc-200">Daytona sandboxes</strong> ≈: each sandbox's size at Daytona's list price while it was up: ${r.daytona.vcpuHour}/vCPU-hour + ${r.daytona.memoryGibHour}/GiB-hour of memory, plus its GPU's hourly price.</li>
        <li><strong className="text-zinc-200">RunPod and Vast.ai GPUs</strong> ≈: the pod's $/hr when it started (from the box history), from then until it was terminated.</li>
        <li><strong className="text-zinc-200">Docker, this computer and SSH machines</strong> are your own hardware: $0, with their hours listed.</li>
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
  return (
    <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:px-4" aria-label="Boxes against your cloud limits">
      <h3 className="text-base font-semibold text-zinc-100">Box spending limits</h3>
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
