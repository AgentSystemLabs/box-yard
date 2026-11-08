// Verified against OpenCode v1.19.5's run.ts, auth/index.ts and core/global.ts.
// This adapter deliberately targets v1: v2 has a different configuration contract.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isOpenCodeModel } from "../shared/agentCli.js"

export const OPENCODE_VERSION = "1.19.5"
export const OPENCODE_INSTALL = `npm install -g opencode-ai@${OPENCODE_VERSION}`
export const OPENCODE_LOGIN_HELP = "OpenCode needs provider API credentials: paste API entries from ~/.local/share/opencode/auth.json in Settings › Credentials › OpenCode API logins, or set OPENCODE_AUTH_CONTENT in the project's env. OAuth logins are not supported."
export const OPENCODE_CREDENTIAL_VARS = ["OPENCODE_AUTH_CONTENT", "OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const

/** API-only logins avoid handing out rotating OAuth refresh tokens without a refresh ownership protocol. */
export function parseOpenCodeAuth(text: string): string {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("OpenCode API logins must be a JSON object of provider names and {type: 'api', key: '…'} entries.") }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length) throw new Error("OpenCode API logins need at least one provider.")
  for (const [name, entry] of Object.entries(raw)) {
    const v = entry as Record<string, unknown> | null
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !v || v.type !== "api" || typeof v.key !== "string" || !v.key.trim()) throw new Error("OpenCode supports API logins here: each provider needs {type: 'api', key: '…'}. OAuth and well-known logins are not supported.")
  }
  return JSON.stringify(raw)
}

export const openCodeAuthFile = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "auth.json")
export function hasLocalOpenCodeAuth(): boolean {
  try { parseOpenCodeAuth(fs.readFileSync(openCodeAuthFile(), "utf8")); return true } catch { return false }
}

export function openCodeArgs(model: string | null, session: string | null): string[] {
  const args = ["run", "--format", "json", "--auto", "--pure"]
  if (model) {
    if (!isOpenCodeModel(model)) throw new Error("OpenCode models use provider/model or provider/model#variant. Run `opencode models` on the runner to list them.")
    const [id, variant] = model.split("#")
    args.push("--model", id!)
    if (variant) args.push("--variant", variant)
  }
  if (session) args.push("--session", session)
  return args
}
