// The Captain routing eval's LLM judge: for each run of a case with a `judge` rubric (fixtures.ts), asks a model whether
// the prompt the Captain wrote for its task (or the message it sent, with judgeOn "message") keeps each rubric item,
// then re-grades the run with the verdict. Run it once the runs are done (it rewrites the result files):
//
//   npx tsx scripts/evals/captain-routing/judge.ts scripts/evals/captain-routing/results/*.jsonl [--model claude-sonnet-5-5] [--force]
//
// Spends tokens on this computer's own `claude` login (a few tenths of a cent a verdict). --force judges again runs that
// already have a verdict.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CASES } from "./fixtures.js"
import { grade, judgedText, quotesVerbatim, type JudgeVerdict, type RunRecord } from "./grade.js"

export const JUDGE_SYSTEM = `You check a hand-off. An owner asked an orchestrator for some work; the orchestrator wrote instructions for a coding agent. You get the owner's request, the instructions as written, and a rubric. For each rubric item, decide whether the instructions satisfy it.

- Pass an item only when the instructions state it clearly enough that an agent following them would do it. Paraphrase is fine; a requirement that is missing, weakened or changed fails.
- A "No new requirement that contradicts..." or "Adds no requirement that contradicts or changes the owner's request" item fails only when the instructions add something that conflicts with or changes what the owner asked (a different scope, number, place, tool, or a step the owner ruled out). Extra helpful detail that doesn't conflict (run the tests, open a PR, read the code first) passes.
- Judge only the text given. Don't assume what the agent might infer.
- "why": one short sentence, quoting the instructions where it helps.`

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { item: { type: "string" }, pass: { type: "boolean" }, why: { type: "string" } },
        required: ["item", "pass", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
}

/** The judge's input for one run. */
export function judgeInput(request: string, judged: string, rubric: string[]): string {
  return [
    "## The owner's request",
    "",
    request,
    "",
    "## The instructions the orchestrator wrote",
    "",
    judged,
    "",
    "## Rubric (one verdict per item, in this order, with the item's text copied as `item`)",
    "",
    ...rubric.map((r, i) => `${i + 1}. ${r}`),
  ].join("\n")
}

/** One verdict: `claude -p` with no tools, settings or session, structured output. */
async function ask(model: string, input: string): Promise<{ items: JudgeVerdict["items"]; costUsd: number }> {
  const env = { ...process.env }
  // The computer's own login, not the session this may run inside of.
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC_)/.test(k)) delete env[k]
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"))
  const argv = ["-p", "--model", model, "--system-prompt", JUDGE_SYSTEM, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)]
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d) => (stdout += d))
      child.stderr.on("data", (d) => (stderr += d))
      child.on("error", reject)
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`))))
      child.stdin.end(input)
    })
    const res = JSON.parse(out) as { is_error?: boolean; result?: string; total_cost_usd?: number; structured_output?: { items: JudgeVerdict["items"] } }
    if (res.is_error || !res.structured_output) throw new Error(`judge failed: ${String(res.result).slice(0, 300)}`)
    return { items: res.structured_output.items, costUsd: res.total_cost_usd ?? 0 }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes("--force")
  const mi = args.indexOf("--model")
  const model = mi >= 0 ? args[mi + 1]! : "claude-sonnet-5-5"
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model")
  if (!files.length) throw new Error("Usage: judge.ts <results.jsonl>... [--model m] [--force]")
  let spent = 0
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
    const records = lines.map((l) => JSON.parse(l) as RunRecord & { grade?: unknown; verbatim?: boolean | null })
    const todo = records.filter((r) => {
      const c = CASES.find((x) => x.id === r.caseId)
      return c?.expect.judge?.length && (force || r.judge === undefined)
    })
    console.error(`[judge] ${path.basename(file)}: ${todo.length} run(s) to judge`)
    // A few at a time: each is one short API call.
    const queue = [...todo]
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          const c = CASES.find((x) => x.id === r.caseId)!
          const judged = judgedText(c, r)
          if (!judged || !r.message) {
            // Nothing to judge (no task, no message): the deterministic checks already fail it.
            r.judge = null
            continue
          }
          try {
            const v = await ask(model, judgeInput(r.message, judged, c.expect.judge!))
            spent += v.costUsd
            const items = c.expect.judge!.map((item, i) => v.items.find((x) => x.item.trim() === item.trim()) ?? v.items[i] ?? { item, pass: false, why: "no verdict for this item" })
            r.judge = { pass: items.every((i) => i.pass), items: items.map((i, k) => ({ ...i, item: c.expect.judge![k]! })), verbatim: quotesVerbatim(r.message, judged), model, costUsd: v.costUsd }
            console.error(`[judge] ${r.effort} rep ${r.rep} ${r.caseId}: ${r.judge.pass ? "pass" : `FAIL ${r.judge.items.filter((i) => !i.pass).map((i) => i.item).join("; ")}`}`)
          } catch (err) {
            console.error(`[judge] ${r.effort} rep ${r.rep} ${r.caseId}: ${(err as Error).message}`)
          }
        }
      }),
    )
    for (const r of records) {
      const c = CASES.find((x) => x.id === r.caseId)
      if (c) r.grade = grade(c, r)
      // Whether each created task's prompt quotes the owner's message word for word, on every run.
      if (c && r.message && r.created.length) r.verbatim = r.created.some((t) => quotesVerbatim(r.message!, t.prompt))
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    fs.renameSync(tmp, file)
  }
  console.error(`[judge] spent $${spent.toFixed(3)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
