// Where an npx install of Box Yard keeps things (docs/npx.md). Everything lives under one folder, ~/.boxyard by
// default (BOXYARD_HOME moves it): the settings file, the database and the installed versions of the app.
//
//   ~/.boxyard/.env                  settings (PORT, HOST, BOXYARD_PASSWORD, keys…), read by the server
//   ~/.boxyard/data/                 the database, artifacts and uploads (BOXYARD_DATA_DIR)
//   ~/.boxyard/demo/                 `box-yard demo`'s own data, so the fake agents never touch the real ones
//   ~/.boxyard/app/versions/<sha>/   one built copy of the repo per commit of main
//   ~/.boxyard/app/current           → versions/<sha>, the one that runs
//   ~/.boxyard/app/state.json        the previous version, and updates that failed
//   ~/.boxyard/app/update.log        the output of the last install or update
//
// Plain JavaScript with Node's own modules only: this runs straight from the npx download, before anything is built.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Where the app comes from, and the branch it tracks. BOXYARD_UPDATE_REPO stands in for it (tests, forks). */
export const REPO_URL = "https://github.com/AgentSystemLabs/box-yard.git"
export const BRANCH = "main"
/** The repo's GitHub page, for the app's "What's new" link; null when it isn't on GitHub. */
export function githubPage(repo) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(String(repo ?? "").trim())
  return m ? `https://github.com/${m[1]}` : null
}

/** The command people run, for help and error text. */
export const NPX_COMMAND = "npx github:AgentSystemLabs/box-yard"
export const DEFAULT_PORT = 3000

/** `value` with a leading `~` meaning the home folder. */
export function expandHome(value, home = os.homedir()) {
  return value.replace(/^~(?=[/\\]|$)/, home)
}

/** The install's folder: BOXYARD_HOME, else ~/.boxyard. */
export function boxyardHome(env = process.env, home = os.homedir()) {
  const set = env.BOXYARD_HOME?.trim()
  return path.resolve(expandHome(set || "~/.boxyard", home))
}

/** Every path under the install's folder. */
export function layout(home) {
  const app = path.join(home, "app")
  return {
    home,
    envFile: path.join(home, ".env"),
    data: path.join(home, "data"),
    demoData: path.join(home, "demo"),
    app,
    versions: path.join(app, "versions"),
    current: path.join(app, "current"),
    state: path.join(app, "state.json"),
    updateLog: path.join(app, "update.log"),
  }
}

/** The repo updates come from. */
export function repoUrl(env = process.env) {
  return env.BOXYARD_UPDATE_REPO?.trim() || REPO_URL
}

/**
 * A .env file's settings, read the way the server reads them (server/config.ts): `KEY=value` lines, `export ` allowed,
 * one pair of quotes stripped, comments and blank lines skipped. The first line for a key wins.
 */
export function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "")
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in out)) out[key] = value
  }
  return out
}

/** The settings file's values, or {} when there is none yet. */
export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

/** The settings file a first run writes: a pointer to every option, and nothing set. */
export const ENV_TEMPLATE = `# Box Yard settings, read at every start (${NPX_COMMAND}).
# Every option, explained: https://github.com/AgentSystemLabs/box-yard/blob/main/.env.example
# Claude, Codex and GitHub logins are easier to add in the app: Settings › Credentials.
#
# PORT=3000
# Reach Box Yard from other devices (phone, LAN, Tailscale, a VPS): \`${NPX_COMMAND} --public\` writes a
# strong BOXYARD_PASSWORD here and listens on every address.
# BOXYARD_PASSWORD=
# HOST=0.0.0.0
# Behind HTTPS on your own domain (docs/npx.md › HTTPS):
# BOXYARD_DOMAIN=yard.example.com
`

/** Make the settings file if there isn't one, readable by this user only. Returns whether it made it. */
export function ensureEnvFile(file) {
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, ENV_TEMPLATE, { mode: 0o600 })
  return true
}

/**
 * A setting as the server will see it: the real environment wins over the settings file (server/config.ts loads the
 * file without overriding). Empty counts as unset.
 */
export function setting(name, env, fileEnv) {
  const v = env[name] ?? fileEnv[name]
  return v === undefined || v.trim() === "" ? undefined : v.trim()
}

/** A folder from a setting: `~` is the home folder, and a relative path is relative to the install's folder. */
export function settingPath(value, home, userHome = os.homedir()) {
  return path.resolve(home, expandHome(value, userHome))
}
