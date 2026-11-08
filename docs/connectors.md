# External MCP connectors

A connector is an external MCP server that Box Yard passes into some of its Claude Code sessions: Gmail, Notion, Linear, Slack, or any server you point it at. The owner adds, signs in, scopes and removes connectors in Settings › Connectors. No model can change one. The Coordinator and Captains can only list them, with `list_connectors`.

Connectors carry account access, so the rules below start from the smallest exposure. The design note behind them, with the options considered and the threat model, is in the PR that added this page.

## A connector

| Field | What it does |
| --- | --- |
| Name | The MCP server name sessions see, so its tools are `mcp__<name>__*`. Lowercase letters, digits, `-` and `_`, starting with a letter, without `__`. It must be unique (`my-app` and `my_app` count as the same) and can't be `boxyard` |
| Label | What Settings shows ("Gmail") |
| Kind | `http` (Streamable HTTP), `sse` (the older HTTP+SSE transport) or `stdio` (a command) |
| URL | For `http` and `sse`. Must be `https`, or plain `http` only to this computer (`localhost`, `127.0.0.1`, `[::1]`). It can't hold a user name or password |
| Command, args, env | For `stdio`. `env` holds the vars that aren't secret; secret ones are saved separately (below). The command runs with only the basics of the environment (`PATH`, `HOME`, …) plus its own vars, never Box Yard's |
| Auth | `none`, `oauth`, `token` (an API key or token: a header for a remote server, the `tokenEnv` var for a command) or `env` (a command's secret env vars only) |
| Header | The header a token goes in, `Authorization: Bearer …` by default |
| Scope | Who gets it (see [Scope](#scope)) |
| Status | `connected`, `needs_auth` (never signed in, or the provider refused the refresh token: sign in again), `error` (the last test or refresh failed, with the reason) or `untested` |
| Last test | When it was tested, and the tools it listed or the error |

## Secrets

- **Values only go in.** A connector's token, OAuth tokens, OAuth client secret and secret env vars are typed only into Settings, and stored in `connector_secrets` encrypted with Box Yard's secret key (`secret.key` or `BOXYARD_SECRET_KEY`, the same as identities: see docs/identities.md › Secrets).
- No API response, event or MCP tool result ever holds one: they show the secret's name, a fingerprint (the first 12 hex digits of its sha256), whether this server's key can read it, and when an access token expires.
- **Only access tokens leave the server.** An OAuth connector's refresh token and client secret are used by the server alone, to sign in and refresh. A session only ever gets the short-lived access token.
- **Every secret is redacted.** Each connector secret in effect joins the redaction list for transcripts and errors, and so does every value replaced or removed while the server runs. An echoed token becomes `[redacted]`.
- **An edit never moves a secret.** Changing a connector's kind, auth, URL, command or args, or its OAuth client or issuer, drops its saved secrets and sign-in, and it needs signing in again. A token is never sent to a new host or program by an edit. (the owner’s own OAuth client secret stays unless the client itself changed.)
- `list_connectors` shows a remote server's host only, never its path or query, because some servers put a key in the path.

## Scope

Each connector says who gets it:

- **Sessions:** the Coordinator, Captains and/or agents. Side threads never get a connector: they're read-only.
- **Projects** (for Captains and agents): every project, or chosen ones.
- **Runners** (for agents): this computer, Docker, Upstash boxes, SSH machines or the GPU runner (RunPod, Vast.ai or Daytona).

**The default is the Coordinator only.** The Coordinator has no shell and runs on this computer. Agents, other projects and remote runners are each an explicit choice.

**Status-only projects.** A connector the Coordinator uses never reaches a status-only project's Captain or agents (see docs/identities.md › Coordinator sees: status only). It would be a channel: a sealed agent writes to Notion, then the Coordinator reads Notion.

- With "every project", status-only projects are skipped, and the connector lists them in `sealedSkipped`.
- Choosing one explicitly is refused on Save, with the reason.

**Boxes.** An agent can read everything on its Upstash box. So the connectors that reach a project's agents on boxes are part of the box wall: two projects share a pool box only when they have the same identity *and* the same box connectors. A project with no box connectors keeps its key as it was.

## Sessions

Each Claude Code session gets the connectors its [scope](#scope) reaches, as it starts:

| Session | Its config | Where the values go |
| --- | --- | --- |
| The Coordinator | `orchestrator-mcp.json` in the data dir | The `claude` process's env |
| A Captain | `captains/<project>/mcp.json` | The `claude` process's env |
| An agent's turn | The task folder's `mcp.json`, which the runner writes from `task.json` | `task.json` → the `claude` process's env, like an identity's credentials |

- **A config names each secret, never holds it.** A remote connector's header is `Authorization: Bearer ${BOXYARD_CONNECTOR_<NAME>_TOKEN}`. A command's secret env var `FOO` is `FOO=${BOXYARD_CONNECTOR_<NAME>_ENV_FOO}`, and its token var is `${BOXYARD_CONNECTOR_<NAME>_TOKEN}`. Claude Code expands them from its own env. Box Yard's own server is always `boxyard`, whatever the connectors are.
- **A command gets none of the session's env.** Claude Code hands a stdio server its whole env: its login, the GitHub token, other connectors' tokens. So a command runs as `/usr/bin/env -i HOME=… PATH=… SHELL=… TERM=… USER=… LOGNAME=… <its vars> <command> <args>`, the same basics Test gives it.
- **OAuth tokens last the session.** An access token with less than 45 minutes left is refreshed as the session starts, once however many sessions start together. Only the access token goes out.
- **One that can't sign in is left out.** A connector that isn't signed in, has no token, or has a secret env var this server's key can't read isn't in the config. An agent's task says so once, with the reason; Settings shows the status.
- **Turns may use them.** The Coordinator and Captains run with `dontAsk`, so their turns add `mcp__<name>` to `--allowedTools`. Their summary, compact and context runs list the same servers (for the prompt cache) but allow none. Agents bypass permissions.
- **Not side threads.** A side thread gets Box Yard's read-only server only.
- **Claude Code only, for now.** An agent on Codex or Cursor, and a Coordinator or Captain on another CLI than Claude Code, gets no connector (see [Coming next](#coming-next)).
- A change reaches the next session, or the next turn: a connector added, scoped or signed in mid-turn isn't in a running one.

## Signing in with OAuth

Box Yard follows the MCP authorization spec, using the MCP SDK's helpers:

1. **Discovery.** Ask the server without a token, and read `WWW-Authenticate`'s `resource_metadata` and `scope`. Then fetch the protected resource metadata (RFC 9728) and the authorization server's metadata (RFC 8414 or OpenID).
   - The resource metadata must describe this server.
   - The authorization server's `issuer` must be the address it was fetched from (one trailing `/` aside).
   - It must list PKCE `S256`.
   - Every endpoint must be `https` (or loopback).
   - A connector can name its authorization server instead (`oauth.issuer`, as Google's presets do), and then it isn't discovered.
2. **Client.**
   - With dynamic registration (RFC 7591), Box Yard registers itself as a public client ("Box Yard", `token_endpoint_auth_method: none`). The registration is kept per issuer and redirect address.
   - A provider without registration (Google, Slack) uses the owner’s own OAuth client: its id on the connector (`clientKind` `desktop` or `web`), and its secret saved like any other.
3. **Authorize.** The sign-in page opens in a new tab, with:
   - PKCE S256;
   - a `state` of 32 random bytes, single use and good for ten minutes;
   - `resource` (RFC 8707) for a discovered server;
   - the scopes: the connector's own, else the server's challenge, else its `scopes_supported`;
   - the connector's extra parameters (Google's `access_type=offline` and `prompt=consent`).
4. **Callback.**
   - Box Yard checks the `state`, the connector (unchanged since the start), and `iss` (RFC 9207: required when the provider says it sends one).
   - It exchanges the code with the verifier, which never left the server, stores the tokens encrypted, and runs a Test.
5. **Refresh.**
   - When a session starts with the connector, or it's tested, an access token with less than 45 minutes left (2 for a test) is refreshed first. Nothing refreshes in the background.
   - Refreshes run one at a time per connector. That matters for providers whose refresh tokens rotate, such as Notion, which revokes the grant if an old one is replayed.
   - A refused refresh token (`invalid_grant`, `invalid_client`) drops the tokens and sets `needs_auth`.

### Where the redirect lands

The provider sends the browser back to `<origin>/api/connectors/oauth/callback`. The origin depends on where Box Yard is open:

- **At an `https` or loopback address** (on the Mac at `http://localhost:4000`, or over Tailscale Serve at `https://<mac>.<tailnet>.ts.net`): the provider returns to that address and the sign-in finishes by itself.
  - On an iPhone, run `tailscale serve --bg 4000` on the Mac and open Box Yard at the `https://….ts.net` address. Register that exact HTTPS origin in `BOXYARD_PUBLIC_URL` or `BOXYARD_TRUSTED_ORIGINS` and restart the server; forwarded headers alone do not grant browser trust.
- **At a plain-http address elsewhere** (`http://100.x.y.z:4000`, a MagicDNS name): providers refuse to redirect there. So Box Yard returns to `http://127.0.0.1:<port>/api/connectors/oauth/callback`. On the Mac that loads. On a phone it doesn't, and the owner copies the address from the browser's address bar into the sign-in dialog (paste-back).
- **A Desktop OAuth client** (Google) always returns to loopback, since Google accepts any loopback port without registering it. **A Web client** needs Box Yard on `https`, with that exact callback address registered at the provider.

The sign-in returns only to an address the request came in on (its `Origin` or `Host`) or `BOXYARD_PUBLIC_URL`, never to one taken from the body alone.

**The callback page needs no Box Yard login.** A home-screen Box Yard on an iPhone doesn't share cookies with Safari, where the provider's page opens. The `state` is the gate instead: made by a logged-in Sign in, single use, ten minutes, and useless without the verifier held on the server. The page sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and a CSP that allows no script. It shows only an escaped message, never the code or a token.

## Settings › Connectors

One card per connector: its server or command, how it signs in, its secrets (fingerprints only), who gets it, and its last test with the tools it listed.

- **Add connector** opens a blank card: a remote server (Streamable HTTP or the older SSE) or a command on this computer, how it signs in, and who gets it. The name follows the label until you type one.
- **Everything is a draft until Save**: a new card, an edit, a pasted token or secret, Sign out and Remove. Save writes the fields first and the secrets after, so an edit that moves the connector doesn't then drop the secret you just typed. A new token or secret env var is tested right after.
- **Sign in and Test act at once**, on what's saved, so they wait while the card has unsaved changes.
  - Sign in asks Box Yard for the provider's page, which opens in a new tab. It comes back by itself, or, when the address it returns to won't load on this device (a phone, plain http), you paste that address into the card.
  - Test connects the way a session would and lists the tools.
- **Secrets are write-only.** Token, client secret and secret env var fields are password fields; what's saved shows as a fingerprint, with Remove.
- **Who gets it** starts at the Coordinator only. Captains and agents are each a tick, then every project or chosen ones, and for agents the runners. A status-only project can't be chosen while the Coordinator gets the connector too, and a remote runner shows the warning that its token sits in the task folder there.
- It works on a phone: 44 px targets, the cards reflow on their own width, nothing hides behind hover.

## Presets

A preset is a connector filled in for one service, which Settings › Connectors adds with its setup steps (`shared/connectorPresets.ts`). A preset never ships an OAuth client: whoever runs Box Yard makes their own at the provider, so no two installs share a Google project, its quota or its consent screen.

### Gmail

**Add Gmail** in Settings › Connectors adds:

| | |
| --- | --- |
| Server | Box Yard's own (`runner/gmail-mcp.mjs`), a small stdio MCP server run with Box Yard's Node. The connector names the command `box-yard-gmail`; change the command and it's an ordinary command connector again |
| Tools | `search_messages` (Gmail's search syntax), `read_message`, `read_thread`, `list_labels`, `get_profile`, `create_draft`. **No send tool**: a draft waits in Gmail for you |
| Scopes | `gmail.readonly` and `gmail.compose`. Not `gmail.send` or `gmail.modify`: nothing deletes, relabels or archives |
| Sign-in | Your own Desktop app client, `oauth.issuer` `https://accounts.google.com`, `access_type=offline` and `prompt=consent` so Google gives a refresh token |
| Who gets it | The Coordinator only |
| Where it runs | This computer only: the Coordinator, Captains, Test, and agents on the local runner. Its scope can't name another runner |

The server gets the access token in `GOOGLE_ACCESS_TOKEN` and nothing else: no refresh token, no client secret, none of the session's env. It talks only to `https://gmail.googleapis.com` (tests point `GMAIL_API_BASE` at a fake on loopback; it refuses plain http anywhere else). A message body is cut at 20,000 characters, and attachments are listed by name and size, never downloaded.

**Setting up Google** (once, about ten minutes; the card shows these steps with links):

1. In the Google Cloud console, create a project (or pick one of yours) and enable the **Gmail API**.
2. **Google Auth Platform › Get started**: an app name, your email as support email, Audience **External**, your email as contact. The app name can't contain "Google" or "Gmail".
3. **Branding**: an app homepage link and a privacy policy link as well. Any address on a site you control works: your GitHub profile, a repo, a gist or your own site. Google reviews them only if you submit the app for verification, which you don't need.
4. **Audience › Publish app**, to **In production**. For these Gmail scopes, [Google expires Testing refresh tokens after seven days](https://developers.google.com/identity/protocols/oauth2#expiration). Publishing needs the Branding fields above.
5. **Clients › Create client**, Application type **Desktop app**, then **Download JSON**.
6. In Settings › Connectors › Gmail, drop that `client_secret_….json` on the card (or pick it, or paste its contents, or type the client id and secret), and Save.
7. **Sign in.** Google says it hasn't verified the app, because it's your own: **Advanced › Go to** your app, and allow reading mail and managing drafts. A Desktop client returns to this computer's loopback address, so sign in from Box Yard on this computer (`http://localhost:<port>`), or paste the address back from another device.
8. **Test** lists the six tools.

**What a session can do with it.** A session with Gmail can read your mail and write drafts. Keep it to the Coordinator unless you need more:

- **An agent's shell can read the token.** An agent's Bash inherits the `claude` process's env, so an agent scoped to Gmail can read `BOXYARD_CONNECTOR_GMAIL_TOKEN` and call the Gmail API directly. `gmail.compose` also lets that token send a draft (`drafts.send`), though the server has no send tool. The Coordinator has no shell, which is why Gmail starts there only.
- **Mail is untrusted input.** A message can carry instructions meant for the model. The tools return mail as data, and nothing sends, but a session that reads mail and can act elsewhere (open a task, message an agent) can be steered by what it reads.

**No Google Cloud?** A hosted Gmail MCP server that runs its own OAuth (one that supports MCP's dynamic client registration) is added as a plain `http` connector with OAuth sign-in instead: no Google Cloud project, but your mail then passes through that service.

## Test

Test connects the way a session would, with its token, OAuth access token or secret env vars, and lists the server's tools (up to 200).

- A command runs on this computer with only its own env, and is given 60 seconds; a remote server gets 20.
- A `401` or `403` from a server sets `needs_auth`. Any other failure sets `error`, with a redacted reason (and the last lines a command printed).

## MCP tools

`list_connectors` (the Coordinator and Captains): each connector's name, `mcp__<name>__*`, server host or command name, auth, status and detail, its sign-in state, secret names with fingerprints, and its last test's tool names.

- The Coordinator also sees whom each one reaches.
- A Captain sees only the connectors that reach its project, whether it and its agents get each (`yours`), and other projects only as a count.
- The whole result is also run through the connectors' secret values.

No tool adds, changes, signs in or removes a connector.

## API

All under `/api`, behind the login, except the callback.

| Route | What it does |
| --- | --- |
| `GET /connectors` | Every connector (no values) |
| `POST /connectors` | Add one (`ConnectorInput` in `shared/connectors.ts`) |
| `PATCH /connectors/:id` | Change it. An edit that moves it drops its secrets (above) |
| `DELETE /connectors/:id` | Remove it and its secrets |
| `PUT` / `DELETE /connectors/:id/token` | Its token, `{ value }` |
| `PUT` / `DELETE /connectors/:id/client-secret` | the owner’s own OAuth client's secret, `{ value }` |
| `PUT` / `DELETE /connectors/:id/env/:name` | A command's secret env var, `{ value }` |
| `POST /connectors/:id/oauth/start` | `{ origin? }` → `{ authorizeUrl, redirectUri, mode: "redirect" \| "paste", signInHost, note }` |
| `GET /connectors/oauth/callback` | Where the provider returns (public, state-gated) |
| `POST /connectors/oauth/complete` | Paste-back: `{ url }`, the address the provider's page ended up on |
| `POST /connectors/:id/sign-out` | Forget its OAuth tokens |
| `POST /connectors/:id/test` | Connect and list its tools; sets its status |

Every change is broadcast as a `connectors` event with the full list (no values).

## Coming next

- **More presets.** Google Calendar (like Gmail: a small server Box Yard ships, given only the Google access token), Notion, Linear and Slack.
- **Codex and Cursor sessions.** Their MCP configs are their own formats (`config.toml`, `.cursor/mcp.json`); they get no connector yet.
