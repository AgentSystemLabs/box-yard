// The $ in a task's (or subtask's) header and a Captain's: what it has spent on its agent's model calls, opened in a
// sheet. Its own total and tokens, then by model and harness, then run by run, newest first; a task's subtasks apart from
// its own spend, and the two together. From GET /api/tasks/:id/usage or /api/projects/:id/captain/usage
// (shared/spendBreakdown.ts), fetched when it opens, never with the page. Every figure is text: no bars, no hover-only
// detail (tooltips only repeat exact token counts).
import { useState, type ReactNode } from "react"
import { CircleDollarSign } from "lucide-react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"
import { money, pct } from "../lib/usage"
import { taskSessionHref } from "../lib/navigation"
import { Modal } from "./Modal"
import { Loading } from "./Loading"
import { formatTokens } from "./ContextMeter"
import { AppLink, cx, TAP_AREA } from "./ui"
import { AGENT_CLI_LABEL, type AgentCli } from "../../../shared/agentCli"
import { formatMs } from "../../../shared/turnTimings"
import { modelLabel } from "../../../shared/usageLedger"
import { addSpend, emptySpend, spendTokens, type SpendBreakdown, type SpendModel, type SpendRun, type SpendTotals } from "../../../shared/spendBreakdown"

export type SpendScope =
  /** `version` changes when the task's spend does (its claudeCostUsd), so an open breakdown follows a running turn. */
  | { kind: "task"; id: string; title: string; version?: string }
  | { kind: "captain"; projectId: string; name: string; version?: string }

/** Drawn like the task header's ⓘ: 32px with a mouse, 44px to a finger. */
const SPEND_BUTTON =
  "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none aria-expanded:text-zinc-100 pointer-coarse:h-11 pointer-coarse:w-11"

export function SpendButton({ scope, className }: { scope: SpendScope; className?: string }) {
  const [open, setOpen] = useState(false)
  const name = scope.kind === "task" ? "this task's" : "the Captain's"
  return (
    <>
      <button
        type="button"
        data-testid="spend-button"
        aria-label="Cost breakdown"
        title={`Cost breakdown: ${name} tokens and spend by model`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(SPEND_BUTTON, className)}
      >
        <CircleDollarSign className="h-[18px] w-[18px]" aria-hidden />
      </button>
      {open && <SpendSheet scope={scope} onClose={() => setOpen(false)} />}
    </>
  )
}

export const spendUrl = (scope: SpendScope) =>
  scope.kind === "task" ? `/api/tasks/${encodeURIComponent(scope.id)}/usage` : `/api/projects/${encodeURIComponent(scope.projectId)}/captain/usage`

function SpendSheet({ scope, onClose }: { scope: SpendScope; onClose: () => void }) {
  const url = spendUrl(scope)
  const q = useQuery({ queryKey: ["spend", url, scope.version ?? null], queryFn: () => api<SpendBreakdown>(url), placeholderData: keepPreviousData })
  return (
    <Modal
      title="Cost breakdown"
      description={<span className="line-clamp-2 wrap-anywhere">{scope.kind === "task" ? scope.title : `${scope.name} Captain`}</span>}
      size="lg"
      placement="sheet"
      onClose={onClose}
      bodyClassName="@container/spend scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-5 sm:px-5"
    >
      {q.data ? (
        <SpendDetail data={q.data} onLeave={onClose} />
      ) : q.isError ? (
        <p className="py-2 text-sm text-zinc-500">Couldn't load the cost breakdown.</p>
      ) : (
        <Loading kind="rows" label="Loading the cost breakdown" />
      )}
    </Modal>
  )
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const exact = (n: number) => n.toLocaleString()
const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const allUnknown = (t: SpendTotals) => t.runs > 0 && t.unpricedRuns === t.runs

/** `onLeave`: a subtask's link was followed, so the sheet steps aside. */
export function SpendDetail({ data, onLeave }: { data: SpendBreakdown; onLeave?: () => void }) {
  const sub = data.subtasks
  const unknownOn = [...new Set([...data.byModel, ...(sub?.byModel ?? [])].filter((m) => m.unpricedRuns > 0).map((m) => AGENT_CLI_LABEL[m.harness]))]
  return (
    <div data-testid="spend-detail" className="flex flex-col gap-5 text-xs text-zinc-400">
      <section aria-label="Totals" className="flex flex-col gap-3">
        {sub ? (
          // Narrow, the two parts side by side and Together under them.
          <div className="grid grid-cols-2 gap-2 @min-[30rem]/spend:grid-cols-3">
            <Stat label="This task" totals={data.total} />
            <Stat label={`Subtasks (${sub.tasks.length})`} totals={sub.total} />
            <Stat label="Together" totals={addSpend(addSpend(emptySpend(), data.total), sub.total)} strong className="col-span-2 @min-[30rem]/spend:col-span-1" />
          </div>
        ) : (
          <Stat label={data.scope === "task" ? "This task" : "This Captain"} totals={data.total} strong />
        )}
        <TokenCells totals={data.total} label={sub ? "This task's tokens" : "Tokens"} />
        <Notes data={data} />
      </section>

      <Section title="By model" aside={data.total.runs ? plural(data.byModel.length, "model") : null}>
        {data.byModel.length ? <ModelList rows={data.byModel} total={data.total.costUsd} /> : <Empty scope={data.scope} />}
      </Section>

      {sub && (
        <Section title={`Subtasks (${sub.tasks.length})`} aside={<CostText totals={sub.total} />}>
          <ul className="divide-y divide-zinc-800/70">
            {sub.tasks.map((t) => (
              <li key={t.taskId} className="flex flex-col gap-0.5 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {/* The sheet steps aside as the subtask opens. */}
                  <span className="min-w-0 basis-full @min-[26rem]/spend:flex-1 @min-[26rem]/spend:basis-0" onClickCapture={onLeave}>
                    <AppLink href={taskSessionHref(t.taskId)} className={cx(TAP_AREA, "inline-block max-w-full font-medium wrap-anywhere text-yard-300 hover:text-yard-200 hover:underline")}>
                      {t.title}
                    </AppLink>
                  </span>
                  <span className="text-zinc-500">{t.runs ? plural(t.runs, "run") : "no runs yet"}</span>
                  <span className="ml-auto text-right tabular-nums">{t.runs ? <CostText totals={t} /> : <span className="text-zinc-500">$0.00</span>}</span>
                </div>
                {t.runs > 0 && <TokenLine totals={t} />}
              </li>
            ))}
          </ul>
          {sub.byModel.length > 0 && (
            <>
              <h4 className="mt-3 mb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Subtasks by model</h4>
              <ModelList rows={sub.byModel} total={sub.total.costUsd} />
            </>
          )}
        </Section>
      )}

      {data.runs.length > 0 && (
        <Section title="Runs" aside={data.total.runs > data.runs.length ? `newest ${data.runs.length} of ${data.total.runs.toLocaleString()}` : "newest first"}>
          <ul className="divide-y divide-zinc-800/70">
            {data.runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </ul>
        </Section>
      )}

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Each run is priced by the agent CLI that ran it, for the model that run used (later model changes don't reprice it).
        {unknownOn.length > 0 && ` ${unknownOn.join(" and ")} reported tokens without a cost, so those runs show "cost unknown" and add $0 to the totals.`}
      </p>
    </div>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 border-b border-zinc-800 pb-1">
        <h3 className="text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">{title}</h3>
        {aside && <span className="ml-auto text-zinc-500 tabular-nums">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** A total, with how many of its runs have no cost (the dollars leave them out). */
function Stat({ label, totals, strong = false, className }: { label: string; totals: SpendTotals; strong?: boolean; className?: string }) {
  const unknown = allUnknown(totals)
  return (
    <div className={cx("flex min-w-0 flex-col rounded-lg border px-3 py-2", strong ? "border-zinc-700 bg-zinc-900/70" : "border-zinc-800 bg-zinc-900/30", className)}>
      <span className="text-zinc-500">{label}</span>
      <span data-testid="spend-total" className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
        <span className={strong ? "text-xl font-semibold text-zinc-50" : "text-base font-medium text-zinc-200"}>{unknown ? "Unknown" : money(totals.costUsd)}</span>
        {!unknown && totals.unpricedRuns > 0 && <span className="text-amber-300/90">+{plural(totals.unpricedRuns, "unknown", "unknown")}</span>}
      </span>
      {/* Wraps between its two figures, never inside one. */}
      <span className="flex flex-wrap gap-x-1 text-zinc-500 tabular-nums">
        <span className="whitespace-nowrap">{plural(totals.runs, "run")} ·</span>
        <span className="whitespace-nowrap">{formatTokens(spendTokens(totals))} tokens</span>
      </span>
    </div>
  )
}

const TOKEN_KINDS = [
  { key: "inputTokens", label: "Input", short: "in", hint: "Prompt tokens the model read fresh" },
  { key: "outputTokens", label: "Output", short: "out", hint: "Tokens the model wrote" },
  { key: "cacheReadTokens", label: "Cache read", short: "cache read", hint: "Prompt tokens read from the prompt cache" },
  { key: "cacheWriteTokens", label: "Cache write", short: "cache write", hint: "Prompt tokens written to the prompt cache" },
] as const

function TokenCells({ totals, label }: { totals: SpendTotals; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-1.5 @min-[30rem]/spend:grid-cols-4">
      {TOKEN_KINDS.map((k) => (
        <div key={k.key} className="flex min-w-0 flex-col" title={`${k.hint}: ${exact(totals[k.key])}`}>
          <dt className="text-zinc-500">{k.label}</dt>
          <dd className="text-sm text-zinc-200 tabular-nums">{formatTokens(totals[k.key])}</dd>
        </div>
      ))}
    </dl>
  )
}

/** "in 12k · out 3k · cache read 200k · cache write 10k", wrapping between figures. */
function TokenLine({ totals }: { totals: Pick<SpendTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> }) {
  return (
    <div className="flex flex-wrap gap-x-3 text-zinc-500 tabular-nums">
      {TOKEN_KINDS.map((k) => (
        <span key={k.key} title={`${k.hint}: ${exact(totals[k.key])}`} className="whitespace-nowrap">
          {k.short} {formatTokens(totals[k.key])}
        </span>
      ))}
    </div>
  )
}

/** A cost as it's known: the reported dollars, the estimated part, and runs whose cost is unknown. */
function CostText({ totals }: { totals: SpendTotals }) {
  if (allUnknown(totals)) return <span className="text-amber-300/90">cost unknown</span>
  return (
    <span className="tabular-nums">
      <span className="text-zinc-100">{money(totals.costUsd)}</span>
      {totals.estimatedUsd > 0 && <span className="text-zinc-500"> (≈{money(totals.estimatedUsd)} est.)</span>}
      {totals.unpricedRuns > 0 && <span className="text-amber-300/90"> +{plural(totals.unpricedRuns, "unknown", "unknown")}</span>}
    </span>
  )
}

function Notes({ data }: { data: SpendBreakdown }) {
  const t = data.total
  const notes: string[] = []
  if (t.estimatedUsd > 0) notes.push(`≈${money(t.estimatedUsd)} of it is estimated from tokens: a resumed session's first run, or a run whose CLI total dipped.`)
  if (data.repriced.runs > 0)
    notes.push(`${plural(data.repriced.runs, "run")} booked ${money(data.repriced.bookedUsd)} from a dip in the CLI's running total; charged ${money(data.repriced.chargedUsd)} at its session's rate instead, as on the Usage page.`)
  if (t.unpricedRuns > 0) notes.push(`${plural(t.unpricedRuns, "run")} reported tokens but no cost, so the total leaves ${t.unpricedRuns === 1 ? "it" : "them"} out.`)
  if (!notes.length) return null
  return (
    <ul data-testid="spend-notes" className="flex flex-col gap-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-amber-100/80">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

function ModelList({ rows, total }: { rows: SpendModel[]; total: number }) {
  return (
    <ul className="divide-y divide-zinc-800/70">
      {rows.map((m) => (
        <li key={`${m.harness}:${m.model}`} data-testid="spend-model" className="flex flex-col gap-0.5 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {/* Narrow, the model's name gets the whole line and the rest goes under it. */}
            {/* Named as on the Usage page, with the id the CLI reported when that's not the name. */}
            <span className="min-w-0 basis-full wrap-anywhere @min-[26rem]/spend:flex-1 @min-[26rem]/spend:basis-0">
              <span className="font-medium text-zinc-200">{modelLabel(m.model)}</span>
              {modelLabel(m.model) !== m.model && <span className="ml-1.5 text-zinc-500">{m.model}</span>}
            </span>
            <span className="text-zinc-500">
              {harnessLabel(m.harness)} · {plural(m.runs, "run")}
            </span>
            <span className="ml-auto text-right">
              <CostText totals={m} />
              {!allUnknown(m) && total > 0 && <span className="text-zinc-500 tabular-nums"> · {pct(m.costUsd, total)}</span>}
            </span>
          </div>
          <TokenLine totals={m} />
        </li>
      ))}
    </ul>
  )
}

const KIND_LABEL: Record<string, string> = { compact: "Compaction", context: "Context check", thread: "Side thread" }
const runLabel = (r: SpendRun) => KIND_LABEL[r.kind] ?? (r.turn !== null ? `Turn ${r.turn}` : "Turn")
const harnessLabel = (h: AgentCli) => AGENT_CLI_LABEL[h] ?? h

function RunRow({ run }: { run: SpendRun }) {
  return (
    <li data-testid="spend-run" className="flex flex-col gap-0.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-zinc-200">{runLabel(run)}</span>
        <time dateTime={new Date(run.startedAt).toISOString()} className="text-zinc-500">
          {when(run.startedAt)}
        </time>
        <span className="ml-auto text-right tabular-nums">
          {run.cost === "unknown" ? (
            <span className="text-amber-300/90">cost unknown</span>
          ) : run.cost === "estimated" ? (
            <span className="text-zinc-200">
              ≈{money(run.costUsd)} <span className="text-zinc-500">est.</span>
            </span>
          ) : (
            <span className="text-zinc-100">{money(run.costUsd)}</span>
          )}
        </span>
      </div>
      <div className="min-w-0 wrap-anywhere text-zinc-500">
        {modelLabel(run.model)} · {harnessLabel(run.harness)}
        {run.durationMs > 0 && ` · ${formatMs(run.durationMs)}`}
      </div>
      <TokenLine totals={run} />
    </li>
  )
}

function Empty({ scope }: { scope: SpendBreakdown["scope"] }) {
  return <p className="py-2 text-zinc-500">{scope === "task" ? "No usage recorded for this task yet." : "No usage recorded for this Captain yet."}</p>
}
