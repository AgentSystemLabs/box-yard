# Project identities

An identity is who acts for a project: a GitHub account (one or more tokens), the git author its commits carry, the key that signs them, a Claude login, and the runners its agents may use. Each project has exactly one. Use identities when one Box Yard works for several GitHub accounts: a personal one, a work one, a client's org.

Every project starts on the **Default** identity, which is Settings › Credentials: nothing changes for a project until it's given another identity.

## The Default identity

- Its GitHub token and Claude login are the ones in Settings › Credentials (or `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` on the server). They're edited there, not on the identity, so each value has one place. With more Claude logins there, new sessions take them in turn (docs/logins.md).
- It keeps its name and can't be removed. It may have an author of its own.
- When the database is migrated, every existing project is put on it.

## An identity of its own

| Field | What it does |
| --- | --- |
| Name, colour | Unique (case doesn't count). The colour tells identities apart in lists |
| GitHub login | Set by the first token saved: GitHub's `GET /user` says whose it is. Every token of an identity must be the same account |
| Tokens | One per owner (`acme`), or one for every owner (`""`). A turn gets the token for its repo's owner, else the every-owner one. An identity with no token gives its turns **none**, never the global one, so a push can't silently go out as another account |
| Owners | The users or orgs it works for (shown on the identity; matching is by token owner) |
| Author | `name` and `email` for every commit. Checked against the account's verified emails when the token may read them (`emailCheck`: `verified`, `unverified`, `unknown`); a GitHub noreply address counts as verified |
| Signing key | An SSH or GPG key that signs every commit a turn makes, and optionally `requireSigned` (see [Signing](#signing)) |
| Claude login | An API key or an OAuth token (`claude setup-token`). It always wins: its projects never take the global logins' rotation. Without one, the identity uses the global logins, round robin (docs/logins.md) |
| Runners | The runners its projects may use (`box`, `local`, `gpu`, `docker`), or every runner |
| Coordinator sees | `everything` (the default) or `status`: the Coordinator gets only the status of its projects' tasks (see [Coordinator sees: status only](#coordinator-sees-status-only)) |

## Saving identity settings

Settings edits stay as drafts until **Save**. Save checks every pending identity draft, including cards you collapsed or left in another settings category; unchanged identities are not rewritten or revalidated. Invalid drafts stay as typed. Save opens the relevant identity, clears settings search, and scrolls to and focuses the field with its explanation. Correct it and Save again.

**Owners** accepts GitHub user or org names separated by commas or spaces. **Token owner**, under GitHub token, accepts one such name, or blank for every owner. Neither accepts a repository (`acme/app`) or URL. Names are trimmed and token owners are lowercased for saving; a valid hyphenated name such as `acme-example-daily` is accepted. A token error naming `owner` refers to Token owner, rather than the Owners list or git author.

## What a turn gets

From strongest to weakest:

1. The task's own env vars, then the project's own (`GITHUB_TOKEN`, `GH_TOKEN`, a Claude var, `GIT_AUTHOR_*`). These still win, as before identities.
2. The project's identity: its token for the repo's owner (else its every-owner token), its author, its Claude login.
3. For the Default identity only: Settings › Credentials.

Each turn gets exactly one Claude var, and its GitHub token in both `GITHUB_TOKEN` and `GH_TOKEN`. The author goes in `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`, which beat any `user.name` a repo sets. The runner drops every credential var the turn mustn't use from its own env first.

### Git author

A turn's commits are by the first of these that's there (`server/gitAuthor.ts`):

1. The task's or project's own `GIT_AUTHOR_*` env vars, else the identity's author (and its signing key, below).
2. Settings › Credentials › **Git author** (`GIT_USER_NAME` / `GIT_USER_EMAIL`; a value saved there wins over the env var).
3. On this computer, for the Default identity only: your own git config. On the local runner Box Yard sets no author at all, so git does what it always does in that repo: `user.name`, `user.email`, `includeIf` blocks for the repo's path, and `commit.gpgsign` with `gpg.format`, `user.signingkey` and `gpg.ssh.program`. In a Docker container, the global config's name and email go in as env vars (its signing key can't follow, and the task's log says so).
4. The GitHub account behind the turn's token: its name (else its login) and `<id>+<login>@users.noreply.github.com`. Box Yard asks GitHub (`GET /user`) from the server and remembers the answer per token for a day. When GitHub can't be asked again, the account it last named for that token stays the author, and Box Yard asks again ten minutes later.
5. Only then the neutral `Agent <agent@noreply.invalid>`, unsigned. It names no product, and its `.invalid` domain (reserved, RFC 2606) means GitHub never links those commits to anyone's account. The task's log gets a warning that says why each step gave nothing, and Settings › Credentials and Identities list the projects whose last turn committed that way until a later turn has a real author.

Box Yard writes no author into a clone's `.git/config` or a box's global config. Clones made before this have the old fallback, `user.name = Box Yard Agent`, in their `.git/config`; the local runner removes it before a turn, and everywhere else the author env vars beat it.

Box Yard's own git work for the project (clones, fetches, the turn-end push, PR checks, branch cleanup) uses the same token. A project's Captain runs on its identity's Claude login.

On the local runner, a project on any identity but Default gets separate git and `gh` configuration for normal commands:

- it uses only Box Yard's git credential helper: the helpers in `~/.gitconfig` are skipped for it;
- its turns, and Box Yard's own git work for it, get a git config and a `gh` folder of the identity's own, in `<local dir>/.boxyard/identities/<id>/` (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, `GH_CONFIG_DIR`), so `~/.gitconfig`'s name, email, signing key, `includeIf` rules and hooks, and the `gh` login, don't reach it. The repo's own `.git/config` still applies.

Default projects keep this computer’s setup, as before. These configuration choices are not filesystem isolation: an unsandboxed local agent still runs as the server’s OS user and can read that user’s other files and credentials.

## Signing

An identity can sign every commit its turns make with an SSH key (git 2.34 or later and `ssh-keygen`) or an OpenPGP/GPG key (GnuPG on the local runner). There are three kinds:

- **A key file** (`kind: "file"`). Paste a private key without a passphrase; Box Yard keeps it encrypted like a token and shows only its public key and fingerprint (`SHA256:…`). Make one for the identity with `ssh-keygen -t ed25519 -N "" -f acme-signing`, and add `acme-signing.pub` to the GitHub account as a **signing key** (Settings › SSH and GPG keys) so GitHub marks the commits Verified. It works on every runner.
- **A key in this computer's agent** (`kind: "agent"`). Give the public key (`ssh-add -L`, or 1Password's), and, for 1Password, its `program` (`/Applications/1Password.app/Contents/MacOS/op-ssh-sign`). The private key never leaves the agent, so this identity's projects run **only on the local runner**: setting such a key is refused while a project of it runs elsewhere, and so is moving one off this computer. Without a `program`, `SSH_AUTH_SOCK` has to be set in Box Yard's own environment.

- **A GPG key in this computer's keyring** (`kind: "gpg"`). In Settings › Identities choose **GPG keyring (this computer)** and enter a hex key id or full fingerprint from `gpg --list-secret-keys --keyid-format LONG`. Save applies it, like every Settings edit. For the MCP tools use `signing_key_ref: "gpg:<id or fingerprint>"`. Box Yard resolves the id to the primary fingerprint; GPG can choose its signing subkey. Only this identifier and public metadata are read or saved: the secret key stays in the host keyring or gpg-agent. Never paste a GPG private key or passphrase into Settings, chat or a tool.

### GPG on the local runner

GPG identities run **only on this computer**. Upstash boxes, SSH machines, Docker containers and GPU runners cannot use this host's keyring; Box Yard refuses assigning or moving such a project there, and refuses saving a GPG key while one of its projects runs elsewhere. It does not export keys, mount the keyring into containers or forward gpg-agent to other runners. Set the project's runner to **This computer** first.

The local runner inherits the server's `PATH`, `GNUPGHOME` (when set) and gpg-agent access. Unlock a protected key yourself before the turn. Every GPG invocation used by the turn runs with `--batch --no-tty --pinentry-mode error` ([GnuPG pinentry modes](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Esoteric-Options.html)), with a 15-second limit: a pinentry/passphrase request, missing key or unavailable agent produces a clear error. Signing remains enabled, so `git commit` fails rather than producing an unsigned commit. An agent can explicitly override git signing; use `requireSigned` and GitHub branch protection for additional guards.

**Test identity** reads the secret-key listing, checks that an unexpired key exists and its UID email matches the identity's explicit author email, and checks registration with GitHub's `GET /user/gpg_keys`. Grant `read:gpg_key` for a classic token or **GPG keys: read** for a fine-grained token ([GitHub permissions](https://docs.github.com/en/rest/users/gpg-keys#list-gpg-keys-for-the-authenticated-user)); when GitHub cannot list the keys the result says registration is unknown and how to enable that check. A missing key, email mismatch or absent GitHub registration fails the check. Test does not prompt to unlock the key or export anything; the runner tests headless signing when a turn starts.

How a turn signs:

- A key file goes to the box for one turn as `signing.key` beside `task.json` (never in it, and never in an archive). The runner moves it to a fresh 0700 folder in the box's temp dir, `boxyard-sign-<task id>`, and removes that folder when the turn ends.
- In a Docker container the key never touches a disk: `signing.key` is a link to a copy on the container's tmpfs (`/run/boxyard`, in memory, like `task.json`), and the runner keeps the key there for the turn (`/run/boxyard/sign-<task id>.key`, mode 0600). Both copies go when the turn ends, and the tmpfs when the container stops. The push guard's hooks stay in `boxyard-sign-<task id>`, since the tmpfs is `noexec`.
- git gets `gpg.format=ssh` (SSH) or `gpg.format=openpgp` (GPG), `user.signingKey` and `commit.gpgSign=true` from the env (`GIT_CONFIG_COUNT`), which beats any repo or global config and reaches only the turn's processes: the repo's `.git/config` is never changed, and Box Yard's own work-in-progress snapshots stay unsigned.
- When an SSH turn can't sign (the key can't be read with this server's secret key, the program is gone, git is too old), its commits go unsigned and the task says why: "This turn's commits aren't signed: …".

**`requireSigned`** stops unsigned commits leaving the box:

- In the turn, a pre-push hook refuses a push carrying any commit the identity's key didn't sign and that no remote has yet, and names them. The repo's own hooks (`.git/hooks`, husky's `core.hooksPath`) still run.
- It holds when signing can't be set up too: then the turn's pushes are stopped, and the task says so.
- At the turn's end, Box Yard checks the branch the same way and leaves it off origin when a commit isn't signed: "Turn-end push: the Acme identity requires signed commits, and its key (SHA256:…) didn't sign 1a2b3c4, so the branch wasn't pushed". The work-in-progress ref still carries the work, so nothing is lost; re-sign with `git rebase --force-rebase --gpg-sign origin/main` and push.
- It's a guard against mistakes, not a lock: an agent can skip a hook with `git push --no-verify`. To make it a lock, turn on "Require signed commits" in the repo's GitHub branch protection.

For GPG, both push guards accept a valid signature by the saved primary fingerprint or its signing subkey (including a valid key without local ownertrust); other-key, invalid and unsigned commits are refused.

Not covered yet: commits Box Yard makes through GitHub's API (the screenshots on `pr-assets`) aren't signed; a repo cloned over SSH (`git@github.com:…`) still reaches this computer's SSH keys on the local runner, since only HTTPS goes through the identity's token.

## Secrets

- **Encrypted at rest.** Tokens and Claude logins are stored with AES-256-GCM. The key is `BOXYARD_SECRET_KEY` when it's set (64 hex characters, 32 bytes in base64, or any passphrase, hashed), else a random key in `<data dir>/secret.key` (mode 0600), made on first use. The key is never in the database: a copy of `box-yard.sqlite` alone holds no usable token.
- **Back up the key with the database.** Without it, identities keep their names, logins and fingerprints, but each token and Claude login shows `readable: false` and turns don't get it until it's saved again.
- **Write-only.** Values go in through the API and never come out: the API, the web app and the model see logins, owners, emails, scopes, expiry and a fingerprint (the first 12 hex of the value's sha256).
- **Kept out of transcripts.** Known credential values of at least six characters (Settings › Credentials’ and the identities’, a signing key also line by line) are replaced with `[redacted]` in task, Captain, Coordinator and side thread messages before they’re saved or shown. Recognized private-key blocks, including truncated blocks, become `[redacted private key]`. The owner’s own messages are kept as written. API errors also use secret-shape filtering. Redaction is not a guarantee against unknown secrets, encoded values or copies in files/artifacts.
- **Kept from `claude`.** `BOXYARD_SECRET_KEY` is removed from the env of the Coordinator, the Captains and their side threads (a Captain's logs in with its identity's Claude login, like the Captain), and the local runner already strips every `BOXYARD_*` var from agents.

## Boxes

Tasks of two identities never share an Upstash box: an agent can read everything on its box, including other workspaces' `task.json`. A box remembers the identity it was made for, a project of the same identity shares it, and a resting task on a box of another identity moves when nothing would be lost. A project with its own token or Claude login in its env has a set of its own, as before.

So each identity in use needs boxes of its own. When the pool is at Max boxes and none is that identity's, its tasks wait and say so: raise Max boxes, or let idle boxes go.

Docker containers, GPU pods and the local runner are outside the wall: each already belongs to one project, or to this computer.

## Runners

An identity's runners are checked when a project is given the identity or a new "Runs on", when a task asks for its own runner, and when an identity's runners change (refused while a project of it runs elsewhere). A task pinned to a runner before its identity stopped allowing it waits and says why; it never runs there.

## Coordinator sees: status only

An identity set to `status` keeps its projects' content between the owner, their Captains and their agents. The Coordinator still sees that the work exists and where it stands, so it can route requests and report progress, but not what the work says. When Default is set to `status`, every project on Default is sealed too.

- **What the Coordinator gets.** A sealed project's task titles, states, PRs and their state, branch, box, runner, turns, model and merge requests. Whether a task asks something or failed shows as `(status only: ask the project's Captain)`, not the question or the error. `list_projects` marks the project with `coordinatorSees` and gives its notes as a count.
- **What it doesn't.** Replies (`lastReply`), questions, errors, summaries, previews and transcript lines; the project's notes and note suggestions; its artifacts (also as attachments); its Captain's compactions; its queued messages; its preview URLs (`get_preview_url`); its `search_history` hits (also the notices about its tasks kept in the Coordinator's chat, which `around` shows masked); and its tasks as `related_tasks` of a task elsewhere. A tool that would return them answers `Status only: …` and points at the project's Captain (`ask_captain`, `send_to_captain`). Content lists across projects leave them out instead, and a `list_tasks` query matches only a sealed task's title and PR.
- **Outside the tools.** The Coordinator's own summary and recap prompts leave a sealed task's question out. A compaction's task snapshot says `Status only: …` instead of the task's summary, and `read_compaction` masks snapshots written before the seal the same way. Hook notices about its tasks carry no prompt preview, and `{summary}` becomes `(status only: ask the project's Captain)` in a `message_coordinator` hook's prompt and in a `create_task` hook's task title (the new task's prompt keeps it).
- **The Captain answers with state.** A sealed project's Captain is told to answer the Coordinator with the state of the work (what's done, what's running, which PRs are open, what waits on whom), not code, files, transcripts, notes or anyone's words. `ask_captain` and `wait_for_captain` return only its replies to the Coordinator, not the rest of its chat.
- **Agents stay on their side.** An agent in a sealed project and one in an open project can't `message_agent` each other (either way, since a reply would come back across); the sender hears why and is pointed at its Captain. Agents within the sealed project, or between two sealed or two open projects, message as before.
- **Still allowed.** Writes and controls (marking done requires an [explicit owner chat request](owner-chat-close.md), not an agent tool): starting tasks, `send_to_task`, stop, retry, queued-message delivery, note tools, hooks and schedules (their prompts are configuration the Coordinator or the owner wrote, so the Coordinator still reads them).
- **One-way for the model.** The Coordinator (or a Captain) can set an identity to `status` with `create_identity`, `update_identity` or `import_detected_identity`, but no tool sets it back to `everything`, moves a sealed project to an identity that shows everything (`assign_identity`), or deletes a sealed identity and moves its projects into a Default that shows everything. The owner does those in Settings › Identities or the project's *Identity / Claude login* picker.

It's a view, not a wall. What remains:

- **The Captain's own words.** A Captain's reply to the Coordinator is sent as it is: the prompt asks for state only, but a Captain told to quote something can.
- **Box Yard's API on this computer.** With no `BOXYARD_PASSWORD`, the API is open on loopback, and the Coordinator has `WebFetch`. Set a password to close that.
- **What the Coordinator already knew.** Context already delivered before the seal is not erased. While any project is status-only, the mixed Coordinator compaction archive and its direct Read rule are withheld; see [compaction privacy](compaction-history.md#privacy).
- **Uploads.** The Coordinator may `Read` the uploads folder; an upload's path is random and only appears in content it no longer gets.
- **GitHub.** The Coordinator gets each PR's URL, and for a public repo `WebFetch` can open the PR there. The seal covers Box Yard's views, not who can read the repo.

## In the web app

**Settings › Identities** (after Credentials) has a card per identity: its account, owners, git author and whether GitHub verified the email, each token's owner, scopes, expiry and fingerprint, the signing key's fingerprint, its own Claude login if any, where it may run, its projects and its last test.

- **Edit, Add and Delete are drafts.** Nothing is written until the dialog's Save, like every other section; Delete says which projects move to Default. A Save that fails partway keeps only what wasn't saved yet.
- **Secrets go in, never out.** A token, a Claude login and a key file are typed or chosen into write-only fields and sent once, on Save. The card shows the fingerprint from then on. A key file is read in the browser and goes only to Box Yard.
- **Test** checks the identity with GitHub (each token, push access to its projects' repos, the author email, the signing key) and keeps the result as its last test. It changes nothing else.
- **Coordinator sees** is *Everything* or *Status only* on each card, saved with its draft (see [Coordinator sees: status only](#coordinator-sees-status-only)). Only here and in the project's picker can it go back to *Everything*.
- **Import from this computer** runs the same detection as `detect_identities` (with GitHub unless *Ask GitHub too* is off) and lists a proposal per account with its evidence. Tick a proposal, untick any project that should stay, and Save: Box Yard reads the token and key by reference on the server, so they never pass through the page.

**A project's identity** is picked in its project settings (the Captain's ⋯ › Project settings, a sidebar project row's settings button, or Settings › Projects), in *Identity / Claude login*, and saved with the rest of the form. The section says which identity the project uses (Default inherited from Settings › Credentials, too), the picked one's GitHub account and which Claude login its agents and Captain get (a kind, never a value), and when a Claude login in the project's env vars wins for its agents. The picker says when the identity can't run on the project's runner or shows the Coordinator status only, and Save waits while one of the project's tasks is running, so no turn switches accounts halfway.

**Badges.** A project on another identity than Default shows its colour dot and name in the sidebar (just the dot when the sidebar is narrow), and the task's ⓘ details say which identity its turns act as. The project header doesn't.

## Set up from this computer

The Coordinator (or a project's Captain) can set identities up from what this computer already uses, so nobody has to work out which token, email and key go with which repo. It's how the Coordinator answers a clone, fetch or push that fails with 401, 403 or 404, or a question about GitHub accounts: it runs `detect_identities`, proposes the whole setup to the owner in one message, and imports only what the owner agrees to.

**What detection reads.** Read-only; it changes nothing:

- `gh auth status`: the github.com accounts `gh` is signed in to, the active one, its git protocol, token scopes and where gh keeps the token. Another host (GitHub Enterprise) is noted, not proposed.
- `git config --global --includes`: the global author and signing setup, and each `includeIf` block's file (`user.*`, `gpg.*`, `commit.gpgsign`, `core.sshCommand`; credential helpers by name only).
- For an `includeIf "gitdir:…"` block, the `origin` remotes of the repos under its folder (three levels down, 400 folders at most, each `.git/config` read as text), so the block's repo owners are known.
- `~/.ssh/config`'s hosts that reach GitHub, the public keys beside `~/.ssh` key files (or `ssh-keygen -y` without a passphrase), and fingerprints of the keys `core.sshCommand -i` pushes with.
- **Online** (the default), for each account it asks GitHub with that account's own `gh` token, read on the server and never returned: `GET /user`, `/user/orgs`, `/user/emails`, the account's SSH and signing keys, and `GET /repos/:owner/:name` for each project's repo (push access, 404, SAML SSO). `online: false` skips GitHub.

The env it runs `gh`, `git` and `ssh-keygen` with drops `GH_TOKEN`, `GITHUB_TOKEN`, the enterprise tokens, `GH_HOST`, `GIT_DIR` and `GIT_CONFIG_*`, and never prompts.

**What it proposes.** One identity per github.com account:

- An `includeIf` block goes with the account whose verified emails hold its email, whose GitHub keys hold its SSH or signing key, or whose login or orgs own its repos. The active account takes the global author.
- A project goes to the account that can push to its repo (online), or that owns it (offline); a project on Default stays there when Default's token is that account already. Projects nothing clearly matches stay where they are, with the reason.
- A token is named `gh:github.com:<login>` and a signing key `file:~/.ssh/<key>` or `agent:SHA256:…`, or `gpg:<fingerprint>`. A proposal holds no value.

**Importing.** `import_detected_identity` reads the token from `gh` and the key by reference again, on the server, and checks the token with GitHub before saving it, encrypted. An identity Box Yard already has for the login is updated instead. Then the proposal's projects move to it, each only while it has no task running.

**What a reference may name.**

- `gh:<login>` (or `gh:<host>:<login>`): an account `gh` is signed in to here.
- `file:<path>`: a key file without a passphrase, in `~/.ssh` (symlinks resolved) or the one a git config here names as `user.signingkey`; at most 16 KB and a private key. A key this computer also logs in to SSH servers with (`~/.ssh/id_*`, an `IdentityFile`, a `core.sshCommand -i` key) is refused for an identity whose projects may run on boxes, since each box would hold a copy: make a signing key of its own (`ssh-keygen -t ed25519 -N "" -C commit-signing -f ~/.ssh/commit_signing`), or keep its projects on this computer (`runners: ["local"]`).
- `gpg:<hex key id or fingerprint>`: resolves through `gpg --batch --no-tty --with-colons --list-secret-keys`; never reads or exports key material. Detection recognizes `user.signingkey` when `gpg.format` is `openpgp` or unset, including each `includeIf` scope. Imports default to the local runner. An unavailable configured GPG key stops import; fix it, choose another reference, or explicitly choose no signing key.
- `agent:<SHA256:… or public key>`: a key in a git config here, in `~/.ssh/*.pub` or in the SSH agent (`ssh-add -L`). Its identity runs only on the local runner.

A token or key itself is never taken through a tool: it goes in Settings › Identities. Tool errors never repeat what was passed in, and any token or key shape in one is redacted.

### MCP tools

| Tool | What it does | A Captain |
| --- | --- | --- |
| `list_identities` | Every identity: login, owners, author and its email check, signing fingerprint, Claude login kind, runners, projects, last test | Sees every identity, but only its own project in them (others as a count) |
| `detect_identities` | Reads this computer (and GitHub, online) and proposes identities with the evidence. Changes nothing | Maps its own project only |
| `import_detected_identity` | A proposal becomes an identity, or updates the one for that login, and gets the proposal's projects | Gives it its own project only |
| `create_identity` | A new identity, with a token and signing key by reference. Nothing is made when a reference can't be read | Yes |
| `update_identity` | Fields, references, `remove_token`, `remove_claude`. `coordinator_sees` can go to `status`, never back | Only an identity no other project uses, never Default |
| `delete_identity` | Removes it; `move_projects_to_default` moves its projects first, unless that would move sealed projects into a Default that shows everything | Same as update |
| `assign_identity` | Gives a project an identity: the runner has to fit, no task may be running, and a sealed project can't move to an identity that shows everything | Its own project only |
| `test_identity` | Checks with GitHub: each token (whose, scopes, expiry), push access to its projects' repos, the author email, the signing key. Saved as the last test | Its own project's identity, for its own repo; not saved |

To try detection on this computer: `npm run test:detect` (read-only and offline; it prints logins, owners, emails and fingerprints only).

## API

| Route | Body | What it does |
| --- | --- | --- |
| `GET /api/identities` | | Every identity, Default first |
| `POST /api/identities` | `{ name, color?, owners?, author?, runners?, coordinatorSees? }` | A new identity, without secrets |
| `PATCH /api/identities/:id` | the same fields | Edit; Default keeps its name |
| `DELETE /api/identities/:id[?moveProjects=1]` | | Remove. 409 while projects use it, unless they move to Default |
| `PUT /api/identities/:id/tokens` | `{ owner, token }` | Save a token after GitHub accepts it (`owner: ""` for every owner) |
| `DELETE /api/identities/:id/tokens?owner=` | | Forget the owner's token |
| `PUT /api/identities/:id/claude` | `{ kind: "api_key" \| "oauth_token", value }` | Save its Claude login |
| `DELETE /api/identities/:id/claude` | | Back to the global login |
| `PUT /api/identities/:id/signing` | `{ kind: "file", privateKey, requireSigned? }`, `{ kind: "agent", publicKey, program?, requireSigned? }` or `{ kind: "gpg", keyId, requireSigned? }` | Save its signing key (replaces the old one) |
| `PATCH /api/identities/:id/signing` | `{ requireSigned }` | Turn `requireSigned` on or off |
| `DELETE /api/identities/:id/signing` | | Stop signing |
| `POST /api/identities/detect` | `{ online? }` | Detection's proposals (see above). Changes nothing |
| `POST /api/identities/import` | `{ login, name?, color?, owners?, author?, runners?, requireSigned?, projects? }` | Import the last detection's proposal for `login`: 201 when it made the identity, 200 when it updated one. `projects` (ids) narrows which move; `lines` say what happened |
| `POST /api/identities/:id/test` | | Check it with GitHub; saved as its last test |
| `PATCH /api/projects/:id` | `{ identityId }` | Give a project an identity (also on `POST /api/projects`). 409 while one of its tasks is running |

Every change is broadcast as an `identities` event.

GPG signing is shipped for the local runner only; see [GPG on the local runner](#gpg-on-the-local-runner).
