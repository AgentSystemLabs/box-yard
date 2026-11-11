# Install and run with npx

One command installs Box Yard from the `main` branch on GitHub and starts it, on your own computer or on a server:

```bash
npx github:AgentSystemLabs/box-yard
```

Nothing is published to npm: npx downloads the launcher straight from the repo. You need **Node.js 22.12 or newer** and **git**. npx asks before it downloads the launcher; answer `y` (or run `npx -y github:AgentSystemLabs/box-yard`).

- [What the first run does](#what-the-first-run-does)
- [Commands and options](#commands-and-options)
- [What it checks](#what-it-checks)
- [Where things live](#where-things-live)
- [Updates](#updates)
- [On a server (VPS)](#on-a-server-vps)
- [HTTPS](#https)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [How it works](#how-it-works)

## What the first run does

1. **Checks this computer** ([below](#what-it-checks)) and stops with the command that fixes anything missing, for your OS.
2. **Installs Box Yard** into `~/.boxyard/app`: a shallow clone of `main`, `npm ci`, the build, then only what it needs to run. About a minute; the output goes to `~/.boxyard/app/update.log`.
3. **Creates `~/.boxyard/.env`** for your settings (readable only by you).
4. **Offers to install Claude Code** if `claude` isn't on the PATH (`npm install -g @anthropic-ai/claude-code`; it asks first, never uses sudo). Say no and Box Yard still starts; its setup card says what's missing.
5. **Starts Box Yard** on <http://localhost:3000> (the next free port if 3000 is taken) and opens the browser on a desktop.

Later runs skip the install and start in a couple of seconds. Press Ctrl-C to stop it; agents that are mid-turn keep working, and Box Yard picks them up again at the next start.

Your keys and logins (Claude, Codex, GitHub, Upstash) go in the app's Settings › Credentials, or in `~/.boxyard/.env` with the names in [`.env.example`](../.env.example). The command never asks for them in the terminal.

## Commands and options

```bash
npx github:AgentSystemLabs/box-yard                    # install (first run) and start
npx github:AgentSystemLabs/box-yard demo               # a fake Claude drives everything; its own data, no keys
npx github:AgentSystemLabs/box-yard --public           # listen on every address, with a generated password
npx github:AgentSystemLabs/box-yard update             # install the newest main now (while Box Yard is stopped)
npx github:AgentSystemLabs/box-yard doctor             # check this computer and say what's missing
npx github:AgentSystemLabs/box-yard service install    # Linux: keep it running with systemd
npx github:AgentSystemLabs/box-yard service uninstall
npx github:AgentSystemLabs/box-yard --help
```

| Option | What it does |
| --- | --- |
| `--port <n>` | Listen on this port. A port you ask for (here or `PORT` in the settings) must be free; the default 3000 moves to the next free one. |
| `--host <addr>` | Listen on this address. Default `127.0.0.1` (this computer only); with a `BOXYARD_PASSWORD`, the server listens on every address. |
| `--public` | Listen on `0.0.0.0` and, if there's no `BOXYARD_PASSWORD` yet, write a strong random one to `~/.boxyard/.env` and print it once. |
| `--data <dir>` | Keep the database here instead of `~/.boxyard/data`. |
| `--no-open` | Don't open the browser. |
| `--allow-root` | Run as root ([why it's refused](#what-it-checks)). |
| `-y`, `--yes` | Answer yes (installing Claude Code). |

`demo` keeps its data in `~/.boxyard/demo`, so its fake agents never touch your real projects. A second start on the same data while one is running just prints its URL.

## What it checks

Checked before anything is installed or started. A **stop** ends the launch with the fix; a **warning** is printed and Box Yard starts anyway.

| Check | Level | Why |
| --- | --- | --- |
| Windows | stop | Box Yard runs on macOS and Linux. On Windows, run it in WSL 2 (`wsl --install`, then the command in the Ubuntu terminal). |
| Node.js 22.12+ | stop | The web build needs it. An older Node gets the nodejs.org / nvm command before anything else loads. |
| Running as root | stop | Agents run Claude Code with full permissions, and Claude Code refuses that as root, so every local task would fail. Make a user (`adduser boxyard`) and run it as that user. `--allow-root` skips this when agents only run in Upstash boxes or Docker. |
| git | stop | It installs and updates Box Yard, and every task works in a git checkout. The fix names your package manager (apt, dnf, pacman, apk, or Xcode's tools on a Mac). |
| npm | stop (installs only) | It installs Box Yard's dependencies. |
| Writable folders | stop | `~/.boxyard` and the data folder. The fix is the `chown` that gives them back to you, or `BOXYARD_HOME` / `--data` for another folder. |
| Free disk | stop under 1 GB to install; warning under 2 GB | Room for the build, then for agents' checkouts. |
| The SQLite driver | stop (after the install) | `better-sqlite3` is native; the install proves it loads here, and names the build tools for your OS if it doesn't. |
| Port | stop when the one you asked for is taken | Says which process holds it (`lsof`), and suggests the next port. |
| Claude Code (`claude`) | warning | Local agents run it. The launcher offers to install it. |
| GitHub CLI (`gh`) | warning | Agents use it for pull requests; a GitHub token in Settings › Credentials works too. |

`doctor` runs the same checks without starting anything, and also shows the installed commit, the newest one on `main`, and where the settings and data are.

## Where things live

Everything is in one folder, `~/.boxyard` (set `BOXYARD_HOME` to move it):

| Path | What's there |
| --- | --- |
| `~/.boxyard/.env` | Your settings: `PORT`, `HOST`, `BOXYARD_PASSWORD`, keys. The process environment wins over it. A `.env` in the folder you run npx from is never read. |
| `~/.boxyard/data/` | The database, artifacts and uploads (`BOXYARD_DATA_DIR`, or `--data`). |
| `~/.boxyard/demo/` | `demo`'s own data. |
| `~/.boxyard/app/versions/<commit>/` | One built copy of Box Yard per installed commit of `main`. |
| `~/.boxyard/app/current` | A link to the version that runs. |
| `~/.boxyard/app/state.json` | The version before, and updates that didn't start. |
| `~/.boxyard/app/update.log` | The output of the last install or update. |

A git checkout with `./yard local` keeps using its own `.env` and `./data`, as before; the two don't share anything.

## Updates

Box Yard looks at `main` when it starts and every 30 minutes (`BOXYARD_UPDATE_CHECK_MINUTES` in `~/.boxyard/.env`; `0` turns the timer off). When there's a newer commit, a banner at the top of the app says so, with **What's new** (the compare view on GitHub) and **Update**. Nothing changes until you press it.

1. **Update** builds the new commit beside the running one, in the background; the banner shows each step and you keep working.
2. When it's built, Box Yard restarts into it as soon as no Coordinator, Captain or side-thread reply is running (it waits up to 10 minutes; **Restart now** doesn't wait). Task agents run on their own and carry on through the restart.
3. The page reconnects by itself and the banner says **Box Yard updated, Refresh to load the new version**.

If the new version doesn't answer within 90 seconds, Box Yard goes straight back to the one before and the banner says so, with the server's output behind **Details**. The version before is kept for that; older ones are removed.

Settings › About › Updates shows the running commit, when it last looked, and **Check now**. With Box Yard stopped, `npx github:AgentSystemLabs/box-yard update` installs the newest `main` for the next start. A git checkout (`./yard local`) and the Docker image don't update themselves: there the About line says to `git pull` and run `./yard local` again.

## On a server (VPS)

On a fresh Ubuntu or Debian server, as a normal user (not root):

```bash
# once, as root: a user for Box Yard, Node 22 and git
adduser boxyard
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git
loginctl enable-linger boxyard   # keep its service running when nobody is logged in

# as that user (ssh boxyard@<server>)
npx github:AgentSystemLabs/box-yard service install --public
```

`service install` installs Box Yard if needed, writes a systemd user unit (`~/.config/systemd/user/box-yard.service`) that runs the installed launcher, and starts it. `--public` makes it listen on every address with a generated password, printed once and kept in `~/.boxyard/.env`. Then open `http://<server>:3000` and log in.

- Logs: `journalctl --user -u box-yard -f`. Restart: `systemctl --user restart box-yard`.
- The service keeps the options you gave (`--port`, `--host`, `--public`, `--data`). Run `service install` again to change them.
- Updates from the app work the same; the service runs whichever version is current.
- Without `loginctl enable-linger`, systemd stops user services when you log out. The command prints the line to run if it's off.
- `systemctl --user` needs a real login session for that user: `ssh boxyard@<server>`, not `su` or `sudo -u`.
- Open the port in your firewall (e.g. `ufw allow 3000`), or keep it closed and use [HTTPS](#https).

Plain `http://<ip>:3000` sends your password unencrypted. Use it on a private network or Tailscale, or put HTTPS in front.

## HTTPS

Box Yard doesn't terminate TLS itself. [Caddy](https://caddyserver.com) does it in two lines and renews the certificate on its own. Point a DNS name at the server, then:

```bash
sudo apt-get install -y caddy
printf 'yard.example.com {\n  reverse_proxy 127.0.0.1:3000\n}\n' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Keep Box Yard on `127.0.0.1` so only Caddy reaches it, tell it its public address, and give it a password:

```bash
echo 'BOXYARD_PUBLIC_URL=https://yard.example.com' >> ~/.boxyard/.env
npx github:AgentSystemLabs/box-yard service install --public --host 127.0.0.1
```

`BOXYARD_PUBLIC_URL` is the origin the browser uses, so Box Yard trusts its requests ([README › Browser request trust](../README.md#quick-start)). Open ports 80 and 443 for Caddy and keep 3000 closed.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `npm error code ENOGIT` (No git binary found) | npx itself needs git to fetch from GitHub, before the launcher can say so. Install git (`sudo apt-get install -y git`, or `xcode-select --install` on a Mac) and run the command again. |
| An install step failed | The launcher prints the step, the end of its output and a fix; the whole log is in `~/.boxyard/app/update.log`. Nothing half-installed is kept, so run the command again. |
| `better-sqlite3 didn't load` | Use Node 22 or 24 LTS, or install the build tools it names (`python3 make g++` on Debian/Ubuntu, `xcode-select --install` on a Mac). |
| Port 3000 is busy | Without `--port`, it moves to 3001 and up. With `--port` (or `PORT`), it says which process holds it. |
| "Already running" | Another Box Yard has the same data folder. It prints that one's URL. |
| Settings not picked up | Settings are read at start: restart Box Yard (`systemctl --user restart box-yard` for the service). |

## Uninstall

```bash
npx github:AgentSystemLabs/box-yard service uninstall   # if you installed the service
rm -rf ~/.boxyard/app                                     # the installed versions (keeps your data and settings)
rm -rf ~/.boxyard                                         # everything, including the database and settings
```

## How it works

`bin/box-yard.mjs` is the npx entry point. It only checks Node's version, in syntax any Node parses, then loads `launcher/main.mjs`. The launcher uses Node's own modules only, so it runs from npx's download before anything is built. It installs each commit into `~/.boxyard/app/versions/<commit>` (`launcher/install.mjs`): a git clone, so the app knows its commit; built in a staging folder and moved into place only when whole.

The server runs as the launcher's child with an IPC channel (`launcher/supervisor.mjs`). The app's Update button goes server → launcher (`server/selfUpdate.ts`); the launcher builds, swaps `app/current`, restarts the server, checks `/healthz`, and rolls back on a failure. The protocol and the update states are in `shared/selfUpdate.ts`.

The repo has no `prepare` script on purpose: npx would then install the dev dependencies and build on every run, and so would every `npm ci` in a checkout, an agent's worktree and the Docker image. The build happens only in the launcher's install. To try an update flow against your own branch, point `BOXYARD_UPDATE_REPO` at a local clone (the branch must be `main` there) and `BOXYARD_HOME` at a scratch folder.
