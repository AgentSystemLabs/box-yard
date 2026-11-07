# Subscription limits

Settings › Usage shows how much of each login's subscription limits is used: for a Claude subscription (Pro, Max) the
5-hour window and the weekly ones, for a Codex ChatGPT plan its 5-hour and weekly windows. Each window has a meter,
"64% used", and when it resets ("Resets Tomorrow 9:00 AM (in 7h)"). Settings › Credentials and each identity's card in
Settings › Identities show their own login's windows in one line.

## Where the numbers come from

Nothing is fetched for them. Each CLI already reports its limits, so every run that uses a login leaves a reading,
kept with the time it was made and shown as "as of 12m ago":

| | Claude Code | Codex |
| --- | --- | --- |
| Source | its stream-json `rate_limit_event` messages, sent while it runs when the API's `anthropic-ratelimit-unified-*` headers change | `rate_limits` on the `token_count` events in the session's rollout file (`$CODEX_HOME/sessions/…/rollout-*.jsonl`), read at the end of each turn |
| Windows | `five_hour`, `seven_day`, and the per-model weekly ones (`seven_day_opus`, `seven_day_sonnet`) when they apply | `primary` (5 hours) and `secondary` (weekly); a second limit (`limit_id`) is kept apart |
| Figures | `utilization` (0–1), `resetsAt` (unix seconds), `status` (`allowed`, `allowed_warning`, `rejected`) | `used_percent` (0–100), `window_minutes`, `resets_at` (unix seconds; older versions: `resets_in_seconds`), `plan_type` |

A task's runner passes them to the server as `limits` events (`runner/box-runner.mjs`); the Coordinator, the Captains
and side threads read them from their own stream (Codex chats get them from `CodexStream` as a `rate_limit_event`).
The parsing is in `shared/loginLimits.ts`, the keeping in `server/loginLimits.ts`, and `GET /api/limits` returns every
login's windows.

What this means:

- **A login shows up after its first run.** Until then there's nothing to show. A window that has reset since its last
  reading shows "reset since" and no longer counts.
- **Claude Code says how full a window is only when the API does.** A refusal (`rejected`) can come with a reset time
  and no figure: the window shows "at the limit".
- **API keys have no subscription limits.** They pay per token, and the CLIs report no such windows for them. A Claude
  login through `ANTHROPIC_AUTH_TOKEN` (a gateway or proxy) usually reports none either.

## Logins

Readings are kept per login and window, never with the credential: a login is named by its credential's fingerprint
(sha256, first 12 hex, like an identity's tokens; the id has the first 8), so two subscriptions never share a meter and
a new token is a new login.

| Login | Id | Shown as |
| --- | --- | --- |
| Settings › Credentials' Claude token or key (or the server's env var) | `lgn_cred-claude-<fp8>` | Settings › Credentials |
| An identity's own Claude login | `lgn_cred-claude-<fp8>` | "Acme identity" |
| A project's own `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` env var | `lgn_cred-claude-<fp8>` | "demo's env vars" |
| A ChatGPT login (Codex), by its account id, so a token refresh keeps the id | `lgn_cred-codex-<fp8>` | Settings › Credentials |
| A Codex API key | `lgn_cred-codex-<fp8>` | Settings › Credentials, or the project's env vars |
| An added login in More Claude / Codex logins (docs/logins.md) | its own `lgn_…` id | "Work Max (…a1b2)", on its row in Settings › Credentials |
| This computer's own `claude` or `codex login` | `lgn_local-claude`, `lgn_local-codex` | This computer |
| An SSH machine's own login | `lgn_local-claude-<machine>` | SSH machine gpu-1 |

The same credential set in two places is one login (one id); its card says where it was used last.

## For a login picker

`limitState(store, loginId)` (`server/loginLimits.ts`) answers `{ atLimit, usedPct, resetsAt, asOf }` from a login's
windows still in effect: `atLimit` when one is full, `usedPct` the fullest, and `resetsAt` when the binding window
resets (at the limit, the last full one). It's null for a login with no reading yet. The logins rotation
(docs/logins.md) reads it before it hands out a login, and skips one at its limit until `resetsAt`.

## Mock mode

`scripts/fake-claude.mjs` sends a `rate_limit_event` each turn (none on an API key; `FAKE_CLAUDE_LIMITS=off` for none,
`=full` for a spent 5-hour window), and `scripts/fake-codex.mjs` writes a plan's `rate_limits` into its rollout file
(`FAKE_CODEX_LIMITS=off` for none), so `./yard demo` shows the meters.
