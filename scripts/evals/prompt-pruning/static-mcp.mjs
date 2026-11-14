#!/usr/bin/env node
// A stdio MCP server that lists a saved tool list (scripts/evals/prompt-pruning/prompt-budget.ts writes tools.<who>.json) and
// refuses every call, so a token count or eval sees exactly the tools a Coordinator, Captain or task gets without a
// running Box Yard.
//
//   node scripts/evals/static-mcp.mjs tools.captain.json [--all-loaded] [--none-loaded]
//
// --all-loaded marks every tool always loaded (what a turn would cost without the CLI's tool search);
// --none-loaded defers every one.
import fs from "node:fs"
import readline from "node:readline"

const [file, ...flags] = process.argv.slice(2)
const KEY = "anthropic/alwaysLoad"
let tools = JSON.parse(fs.readFileSync(file, "utf8"))
if (flags.includes("--all-loaded")) tools = tools.map((t) => ({ ...t, _meta: { ...t._meta, [KEY]: true } }))
if (flags.includes("--none-loaded")) tools = tools.map(({ _meta, ...t }) => t)

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  if (req.id === undefined) return
  if (req.method === "initialize")
    return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "boxyard", version: "0" } } })
  if (req.method === "tools/list") return send({ jsonrpc: "2.0", id: req.id, result: { tools } })
  if (req.method === "tools/call") return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "Not available in this measurement." }], isError: true } })
  if (req.method === "ping") return send({ jsonrpc: "2.0", id: req.id, result: {} })
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } })
})
