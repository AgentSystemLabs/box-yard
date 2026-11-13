// Settings › Coordinator › Env vars: the Coordinator's own env vars, like a project's. Names come back from the server,
// values never do: a saved one shows as its name, with Remove; a new one is a name and a masked value. A Claude token
// here (the strongest of CLAUDE_CREDENTIAL_VARS) is the Coordinator's Claude login from its next run, over the
// rotation's and Settings › Credentials' (server/coordinatorEnv.ts). Like every Settings field, it's a draft until Save.
import { useId } from "react"
import { KeyRound, Undo2, X } from "lucide-react"
import { useCoordinatorEnv, useSaveCoordinatorEnv } from "../lib/queries"
import { SettingsFieldError, useDraft } from "../lib/settingsDraft"
import { CLAUDE_CREDENTIAL_VARS } from "../../../shared/identities"
import type { CoordinatorEnvInfo } from "../../../shared/types"
import { Loading } from "./Loading"
import { NO_AUTOFILL, SecretInput } from "./SecretInput"
import { Row, SettingsLink } from "./SettingsBlocks"
import { Button, cx, inputClass } from "./ui"

/** What Save writes: a new (or replaced) var, and the saved ones to remove. */
export interface CoordinatorEnvDraft {
  name: string
  value: string
  remove: string[]
}

const NONE: CoordinatorEnvDraft = { name: "", value: "", remove: [] }
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** "N unsaved changes": each removal, and the new var once either half of it is typed. */
export function envDraftChanges(d: CoordinatorEnvDraft): number {
  return d.remove.length + (d.name.trim() || d.value.trim() ? 1 : 0)
}

/** Why Save can't write the new var yet, or null. */
export function envDraftProblem(d: CoordinatorEnvDraft): { field: "name" | "value"; message: string } | null {
  const name = d.name.trim()
  if (!name && !d.value.trim()) return null
  if (!name) return { field: "name", message: "Give the env var a name, like CLAUDE_CODE_OAUTH_TOKEN" }
  if (!ENV_NAME.test(name)) return { field: "name", message: "Env var names must be like MY_VAR" }
  if (name.toUpperCase().startsWith("BOXYARD_")) return { field: "name", message: "BOXYARD_* vars are Box Yard's own: the Coordinator never gets them" }
  if (!d.value.trim()) return { field: "value", message: `Give ${name} a value` }
  return null
}

/** The Claude credential the Coordinator logs in with once `d` is saved: the strongest one left, as the server picks it. */
export function envClaudeLogin(keys: string[], d: CoordinatorEnvDraft): string | null {
  const name = d.name.trim()
  const after = new Set([...keys.filter((k) => !d.remove.includes(k)), ...(name && d.value.trim() ? [name] : [])])
  return CLAUDE_CREDENTIAL_VARS.find((k) => after.has(k)) ?? null
}

/** The Coordinator's env vars row, for the Coordinator panel. `codex`: it runs on Codex now, which they don't reach. */
export function CoordinatorEnvRow({ fid, codex }: { fid: (k: string) => string; codex: boolean }) {
  const env = useCoordinatorEnv()
  const save = useSaveCoordinatorEnv()
  const id = fid("cenv")
  const valueId = fid("cenv-value")
  const [draft, setDraft, dirty] = useDraft<CoordinatorEnvDraft>(
    "coordinator-env",
    "orchestrator",
    NONE,
    async (d) => {
      const name = d.name.trim()
      await save.mutateAsync({ ...(name ? { env: { [name]: d.value.trim() } } : {}), ...(d.remove.length ? { removeEnv: d.remove } : {}) })
    },
    envDraftChanges,
    (d) => {
      const problem = envDraftProblem(d)
      if (problem) throw new SettingsFieldError(problem.message, "orchestrator", problem.field === "name" ? id : valueId)
    },
  )
  return (
    <Row
      id={id}
      label="Env vars"
      help={<>The Coordinator’s own env vars, like a project’s. A Claude token here picks the Claude subscription it runs on, from its next run.</>}
      more={
        <>
          Its <code>claude</code> runs and side threads get every var here. A Claude token ({CLAUDE_CREDENTIAL_VARS.join(", ")}; the first one set wins, like a task’s) logs it in instead of a rotation login or <SettingsLink section="credentials">Settings › Credentials</SettingsLink>. Values are write-only: they never come back to this page and are redacted from transcripts. Codex runs don’t get them.
        </>
      }
      changed={dirty}
      wide
    >
      {env.data ? (
        <CoordinatorEnvEditor info={env.data} id={id} valueId={valueId} codex={codex} draft={draft} setDraft={setDraft} dirty={dirty} error={save.error} />
      ) : env.isError ? (
        <p className="text-xs text-red-300">Couldn’t load the Coordinator’s env vars: {env.error.message}</p>
      ) : (
        <Loading kind="field" label="Loading the Coordinator’s env vars" />
      )}
    </Row>
  )
}

function CoordinatorEnvEditor({
  info,
  id,
  valueId,
  codex,
  draft,
  setDraft,
  dirty,
  error,
}: {
  info: CoordinatorEnvInfo
  id: string
  valueId: string
  codex: boolean
  draft: CoordinatorEnvDraft
  setDraft: (next: (prev: CoordinatorEnvDraft) => CoordinatorEnvDraft) => void
  dirty: boolean
  error: Error | null
}) {
  const listId = useId()
  const set = (patch: Partial<CoordinatorEnvDraft>) => setDraft((prev) => ({ ...prev, ...patch }))
  const toggle = (k: string) => setDraft((prev) => ({ ...prev, remove: prev.remove.includes(k) ? prev.remove.filter((x) => x !== k) : [...prev.remove, k] }))
  const name = draft.name.trim()
  const replacing = name && info.keys.includes(name) && !draft.remove.includes(name)
  const login = envClaudeLogin(info.keys, draft)
  const problem = envDraftProblem(draft)

  return (
    <div className="space-y-2" data-testid="coordinator-env">
      {info.keys.length > 0 && (
        <ul aria-label="Its env vars" className="space-y-1.5">
          {info.keys.map((k) => {
            const removing = draft.remove.includes(k)
            return (
              <li
                key={k}
                data-env-key={k}
                className={cx(
                  "flex min-h-11 items-center gap-2 rounded-lg border py-0.5 pr-1 pl-3 text-xs sm:min-h-9",
                  removing ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-zinc-800 bg-zinc-900 text-zinc-300",
                )}
              >
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                {/* A long name wraps rather than hiding its end on a phone: it's all there is to tell two vars apart. */}
                <code className={cx("min-w-0 flex-1 font-mono wrap-anywhere", removing && "line-through")}>
                  {k}
                </code>
                {removing ? (
                  <span className="shrink-0 text-[11px] text-red-300">removed on Save</span>
                ) : (
                  k === info.claudeLogin && <span className="shrink-0 rounded bg-yard-500/15 px-1.5 py-px text-[11px] text-yard-300">Claude login</span>
                )}
                <Button type="button" size="sm" variant="ghost" onClick={() => toggle(k)} aria-label={removing ? `Keep ${k}` : `Remove ${k}`} title={removing ? `Keep ${k}` : `Remove ${k} on Save`}>
                  {removing ? <Undo2 className="h-3.5 w-3.5" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
                  {/* On a phone the icon and its name (aria-label) carry it, so the var's name keeps the room. */}
                  <span className="@max-[26rem]:hidden">{removing ? "Keep" : "Remove"}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {/* The name field is the row's control (its label points here); the value is masked, and never comes back. */}
      <div className="grid gap-2 @min-[30rem]:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <input
          id={id}
          className={cx(inputClass, "font-mono")}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          // Short, so it fits a phone's wider type; the list (focus, or ↓) offers the Claude vars.
          placeholder="VAR_NAME"
          aria-label="New env var name"
          aria-invalid={problem?.field === "name" || undefined}
          list={listId}
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          {...NO_AUTOFILL}
          data-testid="coordinator-env-name"
        />
        <datalist id={listId}>
          {CLAUDE_CREDENTIAL_VARS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <SecretInput
          id={valueId}
          className={cx(inputClass, "font-mono")}
          value={draft.value}
          onChange={(e) => set({ value: e.target.value })}
          placeholder={replacing ? `New value for ${name}` : "Its value"}
          aria-label={name ? `${name} value` : "New env var value"}
          aria-invalid={problem?.field === "value" || undefined}
          data-testid="coordinator-env-value"
        />
      </div>
      <div aria-live="polite" className="space-y-1 text-xs leading-relaxed">
        {dirty && problem && (
          <p className="text-amber-300" data-testid="coordinator-env-problem">
            {problem.message}.
          </p>
        )}
        {replacing && <p className="text-zinc-400">Save replaces the saved {name}.</p>}
        <p className="text-zinc-500" data-testid="coordinator-env-login">
          {login ? (
            <>
              {dirty ? "Once saved, it" : "It"} logs in with <code className="font-mono text-zinc-300">{login}</code> from here, from its next run.
            </>
          ) : (
            <>
              {dirty ? "Once saved, no" : "No"} Claude token here: it logs in with a rotation login or <SettingsLink section="credentials">Settings › Credentials</SettingsLink>.
            </>
          )}
          {codex && " It runs on Codex now, which doesn’t get these."}
        </p>
        {error && <p role="alert" className="text-red-300 wrap-anywhere">{error.message}</p>}
      </div>
    </div>
  )
}
