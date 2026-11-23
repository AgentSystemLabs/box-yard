// Settings › Credentials: every key the agents use, with the login rotations (More logins) and each login's limits.
// Apart from Setup.tsx, so the first-run card's chunk carries neither.
import { useAgentSettings, useSaveSettings, useSetup } from "../lib/queries"
import { useDraft } from "../lib/settingsDraft"
import { CODEX_LOGIN_COMMAND, CREDENTIAL_INFO, FALLBACK_GIT_AUTHOR, SETUP_TOKEN_COMMAND } from "../../../shared/setup"
import type { LoginHarness } from "../../../shared/agentLogins"
import { AuthorFallbackNotice, CODEX_BOTH, CredentialField, CredentialHelp, UNSET } from "./Setup"
import { LoginLimitsLine } from "./LoginLimits"
import { MoreLogins } from "./MoreLogins"
import { Panel, Row, SourceHint } from "./SettingsBlocks"
import { Loading } from "./Loading"
import { inputClass } from "./ui"

/** Settings › Credentials › More logins: what the rotation does, and how to make another login. */
function MoreLoginsHelp({ harness }: { harness: LoginHarness }) {
  if (harness === "claude")
    return (
      <>
        Several Claude Pro or Max subscriptions: new sessions take these and the token above in turn, round robin, so no one plan runs out first. A session keeps its login for an hour between turns,
        while its prompt cache is warm. A login that's signed out or at its usage limit sits out until it works again or the limit resets, and a turn it stopped runs again on the next one. Make a
        token on each account with <span className="font-mono">{SETUP_TOKEN_COMMAND}</span>. A project identity's own Claude login always wins.
      </>
    )
  return (
    <>
      Several ChatGPT plans for agents on Codex: new sessions take these and the login above in turn, round robin. A Codex session stays on the account that started it, since its saved turns only
      open there. To log in to another account without signing out here, run <span className="font-mono">CODEX_HOME=$(mktemp -d) {CODEX_LOGIN_COMMAND}</span> and paste the auth.json it writes in
      that folder.
    </>
  )
}

/** Settings › Credentials › Git author: GIT_USER_NAME / GIT_USER_EMAIL, a draft until the dialog's Save. */
function GitAuthorField({ id }: { id: string }) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const saved = { name: info.data?.settings.gitUserName ?? "", email: info.data?.settings.gitUserEmail ?? "" }
  const [value, set, dirty] = useDraft("git-author", "credentials", saved, (d) => {
    const name = d.name.trim()
    const email = d.email.trim()
    if (Boolean(name) !== Boolean(email)) throw new Error("A git author needs both a name and an email, or neither.")
    return save.mutateAsync({ gitUserName: name, gitUserEmail: email })
  })
  return (
    <div className="space-y-2">
      <input
        id={id}
        className={inputClass}
        placeholder="Name"
        value={value.name}
        maxLength={200}
        onChange={(e) => set((p) => ({ ...p, name: e.target.value }))}
        aria-label="Git author name"
        data-testid="git-author-name"
      />
      <input
        type="email"
        className={inputClass}
        placeholder="Email"
        value={value.email}
        maxLength={320}
        onChange={(e) => set((p) => ({ ...p, email: e.target.value }))}
        aria-label="Git author email"
        data-testid="git-author-email"
      />
      <SourceHint source={info.data?.sources.gitUserName} env="GIT_USER_NAME" changed={dirty} />
    </div>
  )
}

export function CredentialsPanel({ fid }: { fid: (k: string) => string }) {
  const setup = useSetup()
  const s = setup.data
  return (
    <Panel section="credentials">
      {!s ? (
        <Loading label="Loading credentials" />
      ) : (
        <>
          <AuthorFallbackNotice status={s} />
          {s.mock && <p className="mb-4 text-xs text-zinc-500">Mock mode: nothing here is needed, and nothing calls a real service.</p>}
          {(["claudeOauthToken", "anthropicApiKey", "githubToken"] as const).map((k) => (
            <Row key={k} id={fid(`cred-${k}`)} label={CREDENTIAL_INFO[k].label} help={<CredentialHelp k={k} />}>
              <CredentialField k={k} status={s.credentials[k]} id={fid(`cred-${k}`)} />
            </Row>
          ))}
          {s.credentials.claudeOauthToken.state === "set" && s.credentials.anthropicApiKey.state === "set" && (
            <p className="mt-2 text-xs text-zinc-500">Both Claude credentials are set, so Claude Code uses the API key.</p>
          )}
          <LoginLimitsLine scope="settings" harness="claude" className="mt-2" />
          <Row id={fid("logins-claude")} label="More Claude logins" help={<MoreLoginsHelp harness="claude" />}>
            <MoreLogins harness="claude" id={fid("logins-claude")} />
          </Row>
          <Row
            id={fid("git-author")}
            label="Git author"
            help={
              <>
                Who commits are by when a project's identity names no author. Blank: on this computer, your own git config (user.name, user.email, and its signing when commit.gpgsign is on); on boxes and GPU pods, the
                GitHub account behind the token, with its noreply email. Only when none of those is there do commits go out as {FALLBACK_GIT_AUTHOR.name}, and this page says so.
              </>
            }
          >
            <GitAuthorField id={fid("git-author")} />
          </Row>
          <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Codex</h4>
          <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500" data-testid="codex-credentials-intro">
            {s.codex?.required
              ? "The Coordinator runs on Codex, so it needs one of these."
              : "Only for agents set to run on Codex: the Coordinator, the Captains or a project's agents."}{" "}
            {s.local?.codexLogin === true && "Agents on this computer can use its codex login; boxes and containers need one of these."}
          </p>
          {(["codexAuthJson", "codexApiKey"] as const).map((k) => (
            <Row key={k} id={fid(`cred-${k}`)} label={CREDENTIAL_INFO[k].label} help={<CredentialHelp k={k} />}>
              <CredentialField k={k} status={s.credentials[k] ?? UNSET} id={fid(`cred-${k}`)} />
            </Row>
          ))}
          {s.credentials.codexAuthJson?.state === "set" && s.credentials.codexApiKey?.state === "set" && (
            <p className="mt-2 text-xs text-zinc-500" data-testid="codex-both">
              {CODEX_BOTH}
            </p>
          )}
          <LoginLimitsLine scope="settings" harness="codex" className="mt-2" />
          <Row id={fid("logins-codex")} label="More Codex logins" help={<MoreLoginsHelp harness="codex" />}>
            <MoreLogins harness="codex" id={fid("logins-codex")} />
          </Row>
          <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Cursor</h4>
          <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500" data-testid="cursor-credentials-intro">
            Only for agents set to run on Cursor (a project's Agent, or Settings › Box agents). {s.local?.cursorLogin === true ? "Agents on this computer can use its cursor-agent login; boxes and containers need this key." : "Boxes and containers need this key."}
          </p>
          <Row id={fid("cred-cursorApiKey")} label={CREDENTIAL_INFO.cursorApiKey.label} help={<CredentialHelp k="cursorApiKey" />}>
            <CredentialField k="cursorApiKey" status={s.credentials.cursorApiKey ?? UNSET} id={fid("cred-cursorApiKey")} />
          </Row>
          <h4 className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">OpenCode</h4>
          <p className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">Task agents on OpenCode 1.19.5 use provider API logins. OAuth and manager chats are not supported. Test validates the JSON format without contacting a model provider.</p>
          <Row id={fid("cred-opencodeAuthJson")} label={CREDENTIAL_INFO.opencodeAuthJson.label} help={<CredentialHelp k="opencodeAuthJson" />}>
            <CredentialField k="opencodeAuthJson" status={s.credentials.opencodeAuthJson ?? UNSET} id={fid("cred-opencodeAuthJson")} />
          </Row>
          {s.restart.map((r) => (
            <p key={r} className="mt-4 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">
              {r}
            </p>
          ))}
        </>
      )}
    </Panel>
  )
}
