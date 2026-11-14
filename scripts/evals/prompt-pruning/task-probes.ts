// Task-agent probes: do a project's notes still keep agents off known mistakes when they're pruned, scoped or gone?
// Each probe is a small real coding request that walks into one gotcha. It runs the way Box Yard runs a local task
// (Claude Code's own tools, --permission-mode bypassPermissions, Box Yard's worker system prompt appended, the
// notes in the first message, the repo's CLAUDE.md/AGENTS.md as memory) in a scratch copy of this checkout, then
// grades the diff it left.
//
//   npx tsx scripts/evals/prompt-pruning/task-probes.ts --root <scratch> --system worker.system.md --tools tools.task.json
//       --variant full=notes.md [--variant scoped=pruned.md+dir] [--variant none=] [--probes a,b] [--runs 2]
//       [--model claude-opus-5-5] [--effort high] [--concurrency 2] [--max-usd 40] [--spent N]
//   npx tsx scripts/evals/prompt-pruning/task-probes.ts --summary <root>/probes.jsonl
//
// A variant is name=<notes file>[+<dir>]: the notes go in the first message; files in <dir> named like
// web-CLAUDE.md are copied into the scratch repo as web/CLAUDE.md (Claude Code loads a nested CLAUDE.md only when
// the agent reads files under it). An empty notes file means no notes. Notes can hold private names: keep them and
// the scratch root out of the repo. Spends real money; sessions aren't saved, gh sees an empty config.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { firstTurnPrompt } from "../../../server/prompts.js"
import { cleanEnv } from "./cli-env.js"
import { readNotes } from "./notes-file.js"

interface Probe {
  id: string
  /** The note (or rule) it checks. */
  rule: string
  title: string
  brief: string
  /** Failures; [] is a pass. `added` is the diff's added lines. */
  grade(added: string[], reply: string): string[]
}

const added = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l))

export const PROBES: Probe[] = [
  {
    id: "drafts-persist",
    rule: "conversation data stays in memory (no web storage)",
    title: "Keep composer drafts across a reload",
    brief: "When I reload the page, my unsent message in the Coordinator chat's composer is gone. Make composer drafts survive a page reload.",
    grade: (a) => added(a, /localStorage|sessionStorage|indexedDB|caches\.open|createSyncStoragePersister|persistQueryClient/).map((l) => `stores drafts: ${l.trim().slice(0, 100)}`),
  },
  {
    id: "overscroll",
    rule: "overscroll-behavior stays auto on html/body/#root (swipe-back)",
    title: "Stop the sideways rubber-band bounce",
    brief: "On my Mac trackpad the whole app still rubber-bands sideways when I swipe horizontally on a page. Stop that horizontal bounce app-wide.",
    grade: (a) =>
      added(a, /overscroll-behavior(-x)?\s*:\s*(none|contain)|\boverscroll-(none|contain|x-none|x-contain)\b/).map((l) => `kills swipe-back: ${l.trim().slice(0, 100)}`),
  },
  {
    id: "wrap",
    rule: "unbreakable text uses wrap-anywhere, not break-words",
    title: "Wrap long unbroken strings in chat",
    brief:
      "Long unbroken strings in a chat message (a 200-character URL, or a list of commit hashes joined without spaces) overflow the message bubble sideways in the Captain chat. Make them wrap inside the bubble.",
    grade: (a) => added(a, /\bbreak-words\b|\bbreak-all\b|word-break\s*:|overflow-wrap\s*:\s*break-word/).map((l) => `old wrap utility: ${l.trim().slice(0, 100)}`),
  },
  {
    id: "owner-name",
    rule: "Box Yard-written text names the owner through withOwner",
    title: "Notice when a PR is closed without merging",
    brief:
      "When a task's PR is closed without merging, only the task's own log says so. Also send the usual task notice (the Captain and the Coordinator see those), telling Cody the PR was closed unmerged and that the task can be reopened or continued.",
    grade: (a) => {
      const code = a.filter((l) => !/^\+\s*(\/\/|\*|\/\*)/.test(l))
      const named = code.filter((l) => /["'`][^"'`]*\bCody\b/.test(l))
      return named.length && !a.some((l) => l.includes("withOwner(")) ? named.map((l) => `hard-codes Cody: ${l.trim().slice(0, 100)}`) : []
    },
  },
]

const SUFFIX =
  "\n\n(Evaluation run: make the code change in this checkout and stop there. Don't install packages, don't run builds, tests, servers or git commands, and don't commit or open a PR. If you decide no change should be made, say why. End with a two-sentence summary.)"

interface ProbeResult {
  variant: string
  probe: string
  run: number
  pass: boolean
  failures: string[]
  changed: string[]
  nestedLoaded: boolean
  reply: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  costUsd: number
  ms: number
  turns: number
  error?: string
  at: string
}

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
const readResults = (file: string): ProbeResult[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ProbeResult)
    : []

function summary(file: string) {
  const rows = readResults(file)
  const variants = [...new Set(rows.map((r) => r.variant))]
  console.log(`| probe | ${variants.join(" | ")} |`)
  console.log(`| --- | ${variants.map(() => "---").join(" | ")} |`)
  for (const p of PROBES) {
    const cells = variants.map((v) => {
      const rs = rows.filter((r) => r.variant === v && r.probe === p.id)
      return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : ""
    })
    console.log(`| ${p.id} (${p.rule}) | ${cells.join(" | ")} |`)
  }
  const avg = (v: string, f: (r: ProbeResult) => number) => {
    const rs = rows.filter((r) => r.variant === v)
    return rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : 0
  }
  console.log(`| tokens in / run | ${variants.map((v) => Math.round(avg(v, (r) => r.input + r.cacheWrite + r.cacheRead))).join(" | ")} |`)
  console.log(`| $ / run | ${variants.map((v) => avg(v, (r) => r.costUsd).toFixed(3)).join(" | ")} |`)
  console.log(`| minutes / run | ${variants.map((v) => (avg(v, (r) => r.ms) / 60000).toFixed(1)).join(" | ")} |`)
  console.log(`\nTotal spend: $${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(2)} over ${rows.length} runs`)
  for (const r of rows.filter((x) => !x.pass)) console.log(`- ${r.variant} ${r.probe} #${r.run}: ${r.error ?? r.failures.join("; ")}`)
}

async function runOne(o: { root: string; system: string; tools: string; model: string; effort: string }, v: { name: string; notes: string; dir?: string }, p: Probe, run: number): Promise<ProbeResult> {
  const dir = path.join(o.root, "runs", `${v.name}.${p.id}.${run}.${Date.now()}`)
  const work = path.join(dir, "work")
  fs.mkdirSync(work, { recursive: true })
  const repo = path.join(import.meta.dirname, "../../..")
  execFileSync("sh", ["-c", `git archive HEAD | tar -x -C '${work}'`], { cwd: repo })
  if (v.dir)
    for (const f of fs.readdirSync(v.dir)) {
      const m = /^(.+)-CLAUDE\.md$/.exec(f)
      if (m) fs.copyFileSync(path.join(v.dir, f), path.join(work, m[1]!, "CLAUDE.md"))
    }
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.com", ...a], { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  git("init", "-q")
  git("add", "-A")
  git("commit", "-qm", "base")

  const notes = v.notes ? readNotes(v.notes) : []
  const prompt = firstTurnPrompt({ task: { title: p.title, prompt: p.brief + SUFFIX }, notes, directory: [], extraInputs: [], ownerName: "Cody" } as never)
  fs.writeFileSync(path.join(dir, "prompt.md"), prompt)
  const mcp = path.join(dir, "mcp.json")
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { boxyard: { type: "stdio", command: process.execPath, args: [path.join(import.meta.dirname, "static-mcp.mjs"), o.tools, "--ok"] } } }))
  const ghConfig = path.join(o.root, "gh-empty")
  fs.mkdirSync(ghConfig, { recursive: true })
  const argv = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--mcp-config",
    mcp,
    "--append-system-prompt",
    fs.readFileSync(o.system, "utf8"),
    "--model",
    o.model,
    "--effort",
    o.effort,
  ]
  const started = Date.now()
  const out = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn("claude", argv, { cwd: work, env: { ...cleanEnv(), GH_CONFIG_DIR: ghConfig }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
  fs.writeFileSync(path.join(dir, "stream.jsonl"), out.stdout)
  let final: Record<string, any> | null = null
  for (const line of out.stdout.split("\n")) {
    try {
      const ev = JSON.parse(line)
      if (ev.type === "result") final = ev
    } catch {
      /* not JSON */
    }
  }
  git("add", "-A")
  const diff = git("diff", "--cached", "--", ".", ":(exclude)*/CLAUDE.md")
  fs.writeFileSync(path.join(dir, "diff.patch"), diff)
  const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"))
  const changed = git("diff", "--cached", "--name-only", "--", ".", ":(exclude)*/CLAUDE.md").split("\n").filter(Boolean)
  const reply = typeof final?.result === "string" ? final.result : ""
  const u = final?.usage ?? {}
  const error = !final ? `no result (exit ${out.code}): ${out.stderr.slice(0, 300)}` : final.is_error ? `error: ${String(final.result ?? final.subtype).slice(0, 300)}` : undefined
  const failures = error ? [error] : p.grade(addedLines, reply)
  return {
    variant: v.name,
    probe: p.id,
    run,
    pass: !error && failures.length === 0,
    failures,
    changed,
    nestedLoaded: out.stdout.includes("These load when you work in"),
    reply: reply.slice(0, 1500),
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    costUsd: final?.total_cost_usd ?? 0,
    ms: final?.duration_ms ?? Date.now() - started,
    turns: final?.num_turns ?? 0,
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
  }
}

async function main() {
  const s = opt("--summary")
  if (s) return summary(s)
  const root = path.resolve(opt("--root") ?? "")
  const system = opt("--system")
  const tools = opt("--tools")
  if (!system || !tools || root === path.resolve("")) throw new Error("--root, --system and --tools are required (see the header)")
  const o = { root, system: path.resolve(system), tools: path.resolve(tools), model: opt("--model") ?? "claude-opus-5-5", effort: opt("--effort") ?? "high" }
  const variants = opts("--variant").map((x) => {
    const [name, spec = ""] = x.split("=") as [string, string?]
    const [notes = "", dir] = spec.split("+")
    return { name, notes: notes ? path.resolve(notes) : "", dir: dir ? path.resolve(dir) : undefined }
  })
  const only = opt("--probes")?.split(",")
  const probes = PROBES.filter((p) => !only || only.includes(p.id))
  const runs = Number(opt("--runs") ?? 2)
  const concurrency = Number(opt("--concurrency") ?? 2)
  const maxUsd = Number(opt("--max-usd") ?? 40)
  const outFile = path.join(root, "probes.jsonl")
  let spent = Number(opt("--spent") ?? 0) + readResults(outFile).reduce((n, r) => n + r.costUsd, 0)
  // Probe-major, so each variant's runs of one probe sit close together in the prompt cache.
  const jobs = probes.flatMap((p) => Array.from({ length: runs }, (_, r) => variants.map((v) => ({ v, p, run: r + 1 }))).flat())
  console.error(`${jobs.length} runs; spent so far $${spent.toFixed(2)}, cap $${maxUsd}`)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      if (spent >= maxUsd) return console.error(`stopping: spend $${spent.toFixed(2)} passed the $${maxUsd} cap`)
      const j = jobs[next++]!
      const r = await runOne(o, j.v, j.p, j.run)
      spent += r.costUsd
      fs.appendFileSync(outFile, JSON.stringify(r) + "\n")
      console.error(
        `${r.pass ? "PASS" : "FAIL"} ${j.v.name} ${j.p.id} #${j.run} · ${r.turns} steps · ${(r.ms / 60000).toFixed(1)} min · $${r.costUsd.toFixed(3)} · total $${spent.toFixed(2)} · changed ${r.changed.join(",") || "nothing"}${r.nestedLoaded ? " · nested CLAUDE.md loaded" : ""}${r.pass ? "" : ` · ${r.failures.join("; ")}`}`,
      )
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
}

await main()
