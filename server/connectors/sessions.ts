// A session's connectors (docs/connectors.md › Sessions): the MCP servers a Claude Code session gets besides Box Yard's
// own, as `--mcp-config` entries that name every secret as ${VAR}, and the values of those vars, which go only into the
// session's process env (the Coordinator's and a Captain's `claude`, or an agent's through task.json). A config file
// never holds a value, so orchestrator-mcp.json, a Captain's mcp.json and a task folder's mcp.json stay secret-free.
import { connectorVar, type Connector } from "../../shared/connectors.js"
import type { ConnectorCreds } from "./probe.js"

/** One `mcpServers` entry of a Claude Code MCP config. */
export type McpServerSpec = { type: "http" | "sse"; url: string; headers: Record<string, string> } | { type: "stdio"; command: string; args: string[] }

export interface SessionConnectors {
  /** By connector name (its tools are mcp__<name>__*), every secret as ${VAR}. Never Box Yard's own `boxyard`. */
  servers: Record<string, McpServerSpec>
  /** The values those ${VAR}s name: for the session's process env only, never a file Box Yard writes but task.json. */
  env: Record<string, string>
  /** `mcp__<name>` for each server, for a dontAsk session's --allowedTools (the Coordinator's and Captains'). */
  allowed: string[]
  /** Connectors whose scope reaches the session but that it doesn't get this time, and why (no secret in it). */
  skipped: { name: string; why: string }[]
}

export const NO_SESSION_CONNECTORS: SessionConnectors = Object.freeze({ servers: {}, env: {}, allowed: [], skipped: [] }) as SessionConnectors

/**
 * The env a connector command gets from the session it runs in: the same basics the MCP SDK passes (Test's
 * getDefaultEnvironment on macOS and Linux). Claude Code hands a stdio server its whole env otherwise (its login, the
 * GitHub token, other connectors' tokens), so a command runs under `env -i` with these and its own vars only.
 */
export const COMMAND_BASE_ENV = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"] as const

/** `env` clears the environment and runs the command with only the vars after it (macOS and Linux alike). */
export const ENV_BIN = "/usr/bin/env"

/** The ${VAR} reference Claude Code expands in a config's url, headers, command, args and env. */
const ref = (name: string) => `\${${name}}`

/** The env var a connector's secret env var reaches the session in. */
export const connectorEnvVar = (connector: string, envName: string) => connectorVar(connector, `ENV_${envName.toUpperCase()}`)

/**
 * A connector's `mcpServers` entry and the env values it names. `command` stands in for a command connector's own
 * (a server Box Yard ships, whose path depends on where it runs). Pure: no secret is read here, only `creds`.
 */
export function connectorServer(c: Connector, creds: ConnectorCreds, command?: { command: string; args: string[] }): { spec: McpServerSpec; env: Record<string, string> } {
  const env: Record<string, string> = {}
  if (c.kind === "stdio") {
    const run = command ?? { command: c.command!, args: c.args }
    const vars: string[] = COMMAND_BASE_ENV.map((k) => `${k}=\${${k}:-}`)
    for (const [k, v] of Object.entries(c.env)) vars.push(`${k}=${v}`)
    for (const [k, v] of Object.entries(creds.env)) {
      const name = connectorEnvVar(c.name, k)
      env[name] = v
      vars.push(`${k}=${ref(name)}`)
    }
    if (c.tokenEnv && creds.token) {
      const name = connectorVar(c.name)
      env[name] = creds.token
      vars.push(`${c.tokenEnv}=${ref(name)}`)
    }
    return { spec: { type: "stdio", command: ENV_BIN, args: ["-i", ...vars, run.command, ...run.args] }, env }
  }
  const headers: Record<string, string> = {}
  if (creds.token) {
    const name = connectorVar(c.name)
    env[name] = creds.token
    headers[c.header.name] = `${c.header.prefix}${ref(name)}`
  }
  return { spec: { type: c.kind, url: c.url!, headers }, env }
}

/** Put the connectors a session gets together, leaving out one whose env var names another's (only - and _ differ). */
export function sessionConnectors(entries: { c: Connector; creds: ConnectorCreds | null; why?: string; command?: { command: string; args: string[] } }[]): SessionConnectors {
  const out: SessionConnectors = { servers: {}, env: {}, allowed: [], skipped: [] }
  for (const e of entries) {
    if (!e.creds) {
      out.skipped.push({ name: e.c.name, why: e.why ?? "it can't sign in" })
      continue
    }
    const { spec, env } = connectorServer(e.c, e.creds, e.command)
    if (e.c.name === "boxyard" || e.c.name in out.servers || Object.keys(env).some((k) => k in out.env)) {
      out.skipped.push({ name: e.c.name, why: "its name or env vars clash with another connector's" })
      continue
    }
    out.servers[e.c.name] = spec
    Object.assign(out.env, env)
    out.allowed.push(`mcp__${e.c.name}`)
  }
  return out
}

/** A Claude Code MCP config: Box Yard's own server first and always its own, then the session's connectors. */
export function mcpConfigJson(boxyard: Record<string, unknown>, connectors: SessionConnectors = NO_SESSION_CONNECTORS): string {
  return JSON.stringify({ mcpServers: { ...connectors.servers, boxyard } })
}
