// Settings › Connectors (docs/connectors.md): external MCP servers some sessions get, one card per connector. Every edit
// is a draft that the dialog's Save writes, Add, Sign out and Remove included. Sign in and Test act at once, on what's
// saved. Tokens, client secrets and secret env vars go in through write-only fields and never come back: the cards
// show fingerprints.
import { useState, type ReactNode } from "react"
import { Check, ClipboardPaste, KeyRound, LogIn, LogOut, Pencil, Play, Plus, Trash2, Undo2, X } from "lucide-react"
import { connectorApi, useConnectors, useIdentities, useProjects, useTestConnector } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { SettingsField, SearchHighlight, useSettingsSearching } from "../lib/settingsSearch"
import {
  CONNECTOR_SESSIONS,
  CONNECTOR_SESSION_LABEL,
  DEFAULT_CONNECTOR_SCOPE,
  type Connector,
  type ConnectorAuth,
  type ConnectorInput,
  type ConnectorKind,
  type ConnectorSession,
  type ConnectorSignIn,
  type ConnectorStatus,
  type OAuthClientKind,
} from "../../../shared/connectors"
import { RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"
import { CONNECTOR_PRESETS, runsBuiltin, type ConnectorPreset } from "../../../shared/connectorPresets"
import type { Project } from "../../../shared/types"
import { Panel } from "./SettingsBlocks"
import { Button, NewTabLink, Select, TimeAgo, cx, inputClass } from "./ui"
import { Loading } from "./Loading"
import { GmailGuide, GoogleClientFile } from "./GmailSetup"

// ------------------------------------------------------------------ drafts

/** A connector's fields as the form edits them (lists as lines), so a draft compares cleanly with what's saved. */
export interface ConnectorForm {
  /** The preset it was made from (shared/connectorPresets.ts): not edited, it picks the setup Settings shows. */
  preset: string | null
  label: string
  name: string
  kind: ConnectorKind
  url: string
  command: string
  /** One per line. */
  args: string
  /** NAME=value per line: the env vars that aren't secret. */
  env: string
  auth: ConnectorAuth
  headerName: string
  headerPrefix: string
  tokenEnv: string
  clientKind: OAuthClientKind
  clientId: string
  issuer: string
  /** Space separated. */
  scopes: string
  /** name=value per line. */
  authParams: string
  sessions: ConnectorSession[]
  projects: string[] | null
  runners: Runner[]
  enabled: boolean
}

/** What a card's draft changes. A key is there only while it differs from what's saved. */
export interface ConnectorEdit {
  form?: ConnectorForm
  token?: string
  removeToken?: true
  clientSecret?: string
  removeClientSecret?: true
  /** A secret env var to add or replace. */
  envSecret?: { name: string; value: string }
  removeEnv?: string[]
  /** Forget its OAuth sign-in on Save. */
  signOut?: true
  /** Remove it on Save. */
  remove?: true
}

const NO_EDIT: ConnectorEdit = {}
const NO_NEW: NewConnector[] = []

interface NewConnector {
  key: string
  edit: ConnectorEdit & { form: ConnectorForm }
}

const pairText = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")

export function formOf(c: Connector | null): ConnectorForm {
  const own = c?.oauth && c.oauth.clientKind !== "dynamic" ? c.oauth : null
  return {
    preset: c?.preset ?? null,
    label: c?.label ?? "",
    name: c?.name ?? "",
    kind: c?.kind ?? "http",
    url: c?.url ?? "",
    command: c?.command ?? "",
    args: (c?.args ?? []).join("\n"),
    env: pairText(c?.env ?? {}),
    auth: c?.auth ?? "oauth",
    headerName: c?.header.name ?? "Authorization",
    headerPrefix: c?.header.prefix ?? "Bearer ",
    tokenEnv: c?.tokenEnv ?? "",
    clientKind: c?.oauth?.clientKind ?? "dynamic",
    clientId: own?.clientId ?? "",
    issuer: own?.issuer ?? "",
    scopes: (c?.oauth?.scopes ?? []).join(" "),
    authParams: pairText(c?.oauth?.authParams ?? {}),
    sessions: c?.scope.sessions ?? DEFAULT_CONNECTOR_SCOPE.sessions,
    projects: c?.scope.projects ?? null,
    runners: c?.scope.runners ?? DEFAULT_CONNECTOR_SCOPE.runners,
    enabled: c?.enabled ?? true,
  }
}

/** A new connector's form from a preset: the user adds their own OAuth client before Save. */
export function presetForm(p: ConnectorPreset, taken: string[]): ConnectorForm {
  const i = p.input
  let name = i.name
  for (let n = 2; taken.includes(name); n++) name = `${i.name}-${n}`
  return {
    ...formOf(null),
    preset: p.id,
    label: name === i.name ? i.label : `${i.label} ${name.slice(i.name.length + 1)}`,
    name,
    kind: i.kind,
    command: i.command ?? "",
    args: (i.args ?? []).join("\n"),
    auth: i.auth,
    tokenEnv: i.tokenEnv ?? "",
    clientKind: i.oauth?.clientKind ?? "dynamic",
    issuer: i.oauth?.issuer ?? "",
    scopes: (i.oauth?.scopes ?? []).join(" "),
    authParams: pairText(i.oauth?.authParams ?? {}),
    sessions: i.scope?.sessions ?? DEFAULT_CONNECTOR_SCOPE.sessions,
    projects: i.scope?.projects ?? null,
    runners: i.scope?.runners ?? DEFAULT_CONNECTOR_SCOPE.runners,
  }
}

/** Whether a form runs a server Box Yard ships, whose command, sign-in server and scopes the preset fixes. */
const builtinForm = (f: ConnectorForm) => runsBuiltin({ preset: f.preset, kind: f.kind, command: f.command.trim() })

const lines = (t: string) =>
  t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

function pairs(t: string, what: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of lines(t)) {
    const at = l.indexOf("=")
    if (at < 1) throw new Error(`${what}: each line is NAME=value ("${l.slice(0, 40)}" isn't).`)
    out[l.slice(0, at).trim()] = l.slice(at + 1)
  }
  return out
}

/** The POST body for a form: only the fields its kind and sign-in use. */
export function inputOf(f: ConnectorForm): ConnectorInput {
  const remote = f.kind !== "stdio"
  const name = f.name.trim().toLowerCase()
  const input: ConnectorInput = {
    ...(f.preset ? { preset: f.preset } : {}),
    name,
    label: f.label.trim() || name,
    kind: f.kind,
    auth: f.auth,
    scope: { sessions: f.sessions, projects: f.projects, runners: f.runners },
    enabled: f.enabled,
  }
  if (remote) {
    input.url = f.url.trim()
    if (f.auth === "token" || f.auth === "oauth") input.header = { name: f.headerName.trim() || "Authorization", prefix: f.headerPrefix }
  } else {
    input.command = f.command.trim()
    input.args = lines(f.args)
    input.env = pairs(f.env, "Env vars")
    input.tokenEnv = f.auth === "token" || f.auth === "oauth" ? f.tokenEnv.trim() || null : null
  }
  if (f.auth === "oauth") {
    input.oauth = {
      clientKind: f.clientKind,
      ...(f.clientKind === "dynamic" ? {} : { clientId: f.clientId.trim() || null, issuer: f.issuer.trim() || null }),
      scopes: f.scopes.split(/[\s,]+/).filter(Boolean),
      authParams: pairs(f.authParams, "Sign-in parameters"),
    }
  }
  return input
}

/** The PATCH body: the fields that differ from what's saved. */
export function patchOf(saved: ConnectorForm, draft: ConnectorForm): ConnectorInput {
  const a = inputOf(saved) as Record<string, unknown>
  const b = inputOf(draft) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k] ?? (k === "oauth" ? null : undefined)
  return out as ConnectorInput
}

/** How many form fields differ, for "N unsaved changes". */
const formChanges = (saved: ConnectorForm, draft: ConnectorForm) => (Object.keys(draft) as (keyof ConnectorForm)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k])).length

export const editCount = (e: ConnectorEdit, c: Connector | null) =>
  Object.entries(e).reduce((n, [k, v]) => (v === undefined ? n : n + (k === "form" ? (c ? formChanges(formOf(c), v as ConnectorForm) : 1) : k === "removeEnv" ? (v as string[]).length : 1)), 0)

/** Set one part of a draft; an empty value drops it, and a form back at the saved one drops out (the card is clean). */
function put<K extends keyof ConnectorEdit>(edit: ConnectorEdit, k: K, v: ConnectorEdit[K], c: Connector | null): ConnectorEdit {
  const { [k]: _old, ...rest } = edit
  if (v === undefined) return rest
  if (k === "form" && c && JSON.stringify(v) === JSON.stringify(formOf(c))) return rest
  return { ...rest, [k]: v }
}

const named = (name: string, err: unknown) => new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`)

/** Write a draft's secrets (fields first, so an edit that moves the connector doesn't then drop them). */
async function writeSecrets(id: string, e: ConnectorEdit, done: (k: keyof ConnectorEdit) => void): Promise<boolean> {
  let saved = false
  if (e.signOut) {
    await connectorApi.signOut(id)
    done("signOut")
  }
  if (e.removeToken) {
    await connectorApi.removeToken(id)
    done("removeToken")
  }
  if (e.token?.trim()) {
    await connectorApi.saveToken(id, e.token.trim())
    done("token")
    saved = true
  }
  if (e.removeClientSecret) {
    await connectorApi.removeClientSecret(id)
    done("removeClientSecret")
  }
  if (e.clientSecret?.trim()) {
    await connectorApi.saveClientSecret(id, e.clientSecret.trim())
    done("clientSecret")
  }
  for (const n of e.removeEnv ?? []) await connectorApi.removeEnv(id, n)
  if (e.removeEnv) done("removeEnv")
  if (e.envSecret && (e.envSecret.name.trim() || e.envSecret.value.trim())) {
    const name = e.envSecret.name.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("A secret env var's name is letters, digits and _ (not starting with a digit).")
    if (!e.envSecret.value.trim()) throw new Error(`Give ${name} a value.`)
    await connectorApi.saveEnv(id, name, e.envSecret.value.trim())
    done("envSecret")
    saved = true
  }
  return saved
}

/** Save one card's draft (the dialog's Save). A new token or secret env var is tested right after. */
async function persistEdit(c: Connector, e: ConnectorEdit, setEdit: (fn: (prev: ConnectorEdit) => ConnectorEdit) => void): Promise<void> {
  const done = (k: keyof ConnectorEdit) => setEdit((prev) => put(prev, k, undefined, null))
  try {
    if (e.remove) {
      await connectorApi.remove(c.id)
      return
    }
    if (e.form) {
      const patch = patchOf(formOf(c), e.form)
      if (Object.keys(patch).length) await connectorApi.update(c.id, patch)
      done("form")
    }
    if ((await writeSecrets(c.id, e, done)) && c.enabled) void connectorApi.test(c.id).catch(() => {})
  } catch (err) {
    throw named(c.label || c.name, err)
  }
}

// ------------------------------------------------------------------ the panel

/** Projects whose identity shows the Coordinator status only: a connector the Coordinator uses never reaches them. */
function useStatusOnly(): Set<string> {
  const identities = useIdentities()
  const projects = useProjects()
  const sealed = new Set((identities.data ?? []).filter((i) => i.coordinatorSees === "status").map((i) => i.id))
  return new Set((projects.data ?? []).filter((p) => p.identityId && sealed.has(p.identityId)).map((p) => p.id))
}

export function ConnectorsPanel({ fid }: { fid: (k: string) => string }) {
  const connectors = useConnectors()
  const projects = useProjects()
  const statusOnly = useStatusOnly()
  const [news, setNews] = useDraft<NewConnector[]>(
    "connectors-new",
    "connectors",
    NO_NEW,
    async (list) => {
      for (const n of list) {
        const label = n.edit.form.label.trim() || n.edit.form.name.trim() || "New connector"
        let made: Connector
        try {
          made = await connectorApi.create(inputOf(n.edit.form))
        } catch (err) {
          throw named(label, err)
        }
        try {
          const { form: _f, ...secrets } = n.edit
          if (await writeSecrets(made.id, secrets, () => {})) void connectorApi.test(made.id).catch(() => {})
        } catch (err) {
          // Nothing half-made: the connector goes again, and the draft stays for another try.
          await connectorApi.remove(made.id).catch(() => {})
          throw named(label, err)
        }
        setNews((prev) => prev.filter((x) => x.key !== n.key))
      }
    },
    (list) => list.length,
  )
  const list = connectors.data ?? []
  const add = (form: ConnectorForm = formOf(null)) => setNews((prev) => [...prev, { key: crypto.randomUUID(), edit: { form } }])

  return (
    <Panel section="connectors">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => add()} data-testid="connector-add">
          <Plus className="h-3.5 w-3.5" /> Add connector
        </Button>
        {CONNECTOR_PRESETS.map((p) => (
          <Button
            key={p.id}
            type="button"
            size="sm"
            variant="ghost"
            title={p.blurb}
            onClick={() => add(presetForm(p, [...list.map((c) => c.name), ...news.map((n) => n.edit.form.name)]))}
            data-testid={`connector-add-${p.id}`}
          >
            <Plus className="h-3.5 w-3.5" /> Add {p.label}
          </Button>
        ))}
      </div>
      <div className="mt-5 space-y-3">
        {news.map((n) => (
          <NewConnectorCard
            key={n.key}
            fid={(k) => fid(`new-${n.key}-${k}`)}
            edit={n.edit}
            projects={projects.data ?? []}
            statusOnly={statusOnly}
            onEdit={(fn) => setNews((prev) => prev.map((x) => (x.key === n.key ? { ...x, edit: fn(x.edit) as NewConnector["edit"] } : x)))}
            onDrop={() => setNews((prev) => prev.filter((x) => x.key !== n.key))}
          />
        ))}
        {!connectors.data ? (
          <Loading count={2} label="Loading connectors" />
        ) : list.length || news.length ? (
          list.map((c) => <ConnectorCard key={c.id} connector={c} projects={projects.data ?? []} statusOnly={statusOnly} fid={(k) => fid(`${c.id}-${k}`)} />)
        ) : (
          <p className="text-sm text-zinc-500" data-connectors-empty>
            No connectors yet. Add one to give the Coordinator (and, if you choose, Captains and agents) another MCP server's tools.
          </p>
        )}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------------ one connector

const STATUS_LOOK: Record<ConnectorStatus, { label: string; className: string }> = {
  connected: { label: "Connected", className: "bg-emerald-500/15 text-emerald-300" },
  needs_auth: { label: "Needs sign-in", className: "bg-amber-500/15 text-amber-300" },
  error: { label: "Error", className: "bg-red-500/15 text-red-300" },
  untested: { label: "Not tested", className: "bg-zinc-800 text-zinc-400" },
}

function StatusChip({ c }: { c: Connector }) {
  if (!c.enabled) return <span className="rounded bg-zinc-800 px-1.5 py-px text-[11px] text-zinc-400">Off</span>
  const look = STATUS_LOOK[c.status]
  const label = c.status === "needs_auth" && c.auth === "token" ? "Needs a token" : look.label
  return (
    <span className={cx("rounded px-1.5 py-px text-[11px]", look.className)} data-connector-status={c.status}>
      {label}
    </span>
  )
}

/** Why Sign in or Test waits: they work on what's saved. */
const unsavedWhy = "Save your changes first: it works with what's saved."

function ConnectorCard({ connector: c, projects, statusOnly, fid }: { connector: Connector; projects: Project[]; statusOnly: Set<string>; fid: (k: string) => string }) {
  const [edit, setEdit, dirty] = useDraft<ConnectorEdit>(`connector-${c.id}`, "connectors", NO_EDIT, (e): Promise<void> => persistEdit(c, e, setEdit), (e) => editCount(e, c))
  const [open, setOpen] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const searching = useSettingsSearching()
  const test = useTestConnector()
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id

  return (
    <article className={cx("@container rounded-xl border bg-zinc-900/40 p-4", edit.remove ? "border-red-500/40" : dirty ? "border-amber-500/40" : "border-zinc-800")} data-connector-card={c.name}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-zinc-100">{c.label || c.name}</h4>
        <code className="font-mono text-xs text-zinc-500">mcp__{c.name}</code>
        <StatusChip c={c} />
        {dirty && !edit.remove && <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">unsaved</span>}
        <span className="ml-auto flex flex-wrap gap-1">
          {c.auth === "oauth" && !edit.remove && (
            <Button type="button" size="sm" variant={signingIn ? "subtle" : "ghost"} disabled={dirty} title={dirty ? unsavedWhy : `Sign in${c.oauth?.signInHost ? ` at ${c.oauth.signInHost}` : ""}`} onClick={() => setSigningIn(!signingIn)} aria-expanded={signingIn} data-testid="connector-sign-in">
              <LogIn className="h-3.5 w-3.5" /> {c.oauth?.signedInAt ? "Sign in again" : "Sign in"}
            </Button>
          )}
          {!edit.remove && (
            <Button type="button" size="sm" variant="ghost" loading={test.isPending} disabled={dirty} title={dirty ? unsavedWhy : "Connect the way a session would and list its tools"} onClick={() => test.mutate(c.id)} data-testid="connector-test">
              <Play className="h-3.5 w-3.5" /> Test
            </Button>
          )}
          {!edit.remove && (
            <Button type="button" size="sm" variant={open ? "subtle" : "ghost"} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="connector-edit">
              <Pencil className="h-3.5 w-3.5" /> {open ? "Done" : "Edit"}
            </Button>
          )}
        </span>
      </header>

      {c.statusDetail && c.status !== "connected" && !edit.remove && <p className="mt-2 text-xs text-amber-200/90 wrap-anywhere">{c.statusDetail}</p>}
      {signingIn && !dirty && !edit.remove && <SignInBox c={c} onDone={() => setSigningIn(false)} />}

      {edit.remove ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" data-connector-removing>
          <span className="flex-1">Removed when you save, with its sign-in and secrets. No session gets it after that.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEdit((e) => put(e, "remove", undefined, c))}>
            <Undo2 className="h-3.5 w-3.5" /> Keep it
          </Button>
        </div>
      ) : open || searching ? (
        <ConnectorFormFields fid={fid} connector={c} edit={edit} onEdit={setEdit} projects={projects} statusOnly={statusOnly} />
      ) : (
        <Summary c={c} projectName={projectName} />
      )}
      {test.error && <p className="mt-2 text-xs text-red-300">{test.error.message}</p>}
    </article>
  )
}

function Summary({ c, projectName }: { c: Connector; projectName: (id: string) => string }) {
  const secrets = c.secrets.filter((s) => s.name !== "access_token" && s.name !== "refresh_token" && s.name !== "dcr_client_secret")
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-3 gap-y-1 text-xs @min-[26rem]:grid-cols-[7rem_minmax(0,1fr)]">
      <Fact label={c.kind === "stdio" ? "Command" : "Server"}>
        {runsBuiltin(c) ? (
          <>Box Yard's own {c.preset === "gmail" ? "Gmail server" : "server"}, on this computer</>
        ) : c.kind === "stdio" ? (
          <code className="font-mono text-zinc-300">{[c.command, ...c.args].join(" ")}</code>
        ) : (
          <>
            <code className="font-mono text-zinc-300">{c.url}</code>
            {c.kind === "sse" && <Muted> · SSE</Muted>}
          </>
        )}
      </Fact>
      <Fact label="Sign-in">
        <AuthLine c={c} />
      </Fact>
      {secrets.length > 0 && (
        <Fact label="Secrets">
          {secrets.map((s) => (
            <span key={s.name} className="block">
              {secretLabel(s.name)} · <code className="font-mono text-zinc-500">{s.fingerprint}</code>
              {!s.readable && <span className="text-red-300"> · can't be read: save it again</span>}
            </span>
          ))}
        </Fact>
      )}
      <Fact label="Who gets it">
        <ScopeLine c={c} projectName={projectName} />
      </Fact>
      <Fact label="Last test">
        <TestLine c={c} />
      </Fact>
    </dl>
  )
}

const secretLabel = (name: string) => (name === "token" ? "Token" : name === "client_secret" ? "Client secret" : name.startsWith("env:") ? name.slice(4) : name)

function AuthLine({ c }: { c: Connector }) {
  if (c.auth === "none") return <Muted>none</Muted>
  if (c.auth === "env") return <>secret env vars</>
  if (c.auth === "token") return <>{c.secrets.some((s) => s.name === "token") ? "a token" : <span className="text-amber-300">no token yet</span>}</>
  const o = c.oauth
  if (!o?.signedInAt) return <span className="text-amber-300">OAuth{o?.signInHost ? ` at ${o.signInHost}` : ""}: not signed in yet</span>
  return (
    <>
      OAuth{o.signInHost ? ` at ${o.signInHost}` : ""} · signed in <TimeAgo ts={o.signedInAt} />
      {o.refreshable ? " · renews by itself" : <span className="text-amber-300"> · no refresh token: sign in again when it runs out</span>}
      {o.grantedScopes?.length ? <span className="block text-zinc-500 wrap-anywhere">{o.grantedScopes.join(" ")}</span> : null}
    </>
  )
}

function ScopeLine({ c, projectName }: { c: Connector; projectName: (id: string) => string }) {
  const s = c.scope
  if (!c.enabled) return <Muted>no one: it's off</Muted>
  if (!s.sessions.length) return <Muted>no one</Muted>
  const projectWide = s.sessions.some((x) => x !== "coordinator")
  return (
    <>
      {s.sessions.map((x) => CONNECTOR_SESSION_LABEL[x]).join(", ")}
      {projectWide && <> · {s.projects ? s.projects.map(projectName).join(", ") || "no project" : "every project"}</>}
      {s.sessions.includes("agent") && <> · agents on {s.runners.map((r) => RUNNER_LABEL[r]).join(", ")}</>}
      {c.sealedSkipped.length > 0 && <span className="block text-amber-300">Not {c.sealedSkipped.map(projectName).join(", ")}: {c.sealedSkipped.length === 1 ? "it shows" : "they show"} the Coordinator status only.</span>}
    </>
  )
}

function TestLine({ c }: { c: Connector }) {
  const t = c.lastTest
  if (!t) return <Muted>not yet</Muted>
  if (!t.ok)
    return (
      <span className="text-red-300 wrap-anywhere">
        failed <TimeAgo ts={t.at} />: {t.error}
      </span>
    )
  return (
    <>
      <span className="text-emerald-300">
        <Check className="inline h-3 w-3" /> worked
      </span>{" "}
      <TimeAgo ts={t.at} /> · {t.tools.length} tool{t.tools.length === 1 ? "" : "s"}
      {t.tools.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {t.tools.map((tool) => (
            <code key={tool.name} title={tool.description} className="rounded bg-zinc-800 px-1.5 py-px font-mono text-[11px] text-zinc-300">
              {tool.name}
            </code>
          ))}
        </span>
      )}
    </>
  )
}

// ------------------------------------------------------------------ signing in

/**
 * Sign in: Box Yard starts it, Cody opens the provider's page, and it comes back by itself, or (when the address it
 * returns to won't load on this device) Cody pastes the address the page ended on.
 */
function SignInBox({ c, onDone }: { c: Connector; onDone: () => void }) {
  const [start, setStart] = useState<(ConnectorSignIn & { at: number }) | null>(null)
  const [pasted, setPasted] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signedIn = start && c.oauth?.signedInAt && c.oauth.signedInAt >= start.at
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300" data-connector-sign-in-box>
      {signedIn ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-emerald-300">
            <Check className="inline h-3.5 w-3.5" /> Signed in. It's being tested now.
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Close
          </Button>
        </div>
      ) : !start ? (
        <>
          <p>
            Box Yard asks {c.oauth?.signInHost ?? "the provider"} for a sign-in page. You sign in there, and only {c.label || c.name}'s access token ever leaves this server, for the sessions that get it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={busy} onClick={() => run(async () => setStart({ ...(await connectorApi.startSignIn(c.id, window.location.origin)), at: Date.now() }))} data-testid="connector-sign-in-start">
              <LogIn className="h-3.5 w-3.5" /> Get the sign-in page
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            <NewTabLink href={start.authorizeUrl} mark="end" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-action px-3 font-medium text-on-action hover:bg-action-hover sm:min-h-8" data-testid="connector-sign-in-open">
              Open the sign-in page at {start.signInHost}
            </NewTabLink>
          </p>
          {start.mode === "redirect" ? (
            <p className="text-zinc-400">It comes back to Box Yard by itself once you've allowed it. This card updates when it does.</p>
          ) : (
            <>
              <p className="text-zinc-400">{start.note ?? "When the page lands on an address that doesn't load, copy that address and paste it here."}</p>
              <div className="flex flex-col gap-2 @min-[30rem]:flex-row">
                <input
                  className={cx(inputClass, "font-mono")}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={`${start.redirectUri}?code=…`}
                  aria-label="The address the sign-in page ended on"
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="connector-sign-in-paste"
                />
                <Button type="button" size="sm" loading={busy} disabled={!pasted.trim()} onClick={() => run(async () => void (await connectorApi.completeSignIn(pasted.trim())))} data-testid="connector-sign-in-finish">
                  <ClipboardPaste className="h-3.5 w-3.5" /> Finish signing in
                </Button>
              </div>
            </>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </>
      )}
      {error && <p className="text-red-300 wrap-anywhere">{error}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ new connector

function NewConnectorCard({
  fid,
  edit,
  projects,
  statusOnly,
  onEdit,
  onDrop,
}: {
  fid: (k: string) => string
  edit: ConnectorEdit & { form: ConnectorForm }
  projects: Project[]
  statusOnly: Set<string>
  onEdit: (fn: (prev: ConnectorEdit) => ConnectorEdit) => void
  onDrop: () => void
}) {
  return (
    <article className="@container rounded-xl border border-amber-500/40 bg-zinc-900/40 p-4" data-connector-card="new">
      <header className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-zinc-100">{edit.form.label.trim() || edit.form.name.trim() || "New connector"}</h4>
        <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">added when you save</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onDrop} aria-label="Don't add it">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <ConnectorFormFields fid={fid} connector={null} edit={edit} onEdit={onEdit} projects={projects} statusOnly={statusOnly} />
      {edit.form.auth === "oauth" && <p className="mt-3 text-xs text-zinc-500">Save first, then Sign in.</p>}
    </article>
  )
}

// ------------------------------------------------------------------ the form (a connector's draft)

/** A name from a label: "My Notion" → my-notion. */
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32)

function ConnectorFormFields({
  fid,
  connector: c,
  edit,
  onEdit,
  projects,
  statusOnly,
}: {
  fid: (k: string) => string
  connector: Connector | null
  edit: ConnectorEdit
  onEdit: (fn: (prev: ConnectorEdit) => ConnectorEdit) => void
  projects: Project[]
  statusOnly: Set<string>
}) {
  const f = edit.form ?? formOf(c)
  const set = <K extends keyof ConnectorEdit>(k: K, v: ConnectorEdit[K]) => onEdit((prev) => put(prev, k, v, c))
  const setForm = (patch: Partial<ConnectorForm>) =>
    onEdit((prev) => {
      const base = prev.form ?? formOf(c)
      const next = { ...base, ...patch }
      // A new connector's name follows its label until it's typed.
      if (!c && patch.label !== undefined && (base.name === "" || base.name === slug(base.label))) next.name = slug(patch.label)
      return put(prev, "form", next, c)
    })
  const remote = f.kind !== "stdio"
  const builtin = builtinForm(f)
  const auths: ConnectorAuth[] = remote ? ["oauth", "token", "none"] : ["none", "env", "token", "oauth"]
  const has = (name: string) => c?.secrets.some((s) => s.name === name) ?? false
  const moved = c && edit.form && (edit.form.kind !== c.kind || edit.form.auth !== c.auth || (remote ? edit.form.url.trim() !== (c.url ?? "") : edit.form.command.trim() !== (c.command ?? "") || edit.form.args !== c.args.join("\n")))

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 @min-[30rem]:grid-cols-2">
        <FormField id={fid("label")} label="Label" hint="What Settings shows.">
          <input id={fid("label")} className={inputClass} value={f.label} onChange={(e) => setForm({ label: e.target.value })} placeholder="Notion" maxLength={60} data-testid="connector-label" />
        </FormField>
        <FormField id={fid("name")} label="Name" hint="Its tools are mcp__<name>__…: lowercase letters, digits, - and _.">
          <input id={fid("name")} className={cx(inputClass, "font-mono")} value={f.name} onChange={(e) => setForm({ name: e.target.value.toLowerCase() })} placeholder="notion" maxLength={32} spellCheck={false} autoCapitalize="off" data-testid="connector-name" />
        </FormField>
      </div>

      {builtin ? (
        <BuiltinSetup fid={fid} c={c} f={f} edit={edit} setForm={setForm} set={set} />
      ) : (
        <>
      <FormField id={fid("kind")} label="Kind">
        <Select id={fid("kind")} className="w-full @min-[30rem]:w-72" value={f.kind} onChange={(e) => {
          const kind = e.target.value as ConnectorKind
          setForm({ kind, auth: kind === "stdio" ? (f.auth === "oauth" && f.clientKind === "dynamic" ? "none" : f.auth) : f.auth === "env" ? "oauth" : f.auth })
        }} data-testid="connector-kind">
          <option value="http">Remote server (Streamable HTTP)</option>
          <option value="sse">Remote server (older HTTP + SSE)</option>
          <option value="stdio">Command on this computer (stdio)</option>
        </Select>
      </FormField>

      {remote ? (
        <FormField id={fid("url")} label="Server address" hint="https, or plain http to this computer only. Never put a key in it: use the token below.">
          <input id={fid("url")} className={cx(inputClass, "font-mono")} type="url" value={f.url} onChange={(e) => setForm({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} autoCapitalize="off" data-testid="connector-url" />
        </FormField>
      ) : (
        <>
          <FormField id={fid("command")} label="Command" hint="It runs next to each session that gets it (on an agent's runner too), with only the basics of the environment plus the vars below.">
            <input id={fid("command")} className={cx(inputClass, "font-mono")} value={f.command} onChange={(e) => setForm({ command: e.target.value })} placeholder="npx" spellCheck={false} autoCapitalize="off" data-testid="connector-command" />
          </FormField>
          <div className="grid gap-3 @min-[30rem]:grid-cols-2">
            <FormField id={fid("args")} label="Arguments" hint="One per line.">
              <textarea id={fid("args")} className={cx(inputClass, "min-h-20 font-mono")} value={f.args} onChange={(e) => setForm({ args: e.target.value })} placeholder={"-y\n@example/mcp-server"} spellCheck={false} autoCapitalize="off" />
            </FormField>
            <FormField id={fid("env")} label="Env vars" hint="NAME=value per line, for values that aren't secret. Secret ones go below.">
              <textarea id={fid("env")} className={cx(inputClass, "min-h-20 font-mono")} value={f.env} onChange={(e) => setForm({ env: e.target.value })} placeholder="LOG_LEVEL=warn" spellCheck={false} autoCapitalize="off" />
            </FormField>
          </div>
        </>
      )}

      <FormField id={fid("auth")} label="Signs in with">
        <Select id={fid("auth")} className="w-full @min-[30rem]:w-72" value={f.auth} onChange={(e) => setForm({ auth: e.target.value as ConnectorAuth })} data-testid="connector-auth">
          {auths.map((a) => (
            <option key={a} value={a}>
              {a === "oauth" ? "OAuth sign-in" : a === "token" ? (remote ? "A token or API key (header)" : "A token or API key (env var)") : a === "env" ? "Secret env vars only" : "Nothing"}
            </option>
          ))}
        </Select>
      </FormField>
      {moved && (c?.secrets.length ?? 0) > 0 && <p className="text-xs text-amber-300">This change sends it somewhere else, so Save forgets its sign-in and saved secrets: sign in or add them again.</p>}

      {!remote && (f.auth === "token" || f.auth === "oauth") && (
        <FormField id={fid("tokenEnv")} label="Token env var" hint="The env var the command reads its token from.">
          <input id={fid("tokenEnv")} className={cx(inputClass, "font-mono")} value={f.tokenEnv} onChange={(e) => setForm({ tokenEnv: e.target.value })} placeholder="API_TOKEN" spellCheck={false} autoCapitalize="characters" />
        </FormField>
      )}
      {remote && f.auth === "token" && (
        <div className="grid gap-3 @min-[30rem]:grid-cols-2">
          <FormField id={fid("headerName")} label="Header">
            <input id={fid("headerName")} className={cx(inputClass, "font-mono")} value={f.headerName} onChange={(e) => setForm({ headerName: e.target.value })} spellCheck={false} />
          </FormField>
          <FormField id={fid("headerPrefix")} label="Before the token" hint={'"Bearer " for most servers; empty for a bare key.'}>
            <input id={fid("headerPrefix")} className={cx(inputClass, "font-mono")} value={f.headerPrefix} onChange={(e) => setForm({ headerPrefix: e.target.value })} spellCheck={false} />
          </FormField>
        </div>
      )}
      {f.auth === "token" && (
        <SecretField
          id={fid("token")}
          label="Token"
          hint="Saved encrypted on this server. It never comes back to the browser: only its fingerprint shows."
          saved={c?.secrets.find((s) => s.name === "token") ?? null}
          removing={!!edit.removeToken}
          onRemove={(on) => set("removeToken", on ? true : undefined)}
          value={edit.token ?? ""}
          onChange={(v) => set("token", v.trim() ? v : undefined)}
          placeholder={has("token") ? "Paste a token to replace it" : "Paste the token or API key"}
          testId="connector-token"
        />
      )}
      {f.auth === "oauth" && <OAuthFields fid={fid} c={c} f={f} edit={edit} setForm={setForm} set={set} remote={remote} />}
      {!remote && <EnvSecretFields fid={fid} c={c} edit={edit} onEdit={onEdit} />}
        </>
      )}

      <ScopeFields fid={fid} f={f} setForm={setForm} projects={projects} statusOnly={statusOnly} localOnly={builtin} />

      <SettingsField label="On" keywords="enabled disable connector">
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setForm({ enabled: e.target.checked })} data-testid="connector-enabled" />
          On: the sessions above get it (off keeps its sign-in, but no session gets it)
        </label>
      </SettingsField>

      {c && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-800/80 pt-3">
          {c.auth === "oauth" && c.oauth?.signedInAt && (
            <Button type="button" size="sm" variant={edit.signOut ? "subtle" : "ghost"} onClick={() => set("signOut", edit.signOut ? undefined : true)} data-testid="connector-sign-out">
              {edit.signOut ? <Undo2 className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" />} {edit.signOut ? "Stay signed in" : "Sign out"}
            </Button>
          )}
          <Button type="button" size="sm" variant="danger" onClick={() => onEdit(() => ({ remove: true }))} data-testid="connector-remove">
            <Trash2 className="h-3.5 w-3.5" /> Remove connector
          </Button>
          {edit.signOut && <p className="w-full text-xs text-amber-300">Signed out when you save: its tokens are forgotten, and no session gets it until you sign in again.</p>}
        </div>
      )}
    </div>
  )
}

/**
 * A preset that runs Box Yard's own server (Gmail): the command, sign-in server and scopes are the preset's, so the
 * card asks only for the user's OAuth client, with the provider's setup steps.
 */
function BuiltinSetup({
  fid,
  c,
  f,
  edit,
  setForm,
  set,
}: {
  fid: (k: string) => string
  c: Connector | null
  f: ConnectorForm
  edit: ConnectorEdit
  setForm: (patch: Partial<ConnectorForm>) => void
  set: <K extends keyof ConnectorEdit>(k: K, v: ConnectorEdit[K]) => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const drafts = f.scopes.split(/\s+/).some((x) => x.endsWith("/gmail.compose"))
  return (
    <>
      <p className="text-xs text-zinc-400">
        Runs Box Yard's own Gmail server on this computer. It can search and read your mail, list labels and write drafts, and it has no tool that sends: a draft waits in Gmail for you.
        Sessions get only a short-lived access token.
      </p>
      <GmailGuide open={!c?.oauth?.signedInAt} />
      <FormField id={fid("clientFile")} label="Your Google OAuth client" hint="The Desktop app client from step 6. Box Yard has no Google client of its own: the sign-in is yours.">
        <GoogleClientFile
          id={fid("clientFile")}
          onClient={(client, from) => {
            setForm({ clientId: client.clientId, clientKind: client.kind })
            if (client.clientSecret) set("clientSecret", client.clientSecret)
            setPicked(from)
          }}
        />
        {picked && (
          <p className="text-xs text-amber-300" data-testid="gmail-client-picked">
            Read {picked}: its client id and secret are filled in, sent when you save.{f.clientKind === "web" ? " That's a Web client: it needs Box Yard on https. A Desktop app client works anywhere." : ""}
          </p>
        )}
      </FormField>
      <div className="grid gap-3 @min-[30rem]:grid-cols-2">
        <FormField id={fid("clientId")} label="Client id">
          <input id={fid("clientId")} className={cx(inputClass, "font-mono")} value={f.clientId} onChange={(e) => setForm({ clientId: e.target.value.trim() })} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoCapitalize="off" autoComplete="off" data-testid="connector-client-id" />
        </FormField>
        <SecretField
          id={fid("clientSecret")}
          label="Client secret"
          hint="Kept on this server for signing in and renewing; no session ever gets it."
          saved={c?.secrets.find((s) => s.name === "client_secret") ?? null}
          removing={!!edit.removeClientSecret}
          onRemove={(on) => set("removeClientSecret", on ? true : undefined)}
          value={edit.clientSecret ?? ""}
          onChange={(v) => set("clientSecret", v.trim() ? v : undefined)}
          placeholder={c?.oauth?.hasClientSecret ? "Paste a secret to replace it" : "GOCSPX-…"}
          testId="connector-client-secret"
        />
      </div>
      <SettingsField label="Drafts" keywords="gmail compose scope write drafts read only">
        <label className="flex min-h-11 items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={drafts}
            onChange={(e) => {
              const rest = f.scopes.split(/\s+/).filter((x) => x && !x.endsWith("/gmail.compose"))
              setForm({ scopes: [...rest, ...(e.target.checked ? ["https://www.googleapis.com/auth/gmail.compose"] : [])].join(" ") })
            }}
            data-testid="gmail-drafts"
          />
          <span>
            Let it write drafts <span className="text-xs text-zinc-500">· off: read only. A change takes a new sign-in.</span>
          </span>
        </label>
      </SettingsField>
    </>
  )
}

function OAuthFields({
  fid,
  c,
  f,
  edit,
  setForm,
  set,
  remote,
}: {
  fid: (k: string) => string
  c: Connector | null
  f: ConnectorForm
  edit: ConnectorEdit
  setForm: (patch: Partial<ConnectorForm>) => void
  set: <K extends keyof ConnectorEdit>(k: K, v: ConnectorEdit[K]) => void
  remote: boolean
}) {
  const own = f.clientKind !== "dynamic"
  return (
    <>
      <FormField
        id={fid("clientKind")}
        label="OAuth client"
        hint={own ? "One you made at the provider (Google's way). A Desktop client returns to this computer's address; a Web client needs Box Yard on https." : "Box Yard registers itself with the server's sign-in (what most MCP servers offer)."}
      >
        <Select id={fid("clientKind")} className="w-full @min-[30rem]:w-72" value={f.clientKind} onChange={(e) => setForm({ clientKind: e.target.value as OAuthClientKind })} data-testid="connector-client-kind">
          {remote && <option value="dynamic">Box Yard registers one</option>}
          <option value="desktop">My own Desktop app client</option>
          <option value="web">My own Web client</option>
          {!remote && f.clientKind === "dynamic" && <option value="dynamic">Box Yard registers one</option>}
        </Select>
      </FormField>
      {own && (
        <>
          <div className="grid gap-3 @min-[30rem]:grid-cols-2">
            <FormField id={fid("clientId")} label="Client id">
              <input id={fid("clientId")} className={cx(inputClass, "font-mono")} value={f.clientId} onChange={(e) => setForm({ clientId: e.target.value.trim() })} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} autoCapitalize="off" autoComplete="off" data-testid="connector-client-id" />
            </FormField>
            <FormField id={fid("issuer")} label="Sign-in server (issuer)">
              <input id={fid("issuer")} className={cx(inputClass, "font-mono")} value={f.issuer} onChange={(e) => setForm({ issuer: e.target.value.trim() })} placeholder="https://accounts.google.com" spellCheck={false} autoCapitalize="off" />
            </FormField>
          </div>
          <SecretField
            id={fid("clientSecret")}
            label="Client secret"
            hint="Kept on this server for signing in and renewing; no session ever gets it."
            saved={c?.secrets.find((s) => s.name === "client_secret") ?? null}
            removing={!!edit.removeClientSecret}
            onRemove={(on) => set("removeClientSecret", on ? true : undefined)}
            value={edit.clientSecret ?? ""}
            onChange={(v) => set("clientSecret", v.trim() ? v : undefined)}
            placeholder={c?.oauth?.hasClientSecret ? "Paste a secret to replace it" : "Paste the client secret"}
            testId="connector-client-secret"
          />
        </>
      )}
      <div className="grid gap-3 @min-[30rem]:grid-cols-2">
        <FormField id={fid("scopes")} label="Scopes" hint="Space separated. Empty: what the server asks for.">
          <input id={fid("scopes")} className={cx(inputClass, "font-mono")} value={f.scopes} onChange={(e) => setForm({ scopes: e.target.value })} spellCheck={false} autoCapitalize="off" />
        </FormField>
        <FormField id={fid("authParams")} label="Sign-in parameters" hint="name=value per line, added to the sign-in page's address (access_type=offline).">
          <textarea id={fid("authParams")} className={cx(inputClass, "min-h-11 font-mono")} value={f.authParams} onChange={(e) => setForm({ authParams: e.target.value })} spellCheck={false} autoCapitalize="off" />
        </FormField>
      </div>
    </>
  )
}

function EnvSecretFields({ fid, c, edit, onEdit }: { fid: (k: string) => string; c: Connector | null; edit: ConnectorEdit; onEdit: (fn: (prev: ConnectorEdit) => ConnectorEdit) => void }) {
  const saved = c?.secrets.filter((s) => s.name.startsWith("env:")) ?? []
  const removing = edit.removeEnv ?? []
  const toggle = (name: string) =>
    onEdit((prev) => {
      const list = prev.removeEnv ?? []
      const next = list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
      return put(prev, "removeEnv", next.length ? next : undefined, null)
    })
  const setPair = (p: { name: string; value: string }) => onEdit((prev) => put(prev, "envSecret", p.name.trim() || p.value.trim() ? p : undefined, null))
  return (
    <FormField id={fid("envSecret")} label="Secret env vars" hint="An API key the command reads from its env. Saved encrypted; sessions get it as a reference, never in a file.">
      {saved.map((s) => {
        const name = s.name.slice(4)
        return (
          <div key={s.name} className={cx("flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs sm:min-h-9", removing.includes(name) ? "border-red-500/30 bg-red-500/10 text-red-200 line-through" : "border-zinc-800 bg-zinc-900 text-zinc-300")}>
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="min-w-0 flex-1 truncate">
              <code className="font-mono">{name}</code> · <code className="font-mono text-zinc-500">{s.fingerprint}</code>
              {!s.readable && <span className="text-red-300"> · can't be read: save it again</span>}
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={() => toggle(name)}>
              {removing.includes(name) ? "Keep" : "Remove"}
            </Button>
          </div>
        )
      })}
      <div className="grid gap-2 @min-[30rem]:grid-cols-[12rem_minmax(0,1fr)]">
        <input className={cx(inputClass, "font-mono")} value={edit.envSecret?.name ?? ""} onChange={(e) => setPair({ name: e.target.value, value: edit.envSecret?.value ?? "" })} placeholder="API_KEY" aria-label="Secret env var name" spellCheck={false} autoCapitalize="characters" data-testid="connector-env-name" />
        <input
          id={fid("envSecret")}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={cx(inputClass, "font-mono")}
          value={edit.envSecret?.value ?? ""}
          onChange={(e) => setPair({ name: edit.envSecret?.name ?? "", value: e.target.value })}
          placeholder={saved.length ? "Add or replace one" : "Its value"}
          aria-label="Secret env var value"
          data-testid="connector-env-value"
        />
      </div>
    </FormField>
  )
}

function SecretField({
  id,
  label,
  hint,
  saved,
  removing,
  onRemove,
  value,
  onChange,
  placeholder,
  testId,
}: {
  id: string
  label: string
  hint: string
  saved: { fingerprint: string; readable: boolean } | null
  removing: boolean
  onRemove: (on: boolean) => void
  value: string
  onChange: (v: string) => void
  placeholder: string
  testId: string
}) {
  return (
    <FormField id={id} label={label} hint={hint}>
      {saved && (
        <div className={cx("flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs sm:min-h-9", removing ? "border-red-500/30 bg-red-500/10 text-red-200 line-through" : "border-zinc-800 bg-zinc-900 text-zinc-300")}>
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate">
            saved · <code className="font-mono">{saved.fingerprint}</code>
            {!saved.readable && <span className="text-red-300"> · can't be read: save it again</span>}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(!removing)}>
            {removing ? "Keep" : "Remove"}
          </Button>
        </div>
      )}
      {!removing && <input id={id} type="password" autoComplete="off" spellCheck={false} className={cx(inputClass, "font-mono")} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} data-testid={testId} />}
    </FormField>
  )
}

const SESSION_HELP: Record<ConnectorSession, string> = {
  coordinator: "the chat that runs the yard: no shell, on this computer",
  captain: "each project's Captain",
  agent: "agents' turns on the runners below",
}

function ScopeFields({
  fid,
  f,
  setForm,
  projects,
  statusOnly,
  localOnly,
}: {
  fid: (k: string) => string
  f: ConnectorForm
  setForm: (patch: Partial<ConnectorForm>) => void
  projects: Project[]
  statusOnly: Set<string>
  /** A server Box Yard ships: it runs on this computer only, so its agents are on the local runner. */
  localOnly: boolean
}) {
  const projectWide = f.sessions.some((s) => s !== "coordinator")
  const sealedBlocked = f.sessions.includes("coordinator") && projectWide
  const remoteRunners = f.sessions.includes("agent") && f.runners.some((r) => r !== "local")
  return (
    <FormField id={fid("sessions")} label="Who gets it" hint="Start small: the Coordinator only. Captains, agents, other projects and remote runners are each a choice you make.">
      <div id={fid("sessions")} className="flex flex-col gap-1">
        {CONNECTOR_SESSIONS.map((s) => (
          <label key={s} className="flex min-h-11 items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-1"
              checked={f.sessions.includes(s)}
              onChange={(e) => setForm({ sessions: CONNECTOR_SESSIONS.filter((x) => (x === s ? e.target.checked : f.sessions.includes(x))) })}
              data-testid={`connector-session-${s}`}
            />
            <span>
              {CONNECTOR_SESSION_LABEL[s]} <span className="text-xs text-zinc-500">· {SESSION_HELP[s]}</span>
            </span>
          </label>
        ))}
      </div>
      {projectWide && (
        <div className="mt-2 space-y-1 rounded-lg border border-zinc-800 p-3">
          <p className="text-xs font-medium text-zinc-400">Projects (their Captains and agents)</p>
          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
            <input type="radio" name={fid("projects-mode")} checked={f.projects === null} onChange={() => setForm({ projects: null })} />
            Every project
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
            <input type="radio" name={fid("projects-mode")} checked={f.projects !== null} onChange={() => setForm({ projects: f.projects ?? [] })} data-testid="connector-projects-chosen" />
            Chosen projects
          </label>
          {f.projects !== null && (
            <div className="grid grid-cols-1 gap-x-4 pl-6 @min-[30rem]:grid-cols-2">
              {projects.map((p) => {
                const sealed = sealedBlocked && statusOnly.has(p.id)
                return (
                  <label key={p.id} className={cx("flex min-h-11 items-center gap-2 text-sm", sealed ? "text-zinc-500" : "text-zinc-300")} title={sealed ? "It shows the Coordinator status only, and the Coordinator gets this connector too" : undefined}>
                    <input
                      type="checkbox"
                      disabled={sealed && !f.projects?.includes(p.id)}
                      checked={f.projects?.includes(p.id) ?? false}
                      onChange={(e) => setForm({ projects: e.target.checked ? [...(f.projects ?? []), p.id] : (f.projects ?? []).filter((x) => x !== p.id) })}
                    />
                    <span className="min-w-0 truncate">{p.name}</span>
                    {sealed && <span className="text-[11px] text-zinc-500">status only</span>}
                  </label>
                )
              })}
              {!projects.length && <p className="text-xs text-zinc-500">No projects yet.</p>}
            </div>
          )}
          {sealedBlocked && statusOnly.size > 0 && <p className="text-xs text-zinc-500">Projects that show the Coordinator status only never get a connector the Coordinator uses: it would carry their content to it.</p>}
        </div>
      )}
      {f.sessions.includes("agent") && (
        <div className="mt-2 space-y-1 rounded-lg border border-zinc-800 p-3">
          <p className="text-xs font-medium text-zinc-400">Agents on</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {RUNNERS.map((r) => (
              <label key={r} className={cx("flex min-h-11 items-center gap-2 text-sm", localOnly && r !== "local" ? "text-zinc-500" : "text-zinc-300")}>
                <input
                  type="checkbox"
                  checked={f.runners.includes(r)}
                  disabled={localOnly && r !== "local" && !f.runners.includes(r)}
                  onChange={(e) => setForm({ runners: RUNNERS.filter((x) => (x === r ? e.target.checked : f.runners.includes(x))) })}
                  data-testid={`connector-runner-${r}`}
                />
                {RUNNER_LABEL[r]}
              </label>
            ))}
          </div>
          {localOnly && <p className="text-xs text-zinc-500">Box Yard's own server runs on this computer only, so its agents are the ones on this computer.</p>}
          {remoteRunners && <p className="text-xs text-amber-300/90">Elsewhere than this computer, a turn's token sits in its task folder, where any agent on that machine can read it. On Upstash boxes, projects with these connectors get boxes of their own.</p>}
        </div>
      )}
    </FormField>
  )
}

// ------------------------------------------------------------------ bits

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-300 wrap-anywhere">{children}</dd>
    </>
  )
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-zinc-500">{children}</span>

function FormField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <SettingsField label={label} className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <SearchHighlight text={label} />
      </label>
      {children}
      {hint && (
        <p className="text-xs leading-relaxed text-zinc-500">
          <SearchHighlight text={hint} />
        </p>
      )}
    </SettingsField>
  )
}
