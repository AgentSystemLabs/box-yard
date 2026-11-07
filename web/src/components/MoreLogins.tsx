// Settings › Credentials › More Claude logins / More Codex logins (docs/logins.md): the subscription logins new sessions
// take in turn with the login above, round robin. A value goes in once and never comes back: each login shows only
// its label, its last 4 characters and how it's doing.
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Check, KeyRound, Pencil, Play, Plus, Undo2, X } from "lucide-react"
import { useLoginChanges, useLogins, useTestLogin } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { runDayTime } from "../lib/scheduleText"
import { Button, LineIcon, TimeAgo, cx, inputClass } from "./ui"
import { Loading } from "./Loading"
import { LoginLimitsLine } from "./LoginLimits"
import { SourceHint } from "./SettingsBlocks"
import { LOGIN_LABEL_MAX, type AgentLogin, type LoginHarness } from "../../../shared/agentLogins"

type TestState = { state: "running" } | { state: "ok" | "error"; text: string }

const HARNESS_NAME: Record<LoginHarness, string> = { claude: "Claude", codex: "Codex" }

const VALUE_PLACEHOLDER: Record<LoginHarness, string> = {
  claude: "sk-ant-oat01-… (from claude setup-token)",
  codex: '{"auth_mode":"chatgpt","tokens":{…}} (all of auth.json)',
}

/** A harness's logins in the rotation (Settings › Credentials' own first), and a form to add one. */
export function MoreLogins({ harness, id }: { harness: LoginHarness; id: string }) {
  const logins = useLogins()
  if (!logins.data) return <Loading kind="rows" count={1} label={`Loading the ${HARNESS_NAME[harness]} logins`} />
  const list = logins.data.filter((l) => l.harness === harness)
  return (
    <div className="space-y-2" data-logins={harness}>
      {list.length > 0 && (
        <ul className="space-y-2" aria-label={`${HARNESS_NAME[harness]} logins in the rotation`}>
          {list.map((l) => (
            <LoginRow key={l.id} login={l} />
          ))}
        </ul>
      )}
      {list.length === 1 && list[0]!.source === "credentials" && (
        <p className="text-xs leading-relaxed text-zinc-500">Only the login above so far. Add another and new sessions take them in turn.</p>
      )}
      <AddLogin harness={harness} id={id} />
    </div>
  )
}

/** Why the rotation skips it now, as a chip; nothing when it's taking work. */
function LoginState({ login }: { login: AgentLogin }) {
  const chip = "rounded px-1.5 py-px text-[11px] whitespace-nowrap"
  if (!login.readable) return <span className={cx(chip, "bg-red-500/15 text-red-300")} title="This server's secret key can't read it. Remove it and add it again.">Can't read</span>
  if (login.state === "auth_failed") return <span className={cx(chip, "bg-red-500/15 text-red-300")} title={login.stateReason ?? undefined}>Signed out</span>
  if (login.state === "limited" && login.limitedUntil && login.limitedUntil > Date.now()) {
    const back = runDayTime(login.limitedUntil, Intl.DateTimeFormat().resolvedOptions().timeZone, Date.now())
    return (
      <span className={cx(chip, "bg-amber-500/15 text-amber-300")} title={login.stateReason ?? undefined}>
        At its limit · back {back}
      </span>
    )
  }
  return null
}

function LoginRow({ login }: { login: AgentLogin }) {
  const added = login.source === "added"
  const changes = useLoginChanges()
  const test = useTestLogin()
  // In Settings: a new label or a removal, waiting for the dialog's Save.
  const [draft, setDraft, dirty] = useDraft(`login-${login.id}`, "credentials", { label: login.label, removed: false }, async (d) => {
    if (d.removed) return changes.remove(login.id)
    const label = d.label.trim()
    if (label && label !== login.label) await changes.rename(login.id, label)
    setRenaming(false)
  })
  const [renaming, setRenaming] = useState(false)
  const [result, setResult] = useState<TestState | null>(null)
  const runTest = () => {
    setResult({ state: "running" })
    test.mutate(
      { id: login.id },
      {
        onSuccess: (r) => setResult({ state: r.ok ? "ok" : "error", text: r.text }),
        onError: (err) => setResult({ state: "error", text: err.message }),
      },
    )
  }
  const keep = () => {
    setDraft({ label: login.label, removed: false })
    setRenaming(false)
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      keep()
    }
  }
  return (
    <li className={cx("rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2", draft.removed && "border-amber-500/30 bg-amber-500/10")} data-login={login.id}>
      <div className="flex items-start gap-2">
        <LineIcon icon={KeyRound} className="h-3.5 w-3.5 text-zinc-500" />
        <div className="min-w-0 flex-1 space-y-1">
          {renaming && !draft.removed ? (
            <input
              className={cx(inputClass, "py-1")}
              autoFocus
              maxLength={LOGIN_LABEL_MAX}
              aria-label="Login name"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              onKeyDown={onKey}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className={cx("min-w-0 truncate text-zinc-200", draft.removed && "line-through")}>{draft.label.trim() || login.label}</span>
              {login.last4 && <span className="font-mono text-xs text-zinc-500" aria-label={`ending in ${login.last4}`}>…{login.last4}</span>}
              <LoginState login={login} />
            </div>
          )}
          <p className="text-xs text-zinc-500">
            {draft.removed ? (
              "Removed when you save."
            ) : (
              <>
                {added ? "Added" : "The login above"}
                {" · "}
                {login.lastUsedAt ? (
                  <>
                    last used <TimeAgo ts={login.lastUsedAt} />
                  </>
                ) : (
                  "not used yet"
                )}
              </>
            )}
          </p>
          {/* Its 5-hour and weekly windows as its last run read them (Settings' own login has its line above). */}
          {added && !draft.removed && <LoginLimitsLine scope={`login:${login.id}`} harness={login.harness} />}
        </div>
        {dirty && <SourceHint changed />}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {draft.removed ? (
          <Button type="button" size="sm" variant="ghost" onClick={keep}>
            <Undo2 className="h-3.5 w-3.5" /> Keep it
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" variant="ghost" loading={result?.state === "running"} disabled={!login.readable} onClick={runTest} title="Check this login now">
              <Play className="h-3.5 w-3.5" /> Test
            </Button>
            {added && !renaming && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                <Pencil className="h-3.5 w-3.5" /> Rename
              </Button>
            )}
            {added && (
              <Button type="button" size="sm" variant="danger" onClick={() => (setDraft({ label: login.label, removed: true }), setRenaming(false), setResult(null))} title={`Forget ${login.label} when you save`}>
                Remove
              </Button>
            )}
          </>
        )}
      </div>
      <div aria-live="polite">{result && result.state !== "running" && <ResultLine ok={result.state === "ok"} text={result.text} />}</div>
    </li>
  )
}

/** "Add a login": a name and the token or auth.json, added by the dialog's Save. Test checks the typed value first. */
function AddLogin({ harness, id }: { harness: LoginHarness; id: string }) {
  const changes = useLoginChanges()
  const test = useTestLogin()
  // Open with nothing pasted yet isn't a change to save.
  const [draft, setDraft] = useDraft<{ label: string; value: string } | null>(
    `login-add-${harness}`,
    "credentials",
    null,
    async (d) => {
      if (d?.value.trim()) await changes.add({ harness, label: d.label.trim() || `${HARNESS_NAME[harness]} login`, value: d.value.trim() })
    },
    (d) => (d?.value.trim() ? 1 : 0),
  )
  const [result, setResult] = useState<TestState | null>(null)
  if (!draft)
    return (
      // The Row's label points here for Settings search; its own name says what it does.
      <Button type="button" size="sm" id={id} aria-label={`Add a ${HARNESS_NAME[harness]} login`} onClick={() => (setDraft({ label: "", value: "" }), setResult(null))}>
        <Plus className="h-3.5 w-3.5" /> Add a {HARNESS_NAME[harness]} login
      </Button>
    )
  const runTest = () => {
    setResult({ state: "running" })
    test.mutate(
      { harness, value: draft.value.trim() },
      {
        onSuccess: (r) => setResult({ state: r.ok ? "ok" : "error", text: r.text }),
        onError: (err) => setResult({ state: "error", text: err.message }),
      },
    )
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      setDraft(null)
    }
  }
  const valueProps = {
    autoComplete: "off",
    spellCheck: false,
    placeholder: VALUE_PLACEHOLDER[harness],
    value: draft.value,
    onChange: (e: { target: { value: string } }) => {
      setDraft({ ...draft, value: e.target.value })
      if (result?.state !== "running") setResult(null)
    },
    onKeyDown: onKey,
    "aria-label": harness === "claude" ? "Claude subscription token" : "Codex auth.json",
  }
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-2" data-login-add={harness}>
      <input
        id={id}
        className={inputClass}
        autoFocus
        maxLength={LOGIN_LABEL_MAX}
        placeholder={harness === "claude" ? "Name, e.g. Work Max" : "Name, e.g. Team ChatGPT"}
        aria-label="Login name"
        value={draft.label}
        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        onKeyDown={onKey}
      />
      {harness === "codex" ? (
        <textarea {...valueProps} rows={4} className={cx(inputClass, "min-h-24 resize-y font-mono text-xs leading-5")} />
      ) : (
        <input {...valueProps} type="password" className={cx(inputClass, "font-mono")} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="ghost" loading={result?.state === "running"} disabled={!draft.value.trim()} onClick={runTest} title="Check the login you pasted, without adding it">
          <Play className="h-3.5 w-3.5" /> Test
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
          Cancel
        </Button>
        {draft.value.trim() && <span className="text-xs text-zinc-500">Added when you save.</span>}
      </div>
      <div aria-live="polite">{result && result.state !== "running" && <ResultLine ok={result.state === "ok"} text={result.text} />}</div>
    </div>
  )
}

function ResultLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={cx("mt-1 flex items-start gap-1.5 text-xs leading-relaxed wrap-anywhere", ok ? "text-emerald-400" : "text-red-300")} data-login-test={ok ? "ok" : "error"}>
      <LineIcon icon={ok ? Check : X} className="h-3.5 w-3.5" />
      {text}
    </p>
  )
}
