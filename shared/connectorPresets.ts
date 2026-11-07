// Connector presets (docs/connectors.md › Presets): a connector filled in for one service, which Settings › Connectors
// adds with its setup steps. A preset never ships an OAuth client id or secret: everyone who runs Box Yard makes their
// own client at the provider and pastes it in, so no install shares another's Google project or quota.
import { DEFAULT_CONNECTOR_SCOPE, type ConnectorInput } from "./connectors.js"

/** Read mail and labels, and write drafts. Not gmail.send or gmail.modify: nothing sends, deletes or relabels. */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] as const

/** The command a Gmail connector names. Box Yard runs its own server (runner/gmail-mcp.mjs) in its place. */
export const GMAIL_COMMAND = "box-yard-gmail"

/** The env var Box Yard's Gmail server reads its access token from: the only secret it gets. */
export const GMAIL_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN"

export const GOOGLE_ISSUER = "https://accounts.google.com"

export interface ConnectorPreset {
  id: "gmail"
  label: string
  /** One line for Settings' Add buttons. */
  blurb: string
  /** The connector it adds. The client id (and secret) are the user's, typed or dropped in before Save. */
  input: ConnectorInput & Required<Pick<ConnectorInput, "name" | "label" | "kind" | "auth">>
}

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
  {
    id: "gmail",
    label: "Gmail",
    blurb: "Search and read mail, list labels and write drafts. It never sends: drafts wait in Gmail for you.",
    input: {
      name: "gmail",
      label: "Gmail",
      preset: "gmail",
      kind: "stdio",
      command: GMAIL_COMMAND,
      args: [],
      auth: "oauth",
      tokenEnv: GMAIL_TOKEN_ENV,
      oauth: { clientKind: "desktop", issuer: GOOGLE_ISSUER, scopes: [...GMAIL_SCOPES], authParams: { access_type: "offline", prompt: "consent" } },
      // The Coordinator only: no shell, on this computer. Captains and agents are each a choice.
      scope: DEFAULT_CONNECTOR_SCOPE,
    },
  },
]

export const presetOf = (id: string | null | undefined): ConnectorPreset | null => CONNECTOR_PRESETS.find((p) => p.id === id) ?? null

/** Whether a connector runs Box Yard's own server for its preset (and not a command someone changed it to). */
export const runsBuiltin = (c: { preset: string | null; kind: string; command: string | null }): boolean => c.preset === "gmail" && c.kind === "stdio" && c.command === GMAIL_COMMAND

/**
 * The client id and secret in a Google client file (the client_secret_….json "Download JSON" gives): a Desktop
 * client's are under `installed`, a Web client's under `web`. null when it isn't one.
 */
export function parseGoogleClientFile(text: string): { clientId: string; clientSecret: string | null; kind: "desktop" | "web" } | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== "object") return null
  const o = data as Record<string, unknown>
  const kind = o.installed ? "desktop" : o.web ? "web" : null
  const c = (o.installed ?? o.web) as Record<string, unknown> | undefined
  if (!kind || !c || typeof c.client_id !== "string" || !c.client_id.trim()) return null
  return { clientId: c.client_id.trim(), clientSecret: typeof c.client_secret === "string" && c.client_secret.trim() ? c.client_secret.trim() : null, kind }
}
