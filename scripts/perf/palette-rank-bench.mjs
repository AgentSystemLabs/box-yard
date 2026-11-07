// Command palette ranking cost on a big yard, in Node (no browser): building the items, and ranking them per keystroke.
//
//   node --expose-gc --import tsx scripts/perf/palette-rank-bench.mjs [projects] [tasks] [artifacts]
//
// Types each query in scripts/perf/palette-yard.mjs one character at a time, the way the palette sees it, and prints
// JSON: median and worst milliseconds per keystroke, the build cost, and the cost of indexing rows never searched, over
// several runs. With --expose-gc it also prints the heap one open holds, and what stays once it closes.
import { buildItems } from "../../web/src/lib/palette.ts"
import * as rank from "../../web/src/lib/paletteRank.ts"
import { QUERIES, paletteYard } from "./palette-yard.mjs"

const { parseQuery, rankPalette } = rank
const [projects = 300, tasks = 5000, artifacts = 1000] = process.argv.slice(2).map(Number)
const now = Date.now()
const yard = paletteYard({ projects, tasks, artifacts, now })
const queries = [...QUERIES, `${yard.projects[3].name} failed`]
const RUNS = 7

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const r2 = (n) => Math.round(n * 100) / 100

const build = []
const perKey = []
const worstKey = []
let items = buildItems(yard)
for (let run = 0; run < RUNS + 1; run++) {
  // Fresh arrays, like a refetched list: nothing can be cached on the old ones.
  const data = { tasks: [...yard.tasks], projects: [...yard.projects], artifacts: [...yard.artifacts] }
  const t0 = performance.now()
  items = buildItems(data)
  const built = performance.now() - t0
  const keys = []
  for (const q of queries) {
    for (let i = 1; i <= q.length; i++) {
      const t = performance.now()
      rankPalette(items, parseQuery(q.slice(0, i)), { now, recent: [], usage: {} })
      keys.push(performance.now() - t)
    }
  }
  // The first run warms the JIT.
  if (run === 0) continue
  build.push(built)
  perKey.push(median(keys))
  worstKey.push(Math.max(...keys))
}

items = null

// Indexing rows nothing has searched yet. A palette without the index lowercases on every keystroke instead.
const indexing = []
for (let run = 0; rank.paletteIndex && run < RUNS; run++) {
  const fresh = buildItems(paletteYard({ projects, tasks, artifacts, now }))
  const t0 = performance.now()
  rank.paletteIndex(fresh)
  indexing.push(performance.now() - t0)
}

// An open on rows nothing has seen yet: build, then rank a query.
let memory
if (globalThis.gc) {
  const heap = () => (gc(), gc(), process.memoryUsage().heapUsed)
  const open = (rows) => {
    const list = buildItems(rows)
    rankPalette(list, parseQuery("box"), { now, recent: [], usage: {} })
    return heap()
  }
  const rows = paletteYard({ projects, tasks, artifacts, now })
  const before = heap()
  const whileOpen = open(rows) - before
  const mb = (n) => Math.round(n / 1e4) / 100
  memory = { whileOpenMB: mb(whileOpen), afterCloseMB: mb(heap() - before) }
}

console.log(
  JSON.stringify(
    {
      yard: { projects, tasks, artifacts, items: buildItems(yard).length },
      keystrokes: queries.reduce((n, q) => n + q.length, 0),
      buildMs: r2(median(build)),
      rankPerKeyMedianMs: r2(median(perKey)),
      rankPerKeyWorstMs: r2(median(worstKey)),
      indexNewRowsMs: indexing.length ? r2(median(indexing)) : null,
      runs: RUNS,
      memory,
    },
    null,
    2,
  ),
)
