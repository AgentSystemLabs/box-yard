// Settings › Identities (docs/identities.md): who each project acts as on GitHub, one card per identity. Every edit is
// a draft that the dialog's Save writes, including Add, Delete and Import from this computer; Test and the detection
// itself only read. Tokens and keys go in through write-only fields and never come back: the cards show fingerprints.
import { createContext, useContext, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { Check, Fingerprint, KeyRound, Laptop, Pencil, Play, Plus, ScanSearch, Trash2, Undo2, X } from "lucide-react"
import { ApiError } from "../lib/api"
import { identityApi, useDetectIdentities, useIdentities, useProjects, useSetup, useTestIdentity } from "../lib/queries"
import { AuthorFallbackNotice } from "./Setup"
import { SettingsField, SearchHighlight, useSettingsSearching } from "../lib/settingsSearch"
import { SettingsFieldError, useDraft } from "../lib/settingsDraft"
import { identityCreate, identityPatch, tokenInput, claudeInput, signingInput, type ValidationField } from "../../../shared/identityValidation"
import { GPG_KEY_ID_RE, IDENTITY_COLORS, type CoordinatorSees, type Identity, type IdentityClaudeKind, type IdentityColor, type IdentityDetection, type IdentityInput, type IdentityProposal } from "../../../shared/identities"
import { RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"
import type { Project } from "../../../shared/types"
import { IDENTITY_DOT, IdentityDot } from "./IdentityBadge"
import { Panel } from "./SettingsBlocks"
import { useOpenSettings } from "./SettingsHost"
import { Button, LineIcon, Select, TimeAgo, cx, inputClass } from "./ui"
import { Loading } from "./Loading"
import { LoginLimitsLine } from "./LoginLimits"

// ------------------------------------------------------------------ drafts

/** A signing key to save: a key file read in this browser (sent once, on Save), or an agent's public key. */
type SigningDraft = { kind: "gpg"; keyId: string } | { kind: "file"; privateKey: string; fileName: string } | { kind: "agent"; publicKey: string; program: string }

/** What an identity card's draft changes. A key is there only while it differs from what's saved. */
export interface IdentityEdit {
  name?: string
  color?: IdentityColor
  /** As typed: "acme-corp, octo-acme". */
  owners?: string
  author?: { name: string; email: string } | null
  runners?: Runner[] | null
  coordinatorSees?: CoordinatorSees
  requireSigned?: boolean
  /** A pasted GitHub token, for one owner or ("") every owner. */
  token?: { owner: string; value: string }
  removeTokens?: string[]
  /** A pasted Claude login, or null to drop the identity's own. */
  claude?: { kind: IdentityClaudeKind; value: string } | null
  /** A key to save, or null to stop signing. */
  signing?: SigningDraft | null
  /** Delete the identity on Save; its projects move to Default. */
  remove?: true
}

const NO_EDIT: IdentityEdit = {}
const NO_NEW: NewIdentity[] = []
const NO_IMPORT: Record<string, string[]> = {}

interface NewIdentity {
  key: string
  edit: IdentityEdit
}

export const parseOwners = (text: string) => [...new Set(text.split(/[\s,]+/).map((o) => o.trim().toLowerCase()).filter(Boolean))]
const sameOwners = (text: string, saved: string[]) => JSON.stringify(parseOwners(text)) === JSON.stringify(saved.map((o) => o.toLowerCase()))
/** Every runner ticked is "every runner" (null), so a new runner later is allowed too. */
const normalRunners = (r: Runner[] | null) => (r === null || r.length === RUNNERS.length ? null : RUNNERS.filter((x) => r.includes(x)))
const authorOf = (a: { name: string; email: string } | null | undefined) => (a && (a.name.trim() || a.email.trim()) ? { name: a.name.trim(), email: a.email.trim() } : null)

/** How many changes a card's draft holds, for "N unsaved changes". */
export const editCount = (e: IdentityEdit) => Object.entries(e).reduce((n, [k, v]) => (v === undefined ? n : n + (k === "removeTokens" ? (v as string[]).length : 1)), 0)

/** Set one field of a draft; back at the saved value, the field drops out (the card is clean again). */
function put<K extends keyof IdentityEdit>(edit: IdentityEdit, k: K, v: IdentityEdit[K], i: Identity | null): IdentityEdit {
  const { [k]: _old, ...rest } = edit
  if (v === undefined) return rest
  if (i) {
    if (k === "name" && v === i.name) return rest
    if (k === "color" && v === i.color) return rest
    if (k === "owners" && sameOwners(v as string, i.owners)) return rest
    if (k === "author" && JSON.stringify(authorOf(v as IdentityEdit["author"])) === JSON.stringify(i.author ? { name: i.author.name, email: i.author.email } : null)) return rest
    if (k === "runners" && JSON.stringify(normalRunners(v as Runner[] | null)) === JSON.stringify(i.runners)) return rest
    if (k === "coordinatorSees" && v === i.coordinatorSees) return rest
    if (k === "requireSigned" && v === (i.signing?.requireSigned ?? false)) return rest
  }
  return { ...rest, [k]: v }
}

/** The PATCH (or POST) body for a draft's plain fields. */
function fieldsOf(e: IdentityEdit): IdentityInput {
  const f: IdentityInput = {}
  if (e.name !== undefined) f.name = e.name.trim()
  if (e.color !== undefined) f.color = e.color
  if (e.owners !== undefined) f.owners = parseOwners(e.owners)
  if (e.author !== undefined) f.author = authorOf(e.author)
  if (e.runners !== undefined) f.runners = normalRunners(e.runners)
  if (e.coordinatorSees !== undefined) f.coordinatorSees = e.coordinatorSees
  return f
}

type IdentityOperation = "fields" | "token" | "claude" | "signing"
interface IdentityProblem { field: string; message: string }
interface IdentityFailure { problem: IdentityProblem; value: string }
const FIELD_LABEL: Record<string, string> = { name: "Name", owners: "Owners", author: "Author name", authorEmail: "Author email", tokenOwner: "Token owner", token: "GitHub token", claude: "Claude login", signing: "Signing key", signingPublicKey: "Public key", signingProgram: "Signing program", runners: "Runs on", coordinatorSees: "Coordinator sees" }
const IdentityProblems = createContext<IdentityProblem[]>([])

/** API paths are relative to their endpoint: token `owner` is never the identity's `owners`. */
function fieldProblem(operation: IdentityOperation, issue?: ValidationField): IdentityProblem {
  const path = issue?.path ?? ""
  const field = operation === "fields" ? (path.startsWith("owners") ? "owners" : path === "author.email" ? "authorEmail" : path === "author.name" ? "author" : path.split(".")[0] || "name")
    : operation === "token" ? (path === "owner" ? "tokenOwner" : "token")
    : operation === "signing" ? (path === "program" ? "signingProgram" : path === "publicKey" ? "signingPublicKey" : "signing") : "claude"
  const message = field === "tokenOwner" ? "Enter one GitHub user or org name, like acme-corp, or leave blank for every owner. Use no repository, URL or list."
    : field === "owners" && path.startsWith("owners.") ? "Enter GitHub user or org names like acme-corp, separated by commas or spaces. Use no repository or URL."
    : issue?.message ?? "Couldn't save this field."
  return { field, message }
}

function signingOf(e: IdentityEdit) {
  const s = e.signing
  if (!s) return null
  return s.kind === "file" ? { kind: s.kind, privateKey: s.privateKey, requireSigned: e.requireSigned }
    : s.kind === "gpg" ? { kind: s.kind, keyId: s.keyId.trim(), requireSigned: e.requireSigned }
    : { kind: s.kind, publicKey: s.publicKey.trim(), program: s.program.trim() || null, requireSigned: e.requireSigned }
}

/** Check only pending writes, never saved identities unrelated to this draft. */
function draftProblems(e: IdentityEdit, isNew = false): IdentityProblem[] {
  if (e.remove) return []
  const problems: IdentityProblem[] = []
  const collect = (operation: IdentityOperation, result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) => {
    for (const i of result.error?.issues ?? []) problems.push(fieldProblem(operation, { path: i.path.join("."), message: i.message }))
  }
  collect("fields", (isNew ? identityCreate : identityPatch).safeParse(fieldsOf(e)))
  if (e.token) collect("token", tokenInput.safeParse({ owner: e.token.owner.trim(), token: e.token.value }))
  if (e.claude) collect("claude", claudeInput.safeParse(e.claude))
  if (e.signing) collect("signing", signingInput.safeParse(signingOf(e)))
  return problems
}

function fieldFailure(name: string, problem: IdentityProblem, fid: (k: string) => string, reveal?: () => void) {
  return new SettingsFieldError(`${name}: ${FIELD_LABEL[problem.field] ?? problem.field}: ${problem.message}`, "identities", fid(problem.field), reveal)
}

/** Remember a server error only while that field's draft is unchanged. */
function problemValue(e: IdentityEdit, field: string): string {
  const key = field.startsWith("token") ? "token" : field.startsWith("author") ? "author" : field.startsWith("signing") ? "signing" : field as keyof IdentityEdit
  return JSON.stringify(e[key]) ?? ""
}
const currentFailure = (e: IdentityEdit, failure?: IdentityFailure | null) => editCount(e) && failure && failure.value === problemValue(e, failure.problem.field) ? [failure.problem] : []

class IdentityWriteError {
  constructor(readonly operation: IdentityOperation, readonly error: unknown) {}
}
async function writeField<T>(operation: IdentityOperation, write: () => Promise<T>): Promise<T> {
  try { return await write() } catch (error) { throw new IdentityWriteError(operation, error) }
}
function serverProblem(err: unknown, edit: IdentityEdit): IdentityProblem {
  const operation = err instanceof IdentityWriteError ? err.operation : "fields"
  const error = err instanceof IdentityWriteError ? err.error : err
  const problem = fieldProblem(operation, error instanceof ApiError && error.fields?.length ? error.fields[0] : { path: operation === "fields" ? Object.keys(fieldsOf(edit))[0] ?? "name" : "", message: error instanceof Error ? error.message : "Couldn't save this field." })
  return problem.field === "signing" && edit.signing?.kind === "agent" ? { ...problem, field: "signingPublicKey" } : problem
}

/**
 * Write a card's draft: fields first (so a key that needs "This computer" finds it allowed), then the secrets. Each
 * part leaves the draft once it's saved, so a Save that stops halfway is retried from where it stopped.
 */
async function writeEdit(id: string, e: IdentityEdit, done: (k: keyof IdentityEdit) => void) {
  const fields = fieldsOf(e)
  if (Object.keys(fields).length) {
    await writeField("fields", () => identityApi.update(id, fields))
    for (const k of ["name", "color", "owners", "author", "runners", "coordinatorSees"] as const) done(k)
  }
  for (const owner of e.removeTokens ?? []) await writeField("token", () => identityApi.removeToken(id, owner))
  if (e.removeTokens) done("removeTokens")
  if (e.token) {
    await writeField("token", () => identityApi.saveToken(id, e.token!.owner.trim().toLowerCase(), e.token!.value.trim()))
    done("token")
  }
  if (e.claude !== undefined) {
    await writeField("claude", () => e.claude ? identityApi.saveClaude(id, e.claude.kind, e.claude.value.trim()) : identityApi.removeClaude(id))
    done("claude")
  }
  if (e.signing !== undefined) {
    const signing = signingOf(e)
    await writeField("signing", () => signing ? identityApi.saveSigning(id, signing) : identityApi.removeSigning(id))
    done("signing")
    done("requireSigned")
  } else if (e.requireSigned !== undefined) {
    await writeField("signing", () => identityApi.setRequireSigned(id, e.requireSigned!))
    done("requireSigned")
  }
}

const named = (name: string, err: unknown) => new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`)

// ------------------------------------------------------------------ the panel

export function IdentitiesPanel({ fid }: { fid: (k: string) => string }) {
  const identities = useIdentities()
  const projects = useProjects()
  const setup = useSetup()
  const [newFailures, setNewFailures] = useState<Record<string, IdentityFailure>>({})
  const newFid = (key: string) => (k: string) => fid(`new-${key}-${k}`)
  const failNew = (n: NewIdentity, err: unknown): never => {
    const problem = serverProblem(err, n.edit)
    setNewFailures((prev) => ({ ...prev, [n.key]: { problem, value: problemValue(n.edit, problem.field) } }))
    throw fieldFailure(n.edit.name?.trim() || "New identity", problem, newFid(n.key))
  }
  const [news, setNews] = useDraft<NewIdentity[]>("identities-new", "identities", NO_NEW, async (list) => {
    for (const n of list) {
      const name = n.edit.name?.trim() ?? ""
      const made = await identityApi.create({ ...fieldsOf(n.edit), name }).catch((err: unknown) => failNew(n, err))
      try {
        const { name: _n, color: _c, owners: _o, author: _a, runners: _r, coordinatorSees: _s, ...secrets } = n.edit
        await writeEdit(made.id, secrets, () => {})
      } catch (err) {
        // Nothing half-made: the identity goes again, and the draft stays for another try.
        await identityApi.remove(made.id).catch(() => {})
        failNew(n, err)
      }
      setNews((prev) => prev.filter((x) => x.key !== n.key))
    }
  }, (list) => list.length, (list) => {
    for (const n of list) {
      const problem = draftProblems(n.edit, true)[0]
      if (problem) throw fieldFailure(n.edit.name?.trim() || "New identity", problem, newFid(n.key))
    }
  })
  const byId = new Map((projects.data ?? []).map((p) => [p.id, p]))
  const list = identities.data ?? []

  const add = () => setNews((prev) => [...prev, { key: crypto.randomUUID(), edit: { name: "", color: nextColor(list, prev) } }])

  return (
    <Panel section="identities">
      <AuthorFallbackNotice status={setup.data} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={add} data-testid="identity-add">
          <Plus className="h-3.5 w-3.5" /> Add identity
        </Button>
      </div>
      <ImportFromComputer fid={fid} identities={list} projects={byId} />
      <div className="mt-5 space-y-3">
        {news.map((n) => (
          <NewIdentityCard
            key={n.key}
            fid={(k) => fid(`new-${n.key}-${k}`)}
            edit={n.edit}
            failure={newFailures[n.key]}
            onEdit={(edit) => setNews((prev) => prev.map((x) => (x.key === n.key ? { ...x, edit } : x)))}
            onDrop={() => setNews((prev) => prev.filter((x) => x.key !== n.key))}
          />
        ))}
        {!identities.data ? (
          <Loading count={2} label="Loading identities" />
        ) : (
          list.map((i) => <IdentityCard key={i.id} identity={i} projects={byId} fid={(k) => fid(`${i.id}-${k}`)} />)
        )}
      </div>
    </Panel>
  )
}

function nextColor(list: Identity[], news: NewIdentity[]): IdentityColor {
  const used = new Set([...list.map((i) => i.color), ...news.map((n) => n.edit.color)])
  return IDENTITY_COLORS.find((c) => c !== "slate" && !used.has(c)) ?? "sky"
}

// ------------------------------------------------------------------ one identity

function IdentityCard({ identity: i, projects, fid }: { identity: Identity; projects: Map<string, Project>; fid: (k: string) => string }) {
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<IdentityFailure | null>(null)
  const name = (e: IdentityEdit) => e.name?.trim() || i.name
  const [edit, setEdit, dirty] = useDraft<IdentityEdit>(`identity-${i.id}`, "identities", NO_EDIT, async (e) => {
    try { await persistEdit(i, e, setEdit) } catch (err) {
      const problem = serverProblem(err, e)
      setFailure({ problem, value: problemValue(e, problem.field) })
      throw fieldFailure(name(e), problem, fid, () => setOpen(true))
    }
  }, editCount, (e) => {
    const problem = draftProblems(e)[0]
    if (problem) throw fieldFailure(name(e), problem, fid, () => setOpen(true))
  })
  const searching = useSettingsSearching()
  const test = useTestIdentity()
  const openSettings = useOpenSettings()
  const check = i.lastCheck
  const used = i.projectIds.map((id) => projects.get(id)?.name ?? id)

  return (
    <article className={cx("@container rounded-xl border bg-zinc-900/40 p-4", edit.remove ? "border-red-500/40" : dirty ? "border-amber-500/40" : "border-zinc-800")} data-identity-card={i.name}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <IdentityDot color={edit.color ?? i.color} className="h-2.5 w-2.5" />
        <h4 className="text-sm font-semibold text-zinc-100">{edit.name ?? i.name}</h4>
        {i.githubLogin && <span className="font-mono text-xs text-zinc-400">{i.githubLogin}</span>}
        {i.isDefault && <span className="rounded bg-zinc-800 px-1.5 py-px text-[11px] text-zinc-400">Settings › Credentials</span>}
        {dirty && !edit.remove && <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">unsaved</span>}
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate(i.id)} title="Check it with GitHub: tokens, push access to its projects' repos, author email, signing key">
            <Play className="h-3.5 w-3.5" /> Test
          </Button>
          {!edit.remove && (
            <Button type="button" size="sm" variant={open ? "subtle" : "ghost"} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="identity-edit">
              <Pencil className="h-3.5 w-3.5" /> {open ? "Done" : "Edit"}
            </Button>
          )}
        </span>
      </header>

      {edit.remove ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200" data-identity-removing>
          <span className="flex-1">Deleted when you save{used.length ? `; ${used.join(", ")} move${used.length === 1 ? "s" : ""} to Default` : ""}.</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEdit((e) => put(e, "remove", undefined, i))}>
            <Undo2 className="h-3.5 w-3.5" /> Keep it
          </Button>
        </div>
      ) : open || searching ? (
        <IdentityForm fid={fid} identity={i} edit={edit} onEdit={setEdit} problems={[...draftProblems(edit), ...currentFailure(edit, failure)]} />
      ) : (
        <dl className="mt-3 grid grid-cols-1 gap-x-3 gap-y-1 text-xs @min-[26rem]:grid-cols-[7rem_minmax(0,1fr)]">
          {i.isDefault && (
            <Fact label="Uses">
              The keys in{" "}
              <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("credentials")}>
                Settings › Credentials
              </button>{" "}
              (env vars, saved keys or this computer's gh login).
            </Fact>
          )}
          <Fact label="Owners">{i.owners.length ? i.owners.join(", ") : <Muted>any owner</Muted>}</Fact>
          <Fact label="Author">
            {i.author ? (
              <>
                {i.author.name} &lt;{i.author.email}&gt; <EmailCheck check={i.author.emailCheck} login={i.githubLogin} />
              </>
            ) : (
              <Muted>Settings' git author</Muted>
            )}
          </Fact>
          {!i.isDefault && (
            <Fact label="GitHub token">
              {i.tokens.length ? (
                i.tokens.map((t) => (
                  <span key={t.owner} className="block">
                    {t.owner || "every owner"} · {t.login}
                    {t.scopes ? ` · ${t.scopes.join(", ")}` : ""}
                    {t.expiresAt ? (
                      <>
                        {" "}
                        · expires <TimeAgo ts={t.expiresAt} />
                      </>
                    ) : null}{" "}
                    · <code className="font-mono text-zinc-500">{t.fingerprint}</code>
                    {t.source.startsWith("gh:") && <Muted> · from gh</Muted>}
                    {!t.readable && <span className="text-red-300"> · can't be read: save it again</span>}
                  </span>
                ))
              ) : (
                <span className="text-amber-300">none yet: its projects' turns get no GitHub token</span>
              )}
            </Fact>
          )}
          <Fact label="Signing">
            {i.signing ? (
              <>
                <code className="font-mono text-zinc-300">{i.signing.fingerprint}</code> · {i.signing.kind === "gpg" ? "GPG keyring · local runner only" : i.signing.kind === "file" ? "key file, kept encrypted" : `this computer's SSH agent${i.signing.program ? ` (${i.signing.program.split("/").pop()})` : ""}`}
                {i.signing.requireSigned && " · unsigned pushes stopped"}
                {!i.signing.readable && <span className="text-red-300"> · can't be read: save it again</span>}
              </>
            ) : (
              <Muted>commits aren't signed</Muted>
            )}
          </Fact>
          {!i.isDefault && (
            <Fact label="Claude">
              {i.claude ? `its own ${i.claude.kind === "api_key" ? "API key" : "OAuth token"} · ${i.claude.fingerprint}` : <Muted>Settings' Claude login</Muted>}
              {i.claude && <LoginLimitsLine scope={`identity:${i.id}`} harness="claude" className="mt-1" />}
            </Fact>
          )}
          <Fact label="Runs on">{i.signing?.kind === "gpg" ? "This computer (GPG keyring)" : i.runners ? i.runners.map((r) => RUNNER_LABEL[r]).join(", ") : <Muted>any runner</Muted>}</Fact>
          <Fact label="Coordinator sees">{i.coordinatorSees === "status" ? <span data-coordinator-sees="status">status only: its Captains see the rest</span> : <Muted>everything</Muted>}</Fact>
          <Fact label="Projects">{used.length ? used.join(", ") : <Muted>none</Muted>}</Fact>
        </dl>
      )}
      {check && !edit.remove && <CheckLines result={check} />}
      {test.error && <p className="mt-2 text-xs text-red-300">{test.error.message}</p>}
    </article>
  )
}

/** Save one card's draft (the dialog's Save). Deleting moves its projects to Default first. */
async function persistEdit(i: Identity, e: IdentityEdit, setEdit: (fn: (prev: IdentityEdit) => IdentityEdit) => void): Promise<void> {
  if (e.remove) {
    await identityApi.remove(i.id)
    return
  }
  await writeEdit(i.id, e, (k) => setEdit((prev) => put(prev, k, undefined, null)))
}

function NewIdentityCard({ fid, edit, onEdit, onDrop, failure }: { failure?: IdentityFailure; fid: (k: string) => string; edit: IdentityEdit; onEdit: (e: IdentityEdit) => void; onDrop: () => void }) {
  return (
    <article className="@container rounded-xl border border-amber-500/40 bg-zinc-900/40 p-4" data-identity-card="new">
      <header className="flex items-center gap-2">
        <IdentityDot color={edit.color ?? "sky"} className="h-2.5 w-2.5" />
        <h4 className="text-sm font-semibold text-zinc-100">{edit.name?.trim() || "New identity"}</h4>
        <span className="rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">made when you save</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onDrop} aria-label="Don't add it">
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>
      <IdentityForm fid={fid} identity={null} edit={edit} onEdit={(fn) => onEdit(fn(edit))} problems={[...draftProblems(edit, true), ...currentFailure(edit, failure)]} />
    </article>
  )
}

// ------------------------------------------------------------------ the form (an identity's draft)

function IdentityForm({ fid, identity: i, edit, onEdit, problems }: { problems: IdentityProblem[]; fid: (k: string) => string; identity: Identity | null; edit: IdentityEdit; onEdit: (fn: (prev: IdentityEdit) => IdentityEdit) => void }) {
  const set = <K extends keyof IdentityEdit>(k: K, v: IdentityEdit[K]) => onEdit((prev) => put(prev, k, v, i))
  const isDefault = i?.isDefault ?? false
  const author = edit.author !== undefined ? edit.author : i?.author ? { name: i.author.name, email: i.author.email } : null
  const runners = edit.runners !== undefined ? edit.runners : (i?.runners ?? null)
  const ticked = (r: Runner) => runners === null || runners.includes(r)
  const signs = edit.signing !== undefined ? edit.signing !== null : Boolean(i?.signing)
  const openSettings = useOpenSettings()

  return (
    <IdentityProblems.Provider value={problems}>
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 @min-[30rem]:grid-cols-2">
        <FormField id={fid("name")} label="Name" hint={isDefault ? "The Default identity keeps its name." : undefined}>
          <IdentityInput fid={fid} field="name" className={inputClass} value={edit.name ?? i?.name ?? ""} disabled={isDefault} onChange={(e) => set("name", e.target.value)} placeholder="Acme" maxLength={60} />
        </FormField>
        <FormField id={fid("color")} label="Colour">
          <IdentityControl fid={fid} field="color">{(check) => <div {...check} tabIndex={-1} role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1">
            {IDENTITY_COLORS.map((c) => {
              const on = (edit.color ?? i?.color) === c
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={c}
                  title={c}
                  onClick={() => set("color", c)}
                  className={cx("grid h-11 w-11 place-items-center rounded-lg sm:h-7 sm:w-7", on ? "bg-zinc-800 ring-1 ring-zinc-600" : "hover:bg-zinc-800")}
                >
                  <span className={cx("h-3 w-3 rounded-full", IDENTITY_DOT[c])} />
                </button>
              )
            })}
          </div>}</IdentityControl>
        </FormField>
      </div>
      <FormField id={fid("owners")} label="Owners" hint="GitHub users and orgs whose repos it's for, so Import and the Coordinator know which projects it fits.">
        <IdentityInput fid={fid} field="owners" className={inputClass} value={edit.owners ?? i?.owners.join(", ") ?? ""} onChange={(e) => set("owners", e.target.value)} placeholder="acme-corp, octo-acme" spellCheck={false} />
      </FormField>
      <FormField id={fid("author")} label="Git author" hint="The name and email its commits get. Use one of the account's verified emails, or GitHub won't link the commits to it. Blank: Settings › Credentials › Git author, else (Default identity on this computer) your git config, else the GitHub account behind its token.">
        <div className="grid gap-2 @min-[30rem]:grid-cols-2">
          <IdentityInput fid={fid} field="author" className={inputClass} value={author?.name ?? ""} onChange={(e) => set("author", { name: e.target.value, email: author?.email ?? "" })} placeholder="Ada Lovelace" aria-label="Author name" />
          <IdentityInput fid={fid} field="authorEmail" className={inputClass} type="email" value={author?.email ?? ""} onChange={(e) => set("author", { name: author?.name ?? "", email: e.target.value })} placeholder="ada@acme.dev" aria-label="Author email" spellCheck={false} />
        </div>
      </FormField>
      <FormField id={fid("runners")} label="Runs on" hint="Where its projects may run. A key only this computer's SSH agent holds signs only here.">
        <IdentityControl fid={fid} field="runners">{(check) => <div {...check} role="group" aria-label="Runs on" tabIndex={-1} className="flex flex-wrap gap-x-4 gap-y-1">
          {RUNNERS.map((r) => (
            <label key={r} className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
              <input
                type="checkbox"
                checked={ticked(r)}
                onChange={(e) => {
                  const now = RUNNERS.filter((x) => (x === r ? e.target.checked : ticked(x)))
                  if (now.length) set("runners", now)
                }}
              />
              {RUNNER_LABEL[r]}
            </label>
          ))}
        </div>}</IdentityControl>
      </FormField>
      <FormField
        id={fid("coordinatorSees")}
        label="Coordinator sees"
        hint="Status only: the Coordinator gets its projects' task titles, states and PRs, not their replies, questions, notes, artifacts or history. Their Captains still see everything. The Coordinator can set this to status only, but only you set it back."
      >
        <IdentityControl fid={fid} field="coordinatorSees">{(check) => <Select {...check} className="w-full sm:w-60" value={edit.coordinatorSees ?? i?.coordinatorSees ?? "everything"} onChange={(e) => set("coordinatorSees", e.target.value as CoordinatorSees)} data-testid="identity-coordinator-sees">
          <option value="everything">Everything</option>
          <option value="status">Status only</option>
        </Select>}</IdentityControl>
      </FormField>

      {isDefault ? (
        <p className="text-xs leading-relaxed text-zinc-500">
          Its GitHub token and Claude login are the ones in{" "}
          <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("credentials")}>
            Settings › Credentials
          </button>
          .
        </p>
      ) : (
        <>
          <TokenFields fid={fid} identity={i} edit={edit} onEdit={onEdit} />
          <ClaudeField fid={fid} identity={i} edit={edit} set={set} />
        </>
      )}
      <SigningField fid={fid} identity={i} edit={edit} set={set} />
      {signs && (
        <SettingsField label="Require signed commits" keywords="gpg signing signature"><label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300 sm:min-h-0">
          <input type="checkbox" checked={edit.requireSigned ?? i?.signing?.requireSigned ?? false} onChange={(e) => set("requireSigned", e.target.checked)} data-testid="identity-require-signed" />
          Stop a push when one of its commits isn't signed by this key
        </label></SettingsField>
      )}
      {i && !i.isDefault && (
        <div className="border-t border-zinc-800/80 pt-3">
          <Button type="button" size="sm" variant="danger" onClick={() => onEdit(() => ({ remove: true }))} data-testid="identity-delete">
            <Trash2 className="h-3.5 w-3.5" /> Delete identity
          </Button>
        </div>
      )}
    </div>
    </IdentityProblems.Provider>
  )
}

function TokenFields({ fid, identity: i, edit, onEdit }: { fid: (k: string) => string; identity: Identity | null; edit: IdentityEdit; onEdit: (fn: (prev: IdentityEdit) => IdentityEdit) => void }) {
  const removing = edit.removeTokens ?? []
  const toggle = (owner: string) =>
    onEdit((prev) => {
      const list = prev.removeTokens ?? []
      const next = list.includes(owner) ? list.filter((o) => o !== owner) : [...list, owner]
      return put(prev, "removeTokens", next.length ? next : undefined, null)
    })
  const setToken = (t: { owner: string; value: string }) => onEdit((prev) => put(prev, "token", (t.owner || t.value) ? t : undefined, null))
  return (
    <FormField
      id={fid("token")}
      label="GitHub token"
      hint="A token of the account it acts as (repo scope, or fine-grained with Contents and Pull requests). GitHub has to accept it, and every token of an identity is the same account. Import from this computer takes gh's instead."
    >
      {i?.tokens.map((t) => (
        <div key={t.owner} className={cx("flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs sm:min-h-9", removing.includes(t.owner) ? "border-red-500/30 bg-red-500/10 text-red-200 line-through" : "border-zinc-800 bg-zinc-900 text-zinc-300")}>
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate">
            {t.owner || "every owner"} · {t.login} · <code className="font-mono">{t.fingerprint}</code>
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => toggle(t.owner)}>
            {removing.includes(t.owner) ? "Keep" : "Remove"}
          </Button>
        </div>
      ))}
      <p className="text-xs text-zinc-500">Token owner: one GitHub user or org, like acme-corp. Blank: every owner. No repository or URL.</p>
      <div className="grid gap-2 @min-[30rem]:grid-cols-[10rem_minmax(0,1fr)]">
        <IdentityInput fid={fid} field="tokenOwner" className={inputClass} value={edit.token?.owner ?? ""} onChange={(e) => setToken({ owner: e.target.value, value: edit.token?.value ?? "" })} placeholder="every owner" aria-label="Token owner (blank: every owner)" spellCheck={false} />
        <IdentityInput fid={fid} field="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className={cx(inputClass, "font-mono")}
          value={edit.token?.value ?? ""}
          onChange={(e) => setToken({ owner: edit.token?.owner ?? "", value: e.target.value })}
          placeholder={i?.tokens.length ? "Paste a token to add or replace one" : "github_pat_… or ghp_…"}
          aria-label="GitHub token"
          data-testid="identity-token"
        />
      </div>
    </FormField>
  )
}

function ClaudeField({ fid, identity: i, edit, set }: { fid: (k: string) => string; identity: Identity | null; edit: IdentityEdit; set: <K extends keyof IdentityEdit>(k: K, v: IdentityEdit[K]) => void }) {
  const [kind, setKind] = useState<IdentityClaudeKind>(edit.claude?.kind ?? i?.claude?.kind ?? "oauth_token")
  const removing = edit.claude === null
  return (
    <FormField id={fid("claude")} label="Claude login" hint="Optional: its projects' agents use this instead of Settings' Claude login (another account or org).">
      {i?.claude && (
        <div className={cx("flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs sm:min-h-9", removing ? "border-red-500/30 bg-red-500/10 text-red-200 line-through" : "border-zinc-800 bg-zinc-900 text-zinc-300")}>
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate">
            {i.claude.kind === "api_key" ? "API key" : "OAuth token"} · <code className="font-mono">{i.claude.fingerprint}</code>
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => set("claude", removing ? undefined : null)}>
            {removing ? "Keep" : "Remove"}
          </Button>
        </div>
      )}
      {!removing && (
        <div className="grid gap-2 @min-[30rem]:grid-cols-[10rem_minmax(0,1fr)]">
          <Select
            className="w-full"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as IdentityClaudeKind
              setKind(k)
              if (edit.claude) set("claude", { kind: k, value: edit.claude.value })
            }}
            aria-label="Claude login kind"
          >
            <option value="oauth_token">OAuth token</option>
            <option value="api_key">API key</option>
          </Select>
          <IdentityInput fid={fid} field="claude"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={cx(inputClass, "font-mono")}
            value={edit.claude?.value ?? ""}
            onChange={(e) => set("claude", e.target.value.trim() ? { kind, value: e.target.value } : undefined)}
            placeholder={kind === "api_key" ? "sk-ant-api…" : "sk-ant-oat… (claude setup-token)"}
            aria-label="Claude login"
          />
        </div>
      )}
    </FormField>
  )
}

function SigningField({ fid, identity: i, edit, set }: { fid: (k: string) => string; identity: Identity | null; edit: IdentityEdit; set: <K extends keyof IdentityEdit>(k: K, v: IdentityEdit[K]) => void }) {
  const [mode, setMode] = useState<SigningDraft["kind"]>(edit.signing?.kind ?? i?.signing?.kind ?? "file")
  const [readError, setReadError] = useState<string | null>(null)
  const removing = edit.signing === null
  const pending = edit.signing ?? null
  return (
    <FormField
      id={fid("signing")}
      label="Signing key"
      hint="Sign commits with an SSH key or a GPG key in this computer’s keyring. Register the public key with the identity’s GitHub account so commits can show Verified. SSH key files go to the runners that use them; GPG keys stay here."
    >
      {i?.signing && (
        <div className={cx("flex min-h-11 items-center gap-2 rounded-lg border px-3 text-xs sm:min-h-9", removing ? "border-red-500/30 bg-red-500/10 text-red-200 line-through" : "border-zinc-800 bg-zinc-900 text-zinc-300")}>
          <Fingerprint className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1 truncate">
            <code className="font-mono">{i.signing.fingerprint}</code> · {i.signing.kind === "gpg" ? "GPG keyring" : i.signing.kind === "file" ? "key file" : "SSH agent"}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => set("signing", removing ? undefined : null)}>
            {removing ? "Keep" : "Remove"}
          </Button>
        </div>
      )}
      {!removing && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-300">
            {(["file", "agent", "gpg"] as const).map((m) => (
              <label key={m} className="flex min-h-11 items-center gap-2 sm:min-h-0">
                <input
                  type="radio"
                  name={fid("signing-mode")}
                  checked={mode === m}
                  onChange={() => {
                    setMode(m)
                    if (pending && pending.kind !== m) set("signing", undefined)
                  }}
                />
                {m === "file" ? "Key file (no passphrase)" : m === "gpg" ? "GPG keyring (this computer)" : "This computer's SSH agent or 1Password"}
              </label>
            ))}
          </div>
          {mode === "file" ? (
            <IdentityControl fid={fid} field="signing">{(check) => <div {...check} role="group" aria-label="Signing key file" tabIndex={-1} className="flex flex-wrap items-center gap-2">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700 sm:min-h-0 sm:py-1">
                <KeyRound className="h-3.5 w-3.5" /> {pending?.kind === "file" ? "Choose another file" : i?.signing ? "Replace with a key file…" : "Choose a key file…"}
                <input
                  id={fid("signing-file")}
                  type="file"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ""
                    if (!file) return
                    const text = await file.text()
                    if (!/PRIVATE KEY-----/.test(text)) return setReadError(`${file.name} isn't a private key file (pick the one without .pub).`)
                    setReadError(null)
                    set("signing", { kind: "file", privateKey: text, fileName: file.name })
                  }}
                  data-testid="identity-signing-file"
                />
              </label>
              {pending?.kind === "file" && (
                <span className="text-xs text-amber-300" data-testid="identity-signing-chosen">
                  {pending.fileName}: sent when you save
                </span>
              )}
            </div>}</IdentityControl>
          ) : mode === "gpg" ? (
            <div className="grid gap-2">
              <IdentityInput fid={fid} field="signing"
                className={cx(inputClass, "font-mono text-xs")}
                value={pending?.kind === "gpg" ? pending.keyId : ""}
                onChange={(e) => set("signing", e.target.value.trim() ? { kind: "gpg", keyId: e.target.value } : undefined)}
                placeholder="Key id or full fingerprint from gpg --list-secret-keys"
                aria-label="GPG key id or fingerprint"
                maxLength={66}
                pattern={GPG_KEY_ID_RE.source}
                title="Enter a hex key id (8 or 16 characters) or fingerprint (40 or 64 characters)."
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-zinc-500">Only a key id or fingerprint is saved. Never paste a private key or passphrase.</p>
              <p className="flex items-start gap-1.5 text-xs text-amber-300">
                <LineIcon icon={Laptop} className="h-3.5 w-3.5" /> Requires the local runner. Boxes, SSH, Docker and GPU runners cannot access this keyring. Unlock the key in gpg-agent before a turn; headless prompts fail after at most 15 seconds.
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              <IdentityInput fid={fid} field="signingPublicKey"
                className={cx(inputClass, "font-mono text-xs")}
                value={pending?.kind === "agent" ? pending.publicKey : ""}
                onChange={(e) => set("signing", e.target.value.trim() ? { kind: "agent", publicKey: e.target.value, program: pending?.kind === "agent" ? pending.program : "" } : undefined)}
                placeholder="ssh-ed25519 AAAA… (the public key)"
                aria-label="Public key"
                spellCheck={false}
              />
              <IdentityInput fid={fid} field="signingProgram"
                className={cx(inputClass, "font-mono text-xs")}
                value={pending?.kind === "agent" ? pending.program : ""}
                disabled={pending?.kind !== "agent"}
                onChange={(e) => pending?.kind === "agent" && set("signing", { ...pending, program: e.target.value })}
                placeholder="/Applications/1Password.app/Contents/MacOS/op-ssh-sign (blank: ssh-keygen)"
                aria-label="Signing program"
                spellCheck={false}
              />
              <p className="flex items-start gap-1.5 text-xs text-zinc-500">
                <LineIcon icon={Laptop} className="h-3.5 w-3.5" /> Only this computer can sign with it, so its projects run here.
              </p>
            </div>
          )}
          {readError && <p className="text-xs text-red-300">{readError}</p>}
        </>
      )}
    </FormField>
  )
}

// ------------------------------------------------------------------ Import from this computer

function ImportFromComputer({ fid, identities, projects }: { fid: (k: string) => string; identities: Identity[]; projects: Map<string, Project> }) {
  const detect = useDetectIdentities()
  const [online, setOnline] = useState(true)
  const [log, setLog] = useState<string[]>([])
  const [picked, setPicked] = useDraft<Record<string, string[]>>(
    "identities-import",
    "identities",
    NO_IMPORT,
    async (draft) => {
      const done: string[] = []
      try {
        for (const [login, ids] of Object.entries(draft)) {
          try {
            const r = await identityApi.importDetected({ login, projects: ids })
            done.push(...r.lines)
          } catch (err) {
            throw named(login, err)
          }
          setPicked((prev) => Object.fromEntries(Object.entries(prev).filter(([l]) => l !== login)))
        }
      } finally {
        setLog(done)
      }
    },
    (d) => Object.keys(d).length,
  )
  const d = detect.data
  return (
    <SettingsField label="Import identities" keywords="detect accounts signing gpg"><section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4" aria-labelledby={fid("import")} data-testid="identity-import">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={fid("import")} className="text-sm font-semibold text-zinc-100">
          Import from this computer
        </h4>
        <Button type="button" size="sm" variant="primary" className="ml-auto" loading={detect.isPending} onClick={() => detect.mutate(online)} data-testid="identity-detect">
          <ScanSearch className="h-3.5 w-3.5" /> {d ? "Detect again" : "Detect"}
        </Button>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        Reads the accounts gh is signed in to, your git authors (global and each includeIf folder), their signing keys and ~/.ssh/config, and proposes an identity per account with the projects it fits. Nothing changes until you tick one and save; Box Yard reads the token and key itself, so they
        never pass through this page.
      </p>
      <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-zinc-400 sm:min-h-0">
        <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} />
        Ask GitHub too (each account's orgs, verified emails, keys and push access, with its own token)
      </label>
      {detect.error && <p className="mt-2 text-xs text-red-300">{detect.error instanceof ApiError ? detect.error.message : "Couldn't detect."}</p>}
      {log.length > 0 && (
        <ul className="mt-3 space-y-0.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200" data-testid="identity-import-log">
          {log.map((l, n) => (
            <li key={n} className="flex items-start gap-1.5">
              <LineIcon icon={Check} className="h-3.5 w-3.5" />
              {l}
            </li>
          ))}
        </ul>
      )}
      {d && <Detection detection={d} identities={identities} projects={projects} picked={picked} setPicked={setPicked} />}
    </section></SettingsField>
  )
}

function Detection({
  detection: d,
  identities,
  projects,
  picked,
  setPicked,
}: {
  detection: IdentityDetection
  identities: Identity[]
  projects: Map<string, Project>
  picked: Record<string, string[]>
  setPicked: (fn: (prev: Record<string, string[]>) => Record<string, string[]>) => void
}) {
  const toggle = (p: IdentityProposal, on: boolean) =>
    setPicked((prev) => {
      const { [p.login]: _gone, ...rest } = prev
      return on ? { ...rest, [p.login]: p.projects.map((x) => x.id) } : rest
    })
  const toggleProject = (login: string, id: string, on: boolean) => setPicked((prev) => ({ ...prev, [login]: on ? [...(prev[login] ?? []), id] : (prev[login] ?? []).filter((x) => x !== id) }))
  return (
    <div className="mt-3 space-y-3 text-xs">
      <p className="text-zinc-500">
        Read <TimeAgo ts={d.at} />, {d.online ? "with GitHub" : "this computer only"}: {d.accounts.length} gh account{d.accounts.length === 1 ? "" : "s"}, {d.authors.length} git author{d.authors.length === 1 ? "" : "s"}.
      </p>
      {d.proposals.length === 0 && <p className="text-zinc-400">Nothing to import: gh isn't signed in to an account Box Yard could use.</p>}
      {d.proposals.map((p) => {
        const on = p.login in picked
        // Looked up now: an import since the detection made one.
        const existing = identities.find((i) => (p.existing ? i.id === p.existing.id : !i.isDefault && i.githubLogin?.toLowerCase() === p.login.toLowerCase()))
        return (
          <div key={p.login} className={cx("@container rounded-lg border p-3", on ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800")} data-proposal={p.login}>
            <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
              <input type="checkbox" checked={on} onChange={(e) => toggle(p, e.target.checked)} data-testid={`import-${p.login}`} />
              <span className="font-mono text-sm text-zinc-100">{p.login}</span>
              {existing ? <span className="text-zinc-400">updates the {existing.name} identity</span> : <span className="text-zinc-400">a new identity</span>}
              {on && <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">imported when you save</span>}
            </label>
            <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 @min-[26rem]:grid-cols-[6rem_minmax(0,1fr)]">
              <Fact label="Owners">{p.owners.length ? p.owners.join(", ") : <Muted>none found</Muted>}</Fact>
              <Fact label="Author">{p.author ? `${p.author.name} <${p.author.email}> (${p.author.from})` : <Muted>none found: Settings' git author</Muted>}</Fact>
              <Fact label="Signing">
                {p.signing?.fingerprint ? (
                  <>
                    <code className="font-mono text-zinc-300">{p.signing.fingerprint}</code> · {p.signing.kind === "gpg" ? "GPG keyring: local runner only" : p.signing.kind === "agent" ? "SSH agent: its projects run on this computer" : "key file"}
                    {p.signing.warning && <span className="block text-amber-300">Left out: {p.signing.warning}</span>}
                    {p.signing.problem && <span className="block text-amber-300">{p.signing.problem}</span>}
                  </>
                ) : (
                  <Muted>no signing key</Muted>
                )}
              </Fact>
              <Fact label="Projects">
                {p.projects.length ? (
                  p.projects.map((x) => (
                    <label key={x.id} className="flex min-h-11 items-start gap-2 sm:min-h-0">
                      <input type="checkbox" className="mt-0.5" disabled={!on} checked={on && (picked[p.login] ?? []).includes(x.id)} onChange={(e) => toggleProject(p.login, x.id, e.target.checked)} />
                      <span>
                        <span className="text-zinc-200">{projects.get(x.id)?.name ?? x.name}</span> <Muted>· {x.why}</Muted>
                        {existing && projects.get(x.id)?.identityId === existing.id && <Muted> · uses {existing.name} already</Muted>}
                      </span>
                    </label>
                  ))
                ) : (
                  <Muted>{p.isDefaultToday ? "none to move: the Default identity is this account already" : "none fits it"}</Muted>
                )}
              </Fact>
            </dl>
            {p.evidence.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">Why: {p.evidence.length} clue{p.evidence.length === 1 ? "" : "s"}</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-400">
                  {p.evidence.map((e, n) => (
                    <li key={n}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )
      })}
      {d.unmatched.length > 0 && <p className="text-zinc-500">Stay where they are (no account here clearly owns them): {d.unmatched.map((x) => x.name).join(", ")}.</p>}
      {d.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-zinc-500">
          {d.notes.map((n, k) => (
            <li key={k}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ small pieces

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-zinc-300 wrap-anywhere">{children}</dd>
    </>
  )
}

type IdentityControlProps = { id: string; "data-identity-field": string; "aria-invalid"?: true; "aria-describedby"?: string }
function IdentityControl({ fid, field, children }: { fid: (k: string) => string; field: string; children: (props: IdentityControlProps) => ReactNode }) {
  const problem = useContext(IdentityProblems).find((p) => p.field === field)
  const id = fid(field)
  return (
    <div className="min-w-0 space-y-1.5">
      {children({ id, "data-identity-field": field, "aria-invalid": problem ? true : undefined, "aria-describedby": problem ? `${id}-error` : undefined })}
      {problem && <p id={`${id}-error`} data-settings-search-ignore className="text-xs leading-relaxed text-red-300">{problem.message}</p>}
    </div>
  )
}
function IdentityInput({ fid, field, ...props }: InputHTMLAttributes<HTMLInputElement> & { fid: (k: string) => string; field: string }) {
  return <IdentityControl fid={fid} field={field}>{(check) => <input {...props} {...check} />}</IdentityControl>
}

const Muted = ({ children }: { children: ReactNode }) => <span className="text-zinc-500">{children}</span>

function FormField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <SettingsField label={label} className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium tracking-wide text-zinc-400 uppercase">
        <SearchHighlight text={label} />
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-zinc-500"><SearchHighlight text={hint} /></p>}
    </SettingsField>
  )
}

function EmailCheck({ check, login }: { check: "verified" | "unverified" | "unknown"; login: string | null }) {
  if (check === "verified") return <span className="text-emerald-400">· verified on {login}</span>
  if (check === "unverified") return <span className="text-amber-300">· not one of {login}'s verified emails: GitHub won't link its commits</span>
  return <Muted>· not checked yet (Test)</Muted>
}

function CheckLines({ result }: { result: { at: number; ok: boolean; lines: string[] } }) {
  return (
    <div className={cx("mt-3 rounded-lg border px-3 py-2 text-xs", result.ok ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5")} data-identity-check={result.ok ? "ok" : "problem"}>
      <p className={cx("font-medium", result.ok ? "text-emerald-300" : "text-amber-200")}>
        {result.ok ? "Last test passed" : "Last test found problems"} · <TimeAgo ts={result.at} />
      </p>
      <ul className="mt-1 space-y-0.5 text-zinc-300">
        {result.lines.map((l, n) => (
          <li key={n} className="wrap-anywhere">
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}
