// Which credentials a turn's agent gets (task.json's env and unsetEnv). A box's own environment can still hold a
// credential another project's turn must not use (an Upstash box made before credentials left Box.create had the
// global Claude login and GitHub token in its env), so the turn names the ones the runner removes before it starts
// `claude`, as well as the ones it sets. What a project's own env vars don't set comes from its identity
// (server/identity/identities.ts `base`), and for the Default identity from Settings › Credentials.
import { OPENCODE_CREDENTIAL_VARS, parseOpenCodeAuth } from "./opencode.js"
import { CLAUDE_CREDENTIAL_VARS, DEFAULT_IDENTITY_ID } from "../shared/identities.js"
import type { OwnClaudeLogin } from "./chatAgent.js"

export { CLAUDE_CREDENTIAL_VARS }

/** The env var a `codex` process logs in with an API key (docs/codex.md); a ChatGPT login is a file instead. */
export const CODEX_CREDENTIAL_VARS = ["CODEX_API_KEY"] as const

/** The env var a `cursor-agent` process logs in with headless (docs/cursor.md); without it, the computer's own `cursor-agent login`. */
export const CURSOR_CREDENTIAL_VARS = ["CURSOR_API_KEY"] as const

/** The GitHub token env vars that `gh` (GH_TOKEN first) and Box Yard's git credential helper (GITHUB_TOKEN) read. */
export const GITHUB_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const

/** The git author and committer env vars: they beat any user.name/user.email config, so a repo's can't change who commits. */
export const GIT_AUTHOR_VARS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const

export interface TurnEnv {
  env: Record<string, string>
  /** Vars the runner removes from its own environment before adding `env`. */
  unsetEnv: string[]
  /** Whose Claude login the turn uses: its project's (or task's) env, Settings › Credentials, or none (local login). */
  claudeFrom: "project" | "global" | null
}

/**
 * The env of a `claude` process Box Yard runs on this server (the Coordinator, a Captain): the server's own, without
 * what would mark it a Claude Code session's child or the key identities' secrets are encrypted with. It logs in with
 * `own` (a Captain's project login, projectClaudeLogin, the Coordinator's, coordinatorClaudeLogin, or a rotation
 * login), alone, or else with `global` (Settings › Credentials) over the server's.
 */
export function serverClaudeEnv(own: Record<string, string> | null, global: Record<string, string>, telemetry = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DISABLE_AUTOUPDATER: "1" }
  // When Box Yard itself was started from inside a Claude Code session, don't let `claude` think it is that session's child.
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING)/.test(k)) delete env[k]
  delete env.BOXYARD_SECRET_KEY
  if (own) for (const k of CLAUDE_CREDENTIAL_VARS) delete env[k]
  return Object.assign(env, claudeTelemetryEnv(telemetry), own ?? global)
}

/**
 * What turns Claude Code's usage telemetry off (Settings › Agents › Claude Code usage telemetry). The CLI flushes that
 * telemetry after its result line and exits only then, about 0.6 s later; a task's turn ends at that exit, and a
 * Captain's next turn waits for it. The second var keeps the feature flags the CLI last cached, so a run has the same
 * tools as one with telemetry on. Nothing when telemetry is on: the CLI's own default.
 */
export function claudeTelemetryEnv(on: boolean): Record<string, string> {
  return on ? {} : { DISABLE_TELEMETRY: "1", CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: "1" }
}

/** The strongest Claude credential in `env`, as a one-var env; empty values don't count. */
function strongestClaude(env: Record<string, string>): Record<string, string> {
  const k = CLAUDE_CREDENTIAL_VARS.find((v) => env[v])
  return k ? { [k]: env[k]! } : {}
}

/**
 * The Claude login of a project's Captain and its side threads, picked in a task turn's order (turnEnv): the strongest
 * Claude credential in the project's env vars, else its identity's own login (asked only then). Null: neither, so the
 * rotation's login (docs/logins.md), else Settings › Credentials'. Only that one var: the project's other env vars
 * never reach the Captain.
 */
export function projectClaudeLogin(project: { id: string; name: string }, projectEnv: Record<string, string>, identity: () => OwnClaudeLogin | null): OwnClaudeLogin | null {
  const env = strongestClaude(projectEnv)
  if (Object.keys(env).length) return { env, source: `${project.name}'s env vars`, scope: `project:${project.id}` }
  return identity()
}

/** Who a Claude login from the Coordinator's own env vars is, in limits and usage. */
export const COORDINATOR_ENV_LOGIN = { source: "the Coordinator's env vars", scope: "coordinator" } as const

/**
 * The Coordinator's own Claude login (it and its side threads): the strongest Claude credential in its env vars
 * (Settings › Coordinator › Env vars, server/coordinatorEnv.ts), picked as a task turn picks its project's. Null: none,
 * so the rotation's login (docs/logins.md), else Settings › Credentials'.
 */
export function coordinatorClaudeLogin(coordinatorEnv: Record<string, string>): OwnClaudeLogin | null {
  const env = strongestClaude(coordinatorEnv)
  return Object.keys(env).length ? { env, ...COORDINATOR_ENV_LOGIN } : null
}

/**
 * The Coordinator's other env vars, which reach its `claude` runs as they are: all but its Claude credentials (only
 * coordinatorClaudeLogin's one logs it in) and Box Yard's own BOXYARD_* vars.
 */
export function coordinatorExtraEnv(coordinatorEnv: Record<string, string>): Record<string, string> {
  const claude: readonly string[] = CLAUDE_CREDENTIAL_VARS
  return Object.fromEntries(Object.entries(coordinatorEnv).filter(([k, v]) => v && !claude.includes(k) && !k.toUpperCase().startsWith("BOXYARD_")))
}

/**
 * The env of a turn. `own` is its project's env with the task's on top; `base` is its identity's (for the Default
 * identity, Settings › Credentials, where env vars win). Exactly one Claude credential reaches the turn: the strongest
 * of its own when it has one, else the strongest of the base, so a project's login is never beaten by a stronger
 * global var. The GitHub token is its own GITHUB_TOKEN, else the base's, in both GITHUB_TOKEN and GH_TOKEN (gh reads
 * GH_TOKEN first). The identity's git author is the author and committer, unless the env names its own.
 */
export function turnEnv(
  own: Record<string, string>,
  base: { claude: Record<string, string>; githubToken: string; author?: { name: string; email: string } | null },
): TurnEnv {
  const ownClaude = strongestClaude(own)
  const claude = Object.keys(ownClaude).length ? ownClaude : strongestClaude(base.claude)
  const env: Record<string, string> = { ...own }
  for (const v of CLAUDE_CREDENTIAL_VARS) delete env[v]
  Object.assign(env, claude)
  const token = ownGithubToken(own) || base.githubToken
  if (token) env.GITHUB_TOKEN = env.GH_TOKEN = token
  if (base.author && !GIT_AUTHOR_VARS.some((v) => own[v])) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = base.author.name
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = base.author.email
  }
  const unsetEnv = [...CLAUDE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].filter((v) => !(v in env))
  return { env, unsetEnv, claudeFrom: Object.keys(ownClaude).length ? "project" : Object.keys(claude).length ? "global" : null }
}

/** What a Codex turn logs in with (codexTurnLogin). */
export interface CodexTurnLogin {
  /** CODEX_API_KEY, when that's the login. */
  env: Record<string, string>
  /** The ChatGPT login file to hand the turn (codex-auth.json), when that's the login. */
  auth: string | null
  /** "chatgpt" or "api_key", for task.json's codexLogin; null: none (this computer's own `codex login`, if any). */
  kind: "chatgpt" | "api_key" | null
  /** Whose: the project's (or task's) own CODEX_API_KEY, Settings › Credentials, or none. */
  from: "project" | "global" | null
}

/**
 * The login of a Codex turn: its project's (or task's) own CODEX_API_KEY, else Settings › Credentials' Codex login
 * (the ChatGPT login when it's set, else the API key), else none. Project identities have no Codex login of their own.
 */
export function codexTurnLogin(own: Record<string, string>, global: { kind: "chatgpt"; auth: string } | { kind: "api_key"; key: string } | null): CodexTurnLogin {
  if (own.CODEX_API_KEY) return { env: { CODEX_API_KEY: own.CODEX_API_KEY }, auth: null, kind: "api_key", from: "project" }
  if (global?.kind === "chatgpt") return { env: {}, auth: global.auth, kind: "chatgpt", from: "global" }
  if (global?.kind === "api_key") return { env: { CODEX_API_KEY: global.key }, auth: null, kind: "api_key", from: "global" }
  return { env: {}, auth: null, kind: null, from: null }
}

/** What a Cursor turn logs in with (cursorTurnLogin). */
export interface CursorTurnLogin {
  /** CURSOR_API_KEY, when there's a key; empty: this computer's own `cursor-agent login`, if any. */
  env: Record<string, string>
  /** Whose: the project's (or task's) own CURSOR_API_KEY, Settings › Credentials, or none. */
  from: "project" | "global" | null
}

/**
 * The login of a Cursor turn: its project's (or task's) own CURSOR_API_KEY, else Settings › Credentials' Cursor API
 * key, else none. Project identities have no Cursor login of their own.
 */
export function cursorTurnLogin(own: Record<string, string>, globalKey: string): CursorTurnLogin {
  if (own.CURSOR_API_KEY) return { env: { CURSOR_API_KEY: own.CURSOR_API_KEY }, from: "project" }
  if (globalKey) return { env: { CURSOR_API_KEY: globalKey }, from: "global" }
  return { env: {}, from: null }
}

/** A project's (or task's) own GitHub token env var, GITHUB_TOKEN first. */
export const ownGithubToken = (env: Record<string, string>) => env.GITHUB_TOKEN || env.GH_TOKEN || ""

/** The credential set of a Default-identity project with no Claude login or GitHub token of its own, and of every box from before the wall. */
export const GLOBAL_CREDENTIALS = "global"

/**
 * A credential set with the connectors that reach its project's agents on Upstash boxes (Connectors.boxKey): two
 * projects share a pool box only with the same identity and the same box connectors. No connectors: the set as it was,
 * so boxes made before connectors stay valid.
 */
export function withBoxConnectors(set: string, connectorKey: string): string {
  return connectorKey ? `${set}+con:${connectorKey}` : set
}

/** A credential set's identity part and its box connectors' key ("" for none). */
export function splitCredentialSet(set: string): { base: string; connectors: string } {
  const at = set.indexOf("+con:")
  return at < 0 ? { base: set, connectors: "" } : { base: set.slice(0, at), connectors: set.slice(at + "+con:".length) }
}

/**
 * On this computer, what keeps a non-Default identity's git off the owner's own config and gh login: git reads the
 * identity's own global config (in `home`) and no system config, and gh its own folder (docs/identities.md).
 */
export function identityHomeEnv(home: string): Record<string, string> {
  return { GIT_CONFIG_GLOBAL: `${home}/gitconfig`, GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: `${home}/gh` }
}

/**
 * The credential set a project's turns use, for the box wall: tasks of two sets never share a pool box, since an agent
 * can read everything on its box (other workspaces, their task.json, the repo mirrors). A project with its own Claude
 * login, Codex or Cursor API key or GitHub token in its env has a set of its own; the projects of another identity share that identity's; the
 * rest (the Default identity) use the global one. A task's own env doesn't count: its tasks share their project's boxes.
 */
export function credentialSet(projectId: string, projectEnv: Record<string, string>, identityId: string = DEFAULT_IDENTITY_ID): string {
  if ([...CLAUDE_CREDENTIAL_VARS, ...CODEX_CREDENTIAL_VARS, ...CURSOR_CREDENTIAL_VARS, ...OPENCODE_CREDENTIAL_VARS, ...GITHUB_TOKEN_VARS].some((v) => projectEnv[v])) return `project:${projectId}`
  return identityId === DEFAULT_IDENTITY_ID ? GLOBAL_CREDENTIALS : `identity:${identityId}`
}

/** Explicit project credentials replace global OpenCode logins; host logins are read only on owner runners. */
export function openCodeTurnLogin(own: Record<string, string>, globalAuth: string): { env: Record<string, string>; from: "project" | "global" | null } {
  if (OPENCODE_CREDENTIAL_VARS.some((k) => own[k])) {
    if (own.OPENCODE_AUTH_CONTENT) parseOpenCodeAuth(own.OPENCODE_AUTH_CONTENT)
    return { env: Object.fromEntries(OPENCODE_CREDENTIAL_VARS.filter((k) => own[k]).map((k) => [k, own[k]!])), from: "project" }
  }
  if (globalAuth) return { env: { OPENCODE_AUTH_CONTENT: parseOpenCodeAuth(globalAuth) }, from: "global" }
  return { env: {}, from: null }
}
