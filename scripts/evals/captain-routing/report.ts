// The Captain routing eval's report: reads the runs (run.ts, judged by judge.ts), grades them again with the current
// grader, and writes report.md and report.html next to them: pass rates per effort level and category with confidence
// intervals, failures with transcript excerpts, latency, tokens, cost and the judge's agreement with a hand check.
//
//   npx tsx scripts/evals/captain-routing/report.ts [scripts/evals/captain-routing/results] [--handcheck scripts/evals/captain-routing/handcheck.json]
//     [--reference low]   the group the paired differences compare against (default: the last effort level)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CASES, CATEGORIES, type Case } from "./fixtures.js"
import { grade, type Grade, type RunRecord } from "./grade.js"

export type Run = RunRecord & { grade: Grade; verbatim?: boolean | null }

const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"]
/** The group a run is reported in: its run.ts --label (a prompt variant, say), or else its effort level. */
export const groupOf = (r: Pick<RunRecord, "effort" | "label">) => r.label ?? r.effort

// ---------------------------------------------------------------- statistics

/** Wilson score interval (95%) for k of n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}

/** A seeded PRNG, so the bootstrap's intervals are the same every time the report is built. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 95% interval of a statistic over cases, resampling whole cases: a case's reps aren't independent (same message, same
 * state), so this is the honest interval for an overall rate; the Wilson one treats every run as independent.
 */
export function bootstrapCases(caseIds: string[], stat: (ids: string[]) => number, rounds = 4000): [number, number] {
  const r = rng(76)
  const vals: number[] = []
  for (let i = 0; i < rounds; i++) vals.push(stat(caseIds.map(() => caseIds[Math.floor(r() * caseIds.length)]!)))
  return [quantile(vals, 0.025)!, quantile(vals, 0.975)!]
}

// ---------------------------------------------------------------- failure types

/** What kind of mistake each check catches (in its case's category), worst first. */
export const FAILURE_TYPES: { type: string; match: (check: string, category: string) => boolean; matters: string }[] = [
  { type: "Turn failed", match: (c) => c === "turn", matters: "High: no answer at all." },
  { type: "Did another project's work", match: (c, cat) => cat === "cross-project" && /^no (create_task|create_tasks|send_to_task)$/.test(c), matters: "High: acts outside the Captain's project." },
  { type: "Closed a task or told an agent to", match: (c, cat) => c === "no close_task" || (cat === "no-close" && c === "message"), matters: "High: only the owner closes tasks." },
  { type: "Second merge of a PR already merging", match: (c) => /^no merge to /.test(c), matters: "High: two merges of one PR race each other." },
  {
    type: "Wrong routing (new task vs existing, wrong count or task, work for a question)",
    match: (c) => /^(created|messaged|batch|calls )/.test(c) || /^no (create_task|create_tasks|send_to_task|retry_task|reopen_task)$/.test(c),
    matters: "High: duplicate work, lost context, a task nobody asked for, or nothing happens.",
  },
  { type: "Dropped or changed a requirement in the hand-off", match: (c) => /^(prompt|message|judge)$/.test(c), matters: "High: the agent builds the wrong thing." },
  { type: "Unrequested or wrong task options", match: (c) => c === "options", matters: "Medium: pins model/effort/runner over the owner's Settings, or runs it in the wrong place." },
  { type: "Notes handled wrong", match: (c) => /^(suggestions|note added|notes unchanged|no update)$/.test(c), matters: "Medium: notes drift; Box Yard rejects what a retro leaves." },
  { type: "Reply missed the answer or didn't ask", match: (c) => /^(reply|asks)$/.test(c), matters: "Low to medium: the owner has to ask again." },
]
export const failureType = (check: string, category: string) => FAILURE_TYPES.find((f) => f.match(check, category))?.type ?? "Other"

// ---------------------------------------------------------------- loading

export function loadRuns(dir: string): Run[] {
  const runs: Run[] = []
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue
      const r = JSON.parse(line) as Run
      const c = CASES.find((x) => x.id === r.caseId)
      if (!c) continue
      runs.push({ ...r, grade: grade(c, r) })
    }
  }
  return runs
}

// ---------------------------------------------------------------- the document

type Block =
  | { h: 1 | 2 | 3; text: string }
  | { p: string }
  | { list: string[] }
  | { table: { head: string[]; rows: string[][]; align?: ("l" | "r")[] } }
  | { details: { summary: string; blocks: Block[] } }
  | { pre: string }
  /** HTML only (a chart); the markdown leaves it out, the table next to it carries the numbers. */
  | { html: string }

export interface DotRow {
  label: string
  value: number
  lo: number
  hi: number
  /** The value label at the row's end, and the hover text. */
  text: string
  tip: string
}

/**
 * A dot per row with a whisker (an interval, or median → p90): one series, so one hue and no legend; the title names
 * it. Each row's group carries a native tooltip and its numbers as a direct label.
 */
export function dotChart(title: string, rows: DotRow[], domain: [number, number], tick: (x: number) => string, ticks: number[]): string {
  const W = 680
  const left = 84
  const right = 230
  const top = 28
  const rowH = 34
  const H = top + rows.length * rowH + 26
  const x = (v: number) => left + ((Math.min(Math.max(v, domain[0]), domain[1]) - domain[0]) / (domain[1] - domain[0])) * (W - left - right)
  const grid = ticks
    .map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 22}" class="grid"/><text x="${x(t)}" y="${H - 6}" class="tick" text-anchor="middle">${esc(tick(t))}</text>`)
    .join("")
  const marks = rows
    .map((r, i) => {
      const y = top + i * rowH + rowH / 2
      return `<g class="row"><title>${esc(r.tip)}</title><rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" class="hit"/><text x="${left - 12}" y="${y + 4}" class="label" text-anchor="end">${esc(r.label)}</text><line x1="${x(r.lo)}" x2="${x(r.hi)}" y1="${y}" y2="${y}" class="whisker"/><circle cx="${x(r.value)}" cy="${y}" r="5" class="dot"/><text x="${W - right + 14}" y="${y + 4}" class="value">${esc(r.text)}</text></g>`
    })
    .join("")
  return `<figure class="viz-root"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="${esc(title)}">${grid}${marks}</svg></figure>`
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
/** The little inline markdown the report uses (**bold**, `code`) as HTML. */
const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")

export function toMarkdown(blocks: Block[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
  return blocks
    .filter((b) => !("html" in b))
    .map((b) => {
      if ("h" in b) return `${"#".repeat(b.h + 1)} ${b.text}`
      if ("p" in b) return b.p
      if ("list" in b) return b.list.map((x) => `- ${x}`).join("\n")
      if ("table" in b) {
        const { head, rows, align } = b.table
        return [`| ${head.map(cell).join(" | ")} |`, `| ${head.map((_, i) => (align?.[i] === "r" ? "---:" : "---")).join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n")
      }
      if ("details" in b) return `<details><summary>${esc(b.details.summary)}</summary>\n\n${toMarkdown(b.details.blocks)}\n\n</details>`
      if ("html" in b) return ""
      return "```text\n" + b.pre.replace(/```/g, "ˋˋˋ") + "\n```"
    })
    .join("\n\n")
}

export function toHtml(title: string, blocks: Block[]): string {
  const render = (bs: Block[]): string =>
    bs
      .map((b) => {
        if ("h" in b) return `<h${b.h}>${inline(b.text)}</h${b.h}>`
        if ("p" in b) return `<p>${inline(b.p)}</p>`
        if ("list" in b) return `<ul>${b.list.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`
        if ("table" in b) {
          const { head, rows, align } = b.table
          const td = (s: string, i: number, tag: string) => `<${tag}${align?.[i] === "r" ? ' class="r"' : ""}>${inline(s)}</${tag}>`
          return `<div class="scroll"><table><thead><tr>${head.map((h, i) => td(h, i, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => td(c, i, "td")).join("")}</tr>`).join("")}</tbody></table></div>`
        }
        if ("details" in b) return `<details><summary>${inline(b.details.summary)}</summary>${render(b.details.blocks)}</details>`
        if ("html" in b) return b.html
        return `<pre>${esc(b.pre)}</pre>`
      })
      .join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --bg: #fff; --code: #f5f5f7; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --bg: #161617; --code: #232325; } }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; color: var(--fg); background: var(--bg); max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 26px; } h2 { margin-top: 36px; border-bottom: 1px solid var(--line); padding-bottom: 4px; } h3 { margin-top: 24px; }
  table { border-collapse: collapse; margin: 8px 0 16px; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid var(--line); padding: 4px 10px; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; } .r { text-align: right; } td.r { white-space: nowrap; }
  .scroll { overflow-x: auto; }
  code, pre { background: var(--code); border-radius: 4px; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { padding: 1px 4px; } pre { padding: 10px 12px; white-space: pre-wrap; word-break: break-word; }
  details { margin: 6px 0; } summary { cursor: pointer; }
  .viz-root { --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --grid: #e4e3df; --series-1: #2a78d6; margin: 12px 0 20px; }
  @media (prefers-color-scheme: dark) { .viz-root { --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --grid: #34332f; --series-1: #3987e5; } }
  .viz-root figcaption { font-weight: 600; margin-bottom: 4px; }
  .viz-root svg { max-width: 100%; height: auto; font: 12.5px system-ui, sans-serif; }
  .viz-root .grid { stroke: var(--grid); stroke-width: 1; }
  .viz-root .tick { fill: var(--text-secondary); }
  .viz-root .label { fill: var(--text-primary); font-weight: 600; }
  .viz-root .value { fill: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .viz-root .whisker { stroke: var(--series-1); stroke-width: 2; stroke-linecap: round; }
  .viz-root .dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
  .viz-root .hit { fill: transparent; }
  .viz-root .row:hover .hit { fill: var(--grid); fill-opacity: 0.45; }
</style></head><body>
<h1>${esc(title)}</h1>
${render(blocks)}
</body></html>
`
}

// ---------------------------------------------------------------- building it

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const ci = ([a, b]: [number, number]) => `${(a * 100).toFixed(0)}–${(b * 100).toFixed(0)}%`
const sec = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`)
const usd = (x: number) => `$${x.toFixed(3)}`
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const short = (v: unknown, n = 260) => clip(typeof v === "string" ? v : JSON.stringify(v), n)

export interface LevelStats {
  level: string
  runs: number
  passed: number
  rate: number
  wilson: [number, number]
  boot: [number, number]
  /** Cases that passed on every rep. */
  solid: number
  cases: number
  p50: number | null
  p90: number | null
  p50NoWait: number | null
  p90NoWait: number | null
  modelP50: number | null
  costPerCase: number
  costTotal: number
  outTokens: number
  cacheRead: number
  cacheWrite: number
  turnErrors: number
}

export function levelStats(level: string, runs: Run[]): LevelStats {
  const mine = runs.filter((r) => groupOf(r) === level)
  const ids = [...new Set(mine.map((r) => r.caseId))]
  const byCase = new Map(ids.map((id) => [id, mine.filter((r) => r.caseId === id)]))
  const caseRate = (id: string) => {
    const rs = byCase.get(id)!
    return rs.filter((r) => r.grade.pass).length / rs.length
  }
  const lat = mine.map((r) => r.latencyMs).filter((x): x is number => x !== null)
  const latNoWait = mine.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs! - (r.waitMs ?? 0))
  const passed = mine.filter((r) => r.grade.pass).length
  return {
    level,
    runs: mine.length,
    passed,
    rate: mine.length ? passed / mine.length : 0,
    wilson: wilson(passed, mine.length),
    // Each case weighs the same (its own pass rate), whatever its rep count.
    boot: bootstrapCases(ids, (s) => mean(s.map(caseRate))),
    solid: ids.filter((id) => byCase.get(id)!.every((r) => r.grade.pass)).length,
    cases: ids.length,
    p50: quantile(lat, 0.5),
    p90: quantile(lat, 0.9),
    p50NoWait: quantile(latNoWait, 0.5),
    p90NoWait: quantile(latNoWait, 0.9),
    modelP50: quantile(mine.map((r) => r.modelMs ?? 0), 0.5),
    costPerCase: mean(mine.map((r) => r.costUsd)),
    costTotal: mine.reduce((a, r) => a + r.costUsd, 0),
    outTokens: mean(mine.map((r) => r.tokens.output)),
    cacheRead: mean(mine.map((r) => r.tokens.cacheRead)),
    cacheWrite: mean(mine.map((r) => r.tokens.cacheWrite)),
    turnErrors: mine.filter((r) => !r.ok).length,
  }
}

interface HandCheck {
  effort: string
  caseId: string
  rep: number
  /** One verdict per rubric item, in the case's order. */
  items: boolean[]
  note?: string
}

export function buildReport(runs: Run[], handcheck: HandCheck[] = [], reference?: string): { blocks: Block[]; stats: LevelStats[] } {
  const levels = [...new Set(runs.map(groupOf))].sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))
  const stats = levels.map((l) => levelStats(l, runs))
  const blocks: Block[] = []
  const model = "claude-opus-5-5"
  const reps = Math.max(0, ...runs.map((r) => r.rep))

  blocks.push({
    p: `${runs.length} runs: ${CASES.length} cases × up to ${reps} rep${reps === 1 ? "" : "s"} × ${levels.length} ${runs.some((r) => r.label) ? "variants" : "effort levels"} (${levels.join(", ")}), Captain on ${model}. Each run is a fresh Captain session in a scratch Box Yard seeded with the same storefront project. Task agents are fake, so only the Captain's own turn is measured.`,
  })

  blocks.push({ h: 1, text: "Summary" })
  blocks.push({
    table: {
      head: ["Effort", "Pass rate", "95% CI (cases)", "95% CI (runs)", "Cases passing every rep", "Median latency", "p90 latency", "Median model time", "$ per case", "Output tokens per case", "Turn errors"],
      align: ["l", "r", "r", "r", "r", "r", "r", "r", "r", "r", "r"],
      rows: stats.map((s) => [s.level, `${pct(s.rate)} (${s.passed}/${s.runs})`, ci(s.boot), ci(s.wilson), `${s.solid}/${s.cases}`, sec(s.p50), sec(s.p90), sec(s.modelP50), usd(s.costPerCase), s.outTokens.toFixed(0), String(s.turnErrors)]),
    },
  })
  const lo = Math.max(0, Math.floor((Math.min(...stats.map((x) => x.boot[0])) - 0.05) * 10) / 10)
  const rateTicks = Array.from({ length: Math.round((1 - lo) * 10) + 1 }, (_, i) => Math.round((lo + i * 0.1) * 10) / 10)
  blocks.push({
    html: dotChart(
      "Pass rate by effort, with its 95% interval (cases resampled)",
      stats.map((x) => ({ label: x.level, value: x.rate, lo: x.boot[0], hi: x.boot[1], text: `${pct(x.rate)}  (${ci(x.boot)})`, tip: `${x.level}: ${x.passed}/${x.runs} runs passed, ${pct(x.rate)}; 95% CI ${ci(x.boot)} over cases, ${ci(x.wilson)} over runs` })),
      [lo, 1],
      (t) => `${Math.round(t * 100)}%`,
      rateTicks,
    ),
  })
  const maxLat = Math.ceil(Math.max(...stats.map((x) => x.p90 ?? 0)) / 5000) * 5000 || 5000
  blocks.push({
    html: dotChart(
      "Captain turn latency by effort: median (dot) to p90 (whisker end)",
      stats.map((x) => ({ label: x.level, value: x.p50 ?? 0, lo: x.p50 ?? 0, hi: x.p90 ?? 0, text: `median ${sec(x.p50)} · p90 ${sec(x.p90)}`, tip: `${x.level}: median ${sec(x.p50)}, p90 ${sec(x.p90)}, median model time ${sec(x.modelP50)}` })),
      [0, maxLat],
      (t) => `${t / 1000} s`,
      Array.from({ length: maxLat / 5000 + 1 }, (_, i) => i * 5000),
    ),
  })
  blocks.push({
    p: "Latency runs from posting the message to the Captain's result line. The cases interval resamples whole cases, because a case's reps aren't independent; the runs interval (Wilson) treats every run as independent and is narrower than it should be.",
  })

  // Paired: the same cases at each level.
  if (levels.length > 1) {
    const ref = reference && levels.includes(reference) ? reference : levels.at(-1)!
    const rows: string[][] = []
    for (const l of levels.filter((x) => x !== ref)) {
      const ids = [...new Set(runs.map((r) => r.caseId))].filter((id) => runs.some((r) => r.caseId === id && groupOf(r) === l) && runs.some((r) => r.caseId === id && groupOf(r) === ref))
      const rate = (lev: string, id: string) => {
        const rs = runs.filter((r) => r.caseId === id && groupOf(r) === lev)
        return rs.filter((r) => r.grade.pass).length / rs.length
      }
      const diff = (s: string[]) => mean(s.map((id) => rate(l, id) - rate(ref, id)))
      const [a, b] = bootstrapCases(ids, diff)
      const worse = ids.filter((id) => rate(l, id) < rate(ref, id)).length
      const better = ids.filter((id) => rate(l, id) > rate(ref, id)).length
      rows.push([`${l} − ${ref}`, `${(diff(ids) * 100).toFixed(1)} pts`, `${(a * 100).toFixed(1)} to ${(b * 100).toFixed(1)} pts`, String(worse), String(better)])
    }
    blocks.push({ h: 2, text: `Paired difference against ${ref}` })
    blocks.push({ table: { head: ["Levels", "Pass-rate difference", "95% CI (cases)", `Cases worse than ${ref}`, `Cases better than ${ref}`], align: ["l", "r", "r", "r", "r"], rows } })
  }

  blocks.push({ h: 2, text: "Latency and cost" })
  // Time in wait_for_tasks is the tasks' time, not the Captain's: show latency without it, when any run waited.
  const waited = runs.some((r) => (r.waitMs ?? 0) > 0)
  const noWait = (s: (typeof stats)[number]) => (waited ? [sec(s.p50NoWait), sec(s.p90NoWait)] : [])
  blocks.push({
    table: {
      head: ["Effort", "Median latency", "p90 latency", ...(waited ? ["Median without wait_for_tasks", "p90 without wait_for_tasks"] : []), "Cache read tokens per case", "Cache write tokens per case", "Total $"],
      align: ["l", "r", "r", ...(waited ? (["r", "r"] as const) : []), "r", "r", "r"],
      rows: stats.map((s) => [s.level, sec(s.p50), sec(s.p90), ...noWait(s), s.cacheRead.toFixed(0), s.cacheWrite.toFixed(0), `$${s.costTotal.toFixed(2)}`]),
    },
  })
  if (!waited) blocks.push({ p: "No Captain called wait_for_tasks, so all of each turn's latency is the Captain's own." })

  // Per category.
  blocks.push({ h: 1, text: "By category" })
  const cats = CATEGORIES.filter((c) => runs.some((r) => CASES.find((x) => x.id === r.caseId)?.category === c))
  blocks.push({
    table: {
      head: ["Category", "Cases", ...levels.map((l) => `${l} (95% CI)`)],
      align: ["l", "r", ...levels.map(() => "r" as const)],
      rows: cats.map((cat) => {
        const ids = CASES.filter((c) => c.category === cat).map((c) => c.id)
        return [
          cat,
          String(ids.length),
          ...levels.map((l) => {
            const rs = runs.filter((r) => groupOf(r) === l && ids.includes(r.caseId))
            const k = rs.filter((r) => r.grade.pass).length
            return rs.length ? `${pct(k / rs.length)} (${ci(wilson(k, rs.length))})` : "–"
          }),
        ]
      }),
    },
  })

  // Failure types.
  blocks.push({ h: 1, text: "Failure types" })
  const typeCounts = (l: string) => {
    const counts = new Map<string, number>()
    for (const r of runs.filter((x) => groupOf(x) === l && !x.grade.pass)) {
      const cat = CASES.find((c) => c.id === r.caseId)!.category
      for (const t of new Set(r.grade.checks.filter((c) => !c.pass).map((c) => failureType(c.name, cat)))) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return counts
  }
  const tc = new Map(levels.map((l) => [l, typeCounts(l)]))
  const typeRows = [...FAILURE_TYPES.map((f) => f.type), "Other"]
    .filter((t) => levels.some((l) => tc.get(l)!.get(t)))
    .map((t) => [t, FAILURE_TYPES.find((f) => f.type === t)?.matters ?? "", ...levels.map((l) => String(tc.get(l)!.get(t) ?? 0))])
  if (typeRows.length) {
    blocks.push({ table: { head: ["Failure type", "Why it matters", ...levels.map((l) => `${l} runs`)], align: ["l", "l", ...levels.map(() => "r" as const)], rows: typeRows } })
    blocks.push({ p: "A run can fail in more than one way, so a row counts the runs with at least one failure of that type." })
  } else blocks.push({ p: "No run failed." })

  // Per case.
  blocks.push({ h: 1, text: "By case" })
  blocks.push({
    table: {
      head: ["Case", "Category", ...levels],
      align: ["l", "l", ...levels.map(() => "r" as const)],
      rows: CASES.filter((c) => runs.some((r) => r.caseId === c.id)).map((c) => [
        c.id,
        c.category,
        ...levels.map((l) => {
          const rs = runs.filter((r) => groupOf(r) === l && r.caseId === c.id)
          return rs.length ? `${rs.filter((r) => r.grade.pass).length}/${rs.length}` : "–"
        }),
      ]),
    },
  })

  // Judge.
  const judged = runs.filter((r) => r.judge)
  if (judged.length) {
    blocks.push({ h: 1, text: "Prompt quality and the judge" })
    blocks.push({
      table: {
        head: ["Effort", "Judged runs", "Judge pass", "Rubric items kept", "Prompts quoting the request word for word"],
        align: ["l", "r", "r", "r", "r"],
        rows: levels.map((l) => {
          const js = judged.filter((r) => groupOf(r) === l)
          const items = js.flatMap((r) => r.judge!.items)
          const withTasks = runs.filter((r) => groupOf(r) === l && r.created.length && r.message && typeof r.verbatim === "boolean")
          return [l, String(js.length), js.length ? pct(js.filter((r) => r.judge!.pass).length / js.length) : "–", items.length ? pct(items.filter((i) => i.pass).length / items.length) : "–", withTasks.length ? `${pct(withTasks.filter((r) => r.verbatim).length / withTasks.length)} of ${withTasks.length}` : "–"]
        }),
      },
    })
    const judgeCost = judged.reduce((a, r) => a + (r.judge?.costUsd ?? 0), 0)
    blocks.push({ p: `Judge: ${judged[0]!.judge!.model}, $${judgeCost.toFixed(2)} in all.` })
    if (handcheck.length) {
      let agree = 0
      let total = 0
      let runAgree = 0
      let runTotal = 0
      const misses: string[] = []
      for (const h of handcheck) {
        const r = judged.find((x) => groupOf(x) === h.effort && x.caseId === h.caseId && x.rep === h.rep)
        if (!r) continue
        runTotal++
        if (r.judge!.pass === h.items.every(Boolean)) runAgree++
        h.items.forEach((mine, i) => {
          const theirs = r.judge!.items[i]?.pass
          if (theirs === undefined) return
          total++
          if (theirs === mine) agree++
          else misses.push(`${h.effort} ${h.caseId} rep ${h.rep}, "${r.judge!.items[i]!.item}": judge ${theirs ? "pass" : "fail"}, hand ${mine ? "pass" : "fail"}${h.note ? ` (${h.note})` : ""}`)
        })
      }
      blocks.push({ h: 2, text: "Judge agreement with a hand check" })
      blocks.push({ p: `On ${runTotal} hand-checked runs, the judge agreed with the hand check on ${agree}/${total} rubric items (${pct(total ? agree / total : 0)}) and on ${runAgree}/${runTotal} whole verdicts (${pct(runTotal ? runAgree / runTotal : 0)}). The sample (\`handcheck.json\`) is rep 1 at each level plus every run the judge failed, so it leans towards disagreements. Each hand verdict was written before reading the judge's reasons.` })
      if (misses.length) blocks.push({ list: misses })
    }
  }

  // Failures.
  blocks.push({ h: 1, text: "Failures" })
  for (const l of levels) {
    const failed = runs.filter((r) => groupOf(r) === l && !r.grade.pass).sort((a, b) => CASES.findIndex((c) => c.id === a.caseId) - CASES.findIndex((c) => c.id === b.caseId) || a.rep - b.rep)
    blocks.push({ h: 2, text: `${l}: ${failed.length} failed run${failed.length === 1 ? "" : "s"}` })
    for (const r of failed) blocks.push(failureBlock(r, CASES.find((c) => c.id === r.caseId)!))
  }
  return { blocks, stats }
}

function failureBlock(r: Run, c: Case): Block {
  const bad = r.grade.checks.filter((x) => !x.pass)
  const lines: string[] = []
  lines.push(`Message: ${r.message ?? "(notes retro wake-up)"}`)
  for (const t of r.transcript ?? []) {
    if (t.k === "user") continue
    if (t.k === "tool") lines.push(`→ ${t.name.replace(/^mcp__boxyard__/, "")} ${short(t.input, 600)}`)
    else if (t.k === "result") lines.push(`  ← ${t.isError ? "ERROR " : ""}${short(t.text, 240)}`)
    else lines.push(`Captain: ${clip(t.text, 1200)}`)
  }
  if (!(r.transcript ?? []).length) {
    for (const t of r.tools) lines.push(`→ ${t.name.replace(/^mcp__boxyard__/, "")} ${short(t.input, 600)}`)
    lines.push(`Reply: ${clip(r.replies.join("\n\n"), 1200)}`)
  }
  for (const t of r.created) lines.push(`\nCreated "${t.title}":\n${clip(t.prompt, 1500)}`)
  return {
    details: {
      summary: `${c.id} rep ${r.rep}: ${bad.map((b) => `${b.name}: ${clip(b.detail, 160)}`).join("; ")}`,
      blocks: [{ p: `**Expected:** ${c.why}` }, { pre: lines.join("\n") }],
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const hi = args.indexOf("--handcheck")
  const ri = args.indexOf("--reference")
  const here = path.dirname(fileURLToPath(import.meta.url))
  const handPath = hi >= 0 ? args[hi + 1]! : path.join(here, "handcheck.json")
  const reference = ri >= 0 ? args[ri + 1] : undefined
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--handcheck" && args[i - 1] !== "--reference") ?? path.join(here, "results")
  const runs = loadRuns(dir)
  if (!runs.length) throw new Error(`No runs in ${dir}`)
  const handcheck = fs.existsSync(handPath) ? (JSON.parse(fs.readFileSync(handPath, "utf8")) as HandCheck[]) : []
  const { blocks, stats } = buildReport(runs, handcheck, reference)
  const title = runs.some((r) => r.label) ? `Captain routing eval: ${stats.map((s) => s.level).join(" vs ")}` : "Captain routing eval: Opus 5.5 at low, medium and xhigh effort"
  fs.writeFileSync(path.join(dir, "report.md"), `# ${title}\n\n${toMarkdown(blocks)}\n`)
  fs.writeFileSync(path.join(dir, "report.html"), toHtml(title, blocks))
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(stats, null, 2))
  for (const s of stats) console.log(`${s.level}: ${pct(s.rate)} (${s.passed}/${s.runs}), CI ${ci(s.boot)}, median ${sec(s.p50)}, p90 ${sec(s.p90)}, ${usd(s.costPerCase)}/case, $${s.costTotal.toFixed(2)} total`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
