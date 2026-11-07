// Agent logins (docs/logins.md): the Claude and Codex subscription logins new work is spread across, round robin.
// Each harness's Settings › Credentials login is the first in its rotation; Cody adds more in Settings › Credentials ›
// More logins. The browser, the API and the model only ever see what's here: a label, the value's last 4 characters
// and a fingerprint, never a value.

export const LOGIN_HARNESSES = ["claude", "codex"] as const
export type LoginHarness = (typeof LOGIN_HARNESSES)[number]

/**
 * What a login is: a Claude subscription's long-lived OAuth token (`claude setup-token`), a Codex ChatGPT login (its
 * ~/.codex/auth.json), or an API key (only Settings › Credentials' own login can be one).
 */
export type AgentLoginKind = "oauth_token" | "chatgpt" | "api_key"

/**
 * Whether the rotation may give it work: "ok"; "auth_failed" (a turn or a Test was refused: signed out, revoked,
 * expired) until a Test or a turn on it works; "limited" (its usage limit) until `limitedUntil`.
 */
export type AgentLoginState = "ok" | "auth_failed" | "limited"

/** GET /api/logins. */
export interface AgentLogin {
  /** `lgn_<random>` for an added login; `lgn_cred-<harness>-<fingerprint>` for Settings › Credentials' own. One id is one account: a new value is a new id. */
  id: string
  harness: LoginHarness
  label: string
  kind: AgentLoginKind
  /** The value's last 4 characters (a ChatGPT login: its account id's), to tell logins apart. */
  last4: string
  /** sha256, first 12 hex, of the value (a ChatGPT login: of its account id). */
  fingerprint: string
  /** "credentials": Settings › Credentials' login, edited there; "added": one of More logins. */
  source: "credentials" | "added"
  /** False when this server's secret key can't open it (the key changed): the rotation skips it until it's added again. */
  readable: boolean
  state: AgentLoginState
  /** When a "limited" login is expected back (its limit resets); null when it isn't limited. */
  limitedUntil: number | null
  /** Why it isn't "ok", in a few words (the CLI's own message, redacted). Never a secret. */
  stateReason: string | null
  lastUsedAt: number | null
  lastCheck: { at: number; ok: boolean; text: string } | null
  createdAt: number
  /** Gone: kept so turns that ran on it still name it. Removed logins aren't in GET /api/logins. */
  removedAt?: number | null
}

/** POST /api/logins: the value goes in once, and never comes out. */
export interface AgentLoginInput {
  harness: LoginHarness
  label: string
  /** A Claude OAuth token, or a Codex ~/.codex/auth.json. */
  value: string
}

/** Which login a turn used, as turn timings and usage show it. */
export interface TurnLogin {
  id: string
  label: string
  last4: string
}

/** "Personal Max (…a1b2)". */
export const loginName = (l: Pick<TurnLogin, "label" | "last4">) => (l.last4 ? `${l.label} (…${l.last4})` : l.label)

export const LOGIN_LABEL_MAX = 60

/** The id prefix of Settings › Credentials' own login in a rotation. */
export const CREDENTIALS_LOGIN_PREFIX = "lgn_cred-"
/** Settings › Credentials' own login (its id), rather than an added one. */
export const isCredentialsLogin = (id: string) => id.startsWith(CREDENTIALS_LOGIN_PREFIX)
