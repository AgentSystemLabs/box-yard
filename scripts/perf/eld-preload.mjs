// Preloaded into the server by scripts/perf/server-eld.mjs (node --import): watches the event loop.
// SIGUSR2 appends what it saw since the last SIGUSR2 to $ELD_OUT as one JSON line, then starts over:
// event-loop delay percentiles (perf_hooks monitorEventLoopDelay, 5 ms resolution, so ~5 ms is an idle loop),
// stalls over 50 ms, and the CPU time the process used.
import fs from "node:fs"
import { monitorEventLoopDelay } from "node:perf_hooks"

const out = process.env.ELD_OUT
const delay = monitorEventLoopDelay({ resolution: 5 })
delay.enable()
let stalls = []
let cpu = process.cpuUsage()
let since = performance.now()
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  if (now - last - 10 > 50) stalls.push(Math.round(now - last - 10))
  last = now
}, 10).unref()

const ms = (ns) => Math.round(ns / 1e5) / 10
process.on("SIGUSR2", () => {
  const used = process.cpuUsage(cpu)
  const wall = performance.now() - since
  const line = {
    p50: ms(delay.percentile(50)),
    p99: ms(delay.percentile(99)),
    max: ms(delay.max),
    stalls50: stalls.length,
    stallMs: stalls.reduce((a, b) => a + b, 0),
    cpuMs: Math.round((used.user + used.system) / 1000),
    wallMs: Math.round(wall),
  }
  if (out) fs.appendFileSync(out, JSON.stringify(line) + "\n")
  delay.reset()
  stalls = []
  cpu = process.cpuUsage()
  since = performance.now()
})
