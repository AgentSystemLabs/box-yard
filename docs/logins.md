# More Claude and Codex logins

Settings › Credentials › **More Claude logins** and **More Codex logins** take several subscription logins: Claude Pro or Max plans, and ChatGPT plans for agents that run on Codex. New sessions take them in turn with the Settings › Credentials login above them, round robin, so no one plan reaches its usage limit long before the others.

## Adding a login

- **Claude.** Run `claude setup-token` on each account and paste the token with a name ("Work Max"). API keys aren't accepted here: they bill per call. An API key in Settings › Credentials is still part of the rotation, as its first login.
- **Codex.** Paste the whole `auth.json` of a ChatGPT login. To sign in to another account without signing out of the one on your computer, create a temporary folder (`codex_login_dir="$(mktemp -d)"`), run `CODEX_HOME="$codex_login_dir" codex login`, then select the `auth.json` in that folder. Keep that file private; it contains the account’s login. The server keeps the copy Codex refreshes, as it does for Settings' own login, so sign in once and don't use that copy anywhere else.
- **One account, one login.** A login already in the list, or the account Settings › Credentials already uses, is refused. A Codex login is known by its ChatGPT account, so a refreshed file of the same account is the same login.
- **Test** runs one tiny prompt with the CLI agents use, on that login alone: a pasted value before it's added, or a saved one.
- Adding, renaming and removing are drafts the Settings dialog's Save writes, like every other setting. Test runs at once.

## What leaves the server

Only a name, the last 4 characters (a Codex login: of its ChatGPT account id), a fingerprint, and the login's state, last use and last Test. Never a value: not in `GET /api/logins`, the `logins` event, a Test's answer or the turn timings. Values are encrypted with the same secret key as identities' tokens (docs/identities.md › Secrets) and redacted from transcripts, tool results and errors like every other secret. A removed login's value is deleted, and so are its limit readings and a Codex login's refreshed `auth.json` on the server; its name stays so old turns still say what they ran on.

## Who takes the next login

| Runs | Login |
| --- | --- |
| A task's turn | The next one when it starts a new session (below) |
| The Coordinator, a Captain | The same, for their own sessions. A summary, compaction or `/context` keeps the turn's login |
| A side thread | The login its chat is on now; it doesn't move the rotation |

These keep their own login and never rotate:

- a project whose identity has its own Claude login (docs/identities.md), and its Captain
- a Claude or Codex credential in the project's or the task's env vars
- a Codex task on an SSH machine that can't keep a ChatGPT login in memory (it gets Settings' API key, as before)
- this computer's own `claude` or `codex` login, when Settings › Credentials has none: it can't be read into a rotation. Paste a token there to include it.

## Sessions keep their login

Moving a conversation between accounts has a cost, so a resumed session stays where it is:

- **Claude.** A session that comes back within an hour keeps its login: its prompt cache belongs to that account, and moving it would pay for the whole conversation again on the next one. After an hour it takes the next login. Claude sessions are files on the runner, so any login resumes them.
- **Codex.** A session always stays on the login that started it: Codex saves its reasoning encrypted for the account that wrote it. On this server, each added Codex login has its own `CODEX_HOME` (`<data>/codex-logins/<id>`), so two accounts never share one `auth.json`.

## Limits and refused logins

- **At its usage limit** (the CLI says so): the login sits out until the reset time the CLI printed, else for an hour. A plain rate limit (HTTP 429) pauses it for 5 minutes.
- **Refused** (signed out, revoked, expired: a 401 or "Please run /login"): it sits out until a Test or a run on it works.
- When every login is out, the next is tried anyway.
- **Retry once.** A task turn stopped by either is queued again once, on the next login, and the task's log says so. The agent is told its previous turn stopped and to check where things stand. A Coordinator or Captain run runs again once. Neither happens when there's no other login to go to. A Codex thread that can't open on the new account starts over from a recap, like a missing session.

The rotation also reads each login's subscription limits (docs/limits.md) before a run fails: a login whose last reading has a full window sits out until that window resets. `server/app.ts` wires it with `AgentLogins.setLimitSource(id => limitState(store, id))`. A run on an added login files its readings under that login's own id, so each has its own meters.

## Where it shows

- Settings › Credentials: each login's state ("At its limit · back Today 3:00 PM", "Signed out"), last use, and its 5-hour and weekly windows once a run has read them. Settings › Usage › Subscription limits has a card per login.
- A turn's timing (the ⏱ chip): "on Work Max (…a1b2)".
- Settings › Usage › By login, once some run in the period took a login from the rotation.

## Data

`agent_logins` holds added logins (encrypted value, name, last 4, fingerprint). `agent_login_status` holds each login's state, last Test and the name it ran under (Settings › Credentials' login too). `agent_login_holds` is which login each task, the Coordinator and each Captain last ran on, and when. `task_turns`, `turn_timings` and `claude_usage` have a `login_id`. Settings › Credentials' own login has the id `lgn_cred-<harness>-<fp8>`, the one its limit readings are kept under (docs/limits.md › Logins), so a new value there is a new login.
