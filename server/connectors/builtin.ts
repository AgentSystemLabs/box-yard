// MCP servers Box Yard ships for its presets (shared/connectorPresets.ts): a Gmail connector names the command
// `box-yard-gmail`, and Box Yard runs runner/gmail-mcp.mjs with its own Node in its place. They run on this computer
// only: the Coordinator, Captains, Test, and agents on the local runner.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runsBuiltin } from "../../shared/connectorPresets.js"
import type { Connector } from "../../shared/connectors.js"
import type { Runner } from "../../shared/runner.js"

const here = path.dirname(fileURLToPath(import.meta.url))
/** From server/connectors (tsx) or dist/server/server/connectors (the build), else the folder Box Yard runs in. */
const GMAIL_MCP_CANDIDATES = [path.resolve(here, "../../runner/gmail-mcp.mjs"), path.resolve(here, "../../../../runner/gmail-mcp.mjs"), path.resolve(process.cwd(), "runner/gmail-mcp.mjs")]

export const GMAIL_MCP_PATH = GMAIL_MCP_CANDIDATES.find((p) => fs.existsSync(p)) ?? GMAIL_MCP_CANDIDATES[0]!

/** The command a built-in connector runs instead of the one it names; null for any other connector. */
export function builtinCommand(c: Pick<Connector, "preset" | "kind" | "command">): { command: string; args: string[] } | null {
  return runsBuiltin(c) ? { command: process.execPath, args: [GMAIL_MCP_PATH] } : null
}

/** Why a built-in connector can't reach a session on `runner`, or null when it can. */
export const builtinWhyNot = (c: Pick<Connector, "preset" | "kind" | "command">, runner: Runner | null): string | null =>
  runsBuiltin(c) && runner && runner !== "local" ? "Box Yard's Gmail server runs on this computer only" : null
