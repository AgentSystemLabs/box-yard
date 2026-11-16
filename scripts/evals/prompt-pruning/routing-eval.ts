// The Captain routing eval: runs each case (captain-cases.ts, rendered by render-captain-turns.ts) through the real
// claude CLI the way Box Yard runs a Captain turn (its built-in tools, --permission-mode dontAsk, Box Yard's system
// prompt appended, the MCP tools with their always-load marks), against a stub MCP server that answers from a canned
// project (eval-mcp.mjs). Each system-prompt variant runs every chosen case --runs times; grading reads the tool calls
// and the final reply.
//
//   npx tsx scripts/evals/prompt-pruning/routing-eval.ts --render <dir> --tools tools.captain.json --root <scratch>
//       --variant base=captain.system.md [--variant pruned=pruned.md[@tools.json]] [--cases a,b | --sections x,y]
//       [--runs 3] [--model claude-opus-5-5] [--effort high] [--concurrency 3] [--out results.jsonl] [--max-usd 40]
//   npx tsx scripts/evals/prompt-pruning/routing-eval.ts --summary results.jsonl
//
// The summary grades every stored run again with the current graders (from its saved tool calls and reply), so a
// grader fix doesn't need new runs; it says how many verdicts changed.
//
// Spends real money: every run is a model call on the machine's Claude login. --max-usd stops starting new runs once
// the results file's total passes it. Sessions aren't saved (--no-session-persistence), gh sees an empty config
// (GH_CONFIG_DIR), and nothing reaches a Box Yard server.
import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { CAPTAIN_TOOLS } from "../../../server/chatAgent.js"
import { CASES, type Call, type CaptainCase } from "./captain-cases.js"
import { cleanEnv, removeEmptyProjectDir } from "./cli-env.js"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const opts = (name: string) => {
  const out: string[] = []
  for (let v = opt(name); v !== undefined; v = opt(name)) out.push(v)
  return out
}

export interface Result {
  variant: string
  case: string
  run: number
  pass: boolean
  failures: string[]
  calls: Call[]
  reply: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  costUsd: number
  ms: number
  turns: number
  model: string
  effort: string
  error?: string
  at: string
}

const readResults = (file: string): Result[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Result)
    : []

// ---------------------------------------------------------------- summary
function summary(file: string) {
  let changed = 0
  const rows = readResults(file).map((r) => {
    const c = CASES.find((x) => x.id === r.case)
    if (!c || r.error) return r
    const failures = c.grade({ calls: r.calls, reply: r.reply })
    if ((failures.length === 0) !== r.pass) changed++
    return { ...r, failures, pass: failures.length === 0 }
  })
  const variants = [...new Set(rows.map((r) => r.variant))]
  const cases = [...new Set(rows.map((r) => r.case))]
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-")
  console.log(`| case | ${variants.join(" | ")} |`)
  console.log(`| --- | ${variants.map(() => "---").join(" | ")} |`)
  for (const c of cases) {
    const cells = variants.map((v) => {
      const rs = rows.filter((r) => r.variant === v && r.case === c)
      return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : ""
    })
    console.log(`| ${c} | ${cells.join(" | ")} |`)
  }
  const stat = (v: string, f: (r: Result) => number) => {
    const rs = rows.filter((r) => r.variant === v)
    return rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : 0
  }
  const passes = variants.map((v) => {
    const rs = rows.filter((r) => r.variant === v)
    return `${rs.filter((r) => r.pass).length}/${rs.length} (${pct(rs.filter((r) => r.pass).length, rs.length)})`
  })
  console.log(`| **pass** | ${passes.join(" | ")} |`)
  console.log(`| tokens in / run | ${variants.map((v) => Math.round(stat(v, (r) => r.input + r.cacheWrite + r.cacheRead))).join(" | ")} |`)
  console.log(`| cache write / run | ${variants.map((v) => Math.round(stat(v, (r) => r.cacheWrite))).join(" | ")} |`)
  console.log(`| output / run | ${variants.map((v) => Math.round(stat(v, (r) => r.output))).join(" | ")} |`)
  console.log(`| model steps / run | ${variants.map((v) => stat(v, (r) => r.turns).toFixed(1)).join(" | ")} |`)
  console.log(`| seconds / run | ${variants.map((v) => (stat(v, (r) => r.ms) / 1000).toFixed(1)).join(" | ")} |`)
  console.log(`| $ / run | ${variants.map((v) => stat(v, (r) => r.costUsd).toFixed(3)).join(" | ")} |`)
  console.log(`\nTotal spend: $${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(2)} over ${rows.length} runs`)
  if (changed) console.log(`Regraded with the current graders: ${changed} verdict${changed === 1 ? "" : "s"} changed.`)
  const failed = rows.filter((r) => !r.pass)
  if (failed.length) {
    console.log("\nFailures:")
    for (const r of failed) console.log(`- ${r.variant} ${r.case} #${r.run}: ${r.error ?? r.failures.join("; ")}`)
  }
}

// ---------------------------------------------------------------- one run
interface Setup {
  render: string
  tools: string
  root: string
  model: string
  effort: string
}

async function runOne(s: Setup, variant: string, system: string, toolsFile: string, c: CaptainCase, run: number): Promise<Result> {
  const clone = path.join(s.root, "captain", "repo")
  const dir = path.join(s.root, "runs", `${variant}.${c.id}.${run}.${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, "calls.jsonl")
  const fixtures = path.join(dir, "fixtures.json")
  fs.writeFileSync(fixtures, JSON.stringify(c.fixtures ?? {}))
  const mcp = path.join(dir, "mcp.json")
  const server = path.join(import.meta.dirname, "eval-mcp.mjs")
  fs.writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { boxyard: { type: "stdio", command: process.execPath, args: [server, "--tools", toolsFile, "--state", path.join(s.render, "state.json"), "--log", log, "--fixtures", fixtures] } } }),
  )
  const prompt = fs.readFileSync(path.join(s.render, "cases", `${c.id}.md`), "utf8")
  const argv = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcp,
    "--tools",
    CAPTAIN_TOOLS,
    "--allowedTools",
    ["mcp__boxyard", "WebSearch", "WebFetch", "ToolSearch", `Read(/${clone}/**)`].join(","),
    "--disallowedTools",
    [`Edit(/${clone}/**)`, `Write(/${clone}/**)`].join(","),
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt",
    system,
    "--model",
    s.model,
    "--effort",
    s.effort,
  ]
  const ghConfig = path.join(s.root, "gh-empty")
  fs.mkdirSync(ghConfig, { recursive: true })
  const started = Date.now()
  const out = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn("claude", argv, { cwd: path.join(s.root, "captain"), env: { ...cleanEnv(), GH_CONFIG_DIR: ghConfig }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGTERM"), 8 * 60_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
  fs.writeFileSync(path.join(dir, "stream.jsonl"), out.stdout)
  const calls: Call[] = []
  let final: Record<string, any> | null = null
  for (const line of out.stdout.split("\n")) {
    if (!line.trim()) continue
    let ev: Record<string, any>
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === "assistant")
      for (const b of ev.message?.content ?? []) if (b.type === "tool_use") calls.push({ name: String(b.name).replace(/^mcp__boxyard__/, ""), input: b.input ?? {} })
    if (ev.type === "result") final = ev
  }
  const reply = typeof final?.result === "string" ? final.result : ""
  const u = final?.usage ?? {}
  const error = !final ? `no result (exit ${out.code}): ${out.stderr.slice(0, 300)}` : final.is_error ? `error: ${String(final.result ?? final.subtype).slice(0, 300)}` : undefined
  const failures = error ? [error] : c.grade({ calls, reply })
  return {
    variant,
    case: c.id,
    run,
    pass: !error && failures.length === 0,
    failures,
    calls,
    reply: reply.slice(0, 1500),
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    costUsd: final?.total_cost_usd ?? 0,
    ms: final?.duration_ms ?? Date.now() - started,
    turns: final?.num_turns ?? 0,
    model: s.model,
    effort: s.effort,
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const summaryFile = opt("--summary")
  if (summaryFile) return summary(summaryFile)
  const render = opt("--render")
  const tools = opt("--tools")
  const root = opt("--root")
  if (!render || !tools || !root) throw new Error("--render, --tools and --root are required (see the header)")
  const s: Setup = { render: path.resolve(render), tools: path.resolve(tools), root: path.resolve(root), model: opt("--model") ?? "claude-opus-5-5", effort: opt("--effort") ?? "high" }
  const variants = opts("--variant").map((v) => {
    const [name, spec] = v.split("=") as [string, string]
    const [system, toolsFile] = spec.split("@") as [string, string | undefined]
    return { name, system: fs.readFileSync(system, "utf8"), tools: path.resolve(toolsFile ?? s.tools) }
  })
  if (!variants.length) variants.push({ name: "base", system: fs.readFileSync(path.join(s.render, "captain.system.md"), "utf8"), tools: s.tools })
  const only = opt("--cases")?.split(",")
  const sections = opt("--sections")?.split(",")
  const cases = CASES.filter((c) => (!only || only.includes(c.id)) && (!sections || c.sections.some((x) => sections.includes(x))))
  const runs = Number(opt("--runs") ?? 3)
  const concurrency = Number(opt("--concurrency") ?? 3)
  const outFile = path.resolve(opt("--out") ?? path.join(s.root, "results.jsonl"))
  const maxUsd = Number(opt("--max-usd") ?? 40)
  const spentBefore = Number(opt("--spent") ?? 0)

  // The Captain's read-only clone: this checkout's HEAD, exported once.
  const clone = path.join(s.root, "captain", "repo")
  if (!fs.existsSync(clone)) {
    fs.mkdirSync(clone, { recursive: true })
    execFileSync("sh", ["-c", `git archive HEAD | tar -x -C '${clone}'`], { cwd: path.join(import.meta.dirname, "../../..") })
  }

  // Same variant back to back, so its system prompt and tools stay in the prompt cache between runs.
  const jobs = variants.flatMap((v) => Array.from({ length: runs }, (_, run) => cases.map((c) => ({ v, c, run: run + 1 }))).flat())
  let spent = spentBefore + readResults(outFile).reduce((n, r) => n + r.costUsd, 0)
  console.error(`${jobs.length} runs (${variants.length} variants × ${cases.length} cases × ${runs}); spent so far $${spent.toFixed(2)}, cap $${maxUsd}`)
  let next = 0
  let stopped = false
  const worker = async () => {
    while (next < jobs.length && !stopped) {
      const j = jobs[next++]!
      if (spent >= maxUsd) {
        stopped = true
        console.error(`stopping: spend $${spent.toFixed(2)} passed the $${maxUsd} cap`)
        return
      }
      const r = await runOne(s, j.v.name, j.v.system, j.v.tools, j.c, j.run)
      spent += r.costUsd
      fs.appendFileSync(outFile, JSON.stringify(r) + "\n")
      console.error(
        `${r.pass ? "PASS" : "FAIL"} ${j.v.name} ${j.c.id} #${j.run} · ${r.turns} steps · ${(r.ms / 1000).toFixed(1)} s · $${r.costUsd.toFixed(3)} · total $${spent.toFixed(2)}${r.pass ? "" : ` · ${r.failures.join("; ")}`}`,
      )
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  removeEmptyProjectDir(path.join(s.root, "captain"))
}

await main()
