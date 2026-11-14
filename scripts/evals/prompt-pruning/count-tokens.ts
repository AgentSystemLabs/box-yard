// Count tokens the way the model sees them, with the real `claude` CLI (its own login, no API key needed). Each count
// is one tiny model call (about $0.01-0.10 on Opus), so it spends real money: it asks for --yes first.
//
//   npx tsx scripts/evals/prompt-pruning/count-tokens.ts text <file>... --yes
//       Tokens of each file as a system prompt (Claude Code's own prompt and tools left out), net of a 1-character
//       baseline.
//   npx tsx scripts/evals/prompt-pruning/count-tokens.ts turn --who coordinator|captain|task --dir <prompt-budget out> --yes
//       [--append <file>] [--first <file>] [--tools default|all|none] [--model claude-opus-5-5] [--effort low]
//       One whole first turn as Box Yard starts it: Claude Code's prompt, its built-in tools (--tools as Box Yard
//       passes them), the MCP tools from tools.<who>.json (static-mcp.mjs) and Box Yard's appended prompt. Prints
//       input, cache write and read tokens, $ and time. --tools all/none loads or defers every MCP tool. --cwd runs it
//       in a checkout, so a task's count includes the repo's CLAUDE.md / AGENTS.md as Claude Code loads them.
//
// It runs in a scratch folder with --no-session-persistence, so nothing lands in ~/.claude/projects.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cleanEnv } from "./cli-env.js"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args.splice(i, 1), true) : false
}
const yes = flag("--yes")
const model = opt("--model") ?? "claude-opus-5-5"
const effort = opt("--effort") ?? "low"
const cwd = opt("--cwd")
const mode = args.shift()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "count-tokens-"))
const here = path.dirname(new URL(import.meta.url).pathname)

interface Usage {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  costUsd: number
  ms: number
  apiMs: number
}

function run(cliArgs: string[], prompt = "Reply with just: ok"): Usage {
  if (!yes) {
    console.log(`would run: claude -p ${JSON.stringify(prompt)} ${cliArgs.map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a)).join(" ")}`)
    return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, costUsd: 0, ms: 0, apiMs: 0 }
  }
  const raw = execFileSync(process.env.CLAUDE_BIN ?? "claude", ["-p", prompt, "--output-format", "json", "--no-session-persistence", "--model", model, "--effort", effort, "--permission-mode", "dontAsk", ...cliArgs], {
    cwd: cwd ?? scratch,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: cleanEnv(),
  })
  const r = JSON.parse(raw)
  if (r.is_error) throw new Error(`claude: ${r.result}`)
  const u = r.usage ?? {}
  return {
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    costUsd: r.total_cost_usd ?? 0,
    ms: r.duration_ms ?? 0,
    apiMs: r.duration_api_ms ?? 0,
  }
}
const total = (u: Usage) => u.input + u.cacheWrite + u.cacheRead

if (mode === "text") {
  const bare = (file: string) => run(["--system-prompt-file", path.resolve(file), "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'])
  const one = path.join(scratch, "one.txt")
  fs.writeFileSync(one, ".")
  const base = total(bare(one))
  const rows: Record<string, number> = {}
  for (const file of args) {
    rows[file] = total(bare(file)) - base
    console.log(`${String(rows[file]).padStart(7)}  ${file}  (${fs.statSync(file).size} bytes)`)
  }
  if (yes) console.log(JSON.stringify({ baseline: base, tokens: rows }))
} else if (mode === "turn") {
  const who = opt("--who") ?? "captain"
  const dir = opt("--dir")
  if (!dir) throw new Error("--dir <prompt-budget out> is required")
  const append = opt("--append") ?? path.join(dir, who === "task" ? "worker.system.md" : `${who}.system.md`)
  const first = opt("--first")
  const toolsMode = opt("--tools") ?? "default"
  // As Box Yard passes them: server/chatAgent.ts CHAT_TOOLS / CAPTAIN_TOOLS; a task gets Claude Code's defaults.
  const builtins = who === "coordinator" ? ["--tools", "Read,WebSearch,WebFetch,ToolSearch"] : who === "captain" ? ["--tools", "Read,Grep,Glob,WebSearch,WebFetch,ToolSearch"] : []
  const mcp = { mcpServers: { boxyard: { type: "stdio", command: process.execPath, args: [path.join(here, "static-mcp.mjs"), path.resolve(dir, `tools.${who}.json`), ...(toolsMode === "all" ? ["--all-loaded"] : toolsMode === "none" ? ["--none-loaded"] : [])] } } }
  const prompt = first ? fs.readFileSync(first, "utf8") + "\n\n(Measurement only: reply with just ok and do nothing else.)" : "Reply with just: ok"
  const u = run([...builtins, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--append-system-prompt", fs.readFileSync(append, "utf8")], prompt)
  console.log(JSON.stringify({ who, append, first: first ?? null, toolsMode, model, effort, total: total(u), ...u }))
} else {
  console.error("usage: count-tokens.ts text <file>... | turn --who <coordinator|captain|task> --dir <dir> [--yes]")
  process.exit(2)
}
fs.rmSync(scratch, { recursive: true, force: true })
