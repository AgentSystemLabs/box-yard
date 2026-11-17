// open_on_computer (server/mcp.ts): the Coordinator and Captains open a file, folder, artifact or web link on the
// computer running Box Yard, for Cody to look at. Neither has a shell, and this must not hand them one: the command is
// a fixed binary with an argument array (never a shell string), paths are absolute and must exist, and anything that
// would run, install or redirect when opened (apps, scripts, installers, location files, executables) is only revealed
// in Finder. Links are http(s) only: other schemes start apps.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

/**
 * Extensions whose default app runs, installs or follows the file instead of showing it. Opening one of these could run
 * code a box agent or a create_artifact call wrote, so they're revealed in Finder instead.
 */
export const LAUNCH_EXTENSIONS: ReadonlySet<string> = new Set([
  // Apps, plug-ins and other bundles macOS runs or installs.
  ".app", ".appex", ".bundle", ".component", ".dext", ".framework", ".kext", ".mdimporter", ".osax", ".plugin", ".prefpane", ".qlgenerator", ".saver", ".service", ".systemextension", ".vst", ".vst3", ".wdgt", ".xpc",
  // Scripts and automation: Terminal, Python Launcher, Java, Automator, Shortcuts and Script Editor run or install them.
  ".command", ".tool", ".terminal", ".sh", ".bash", ".zsh", ".csh", ".tcsh", ".ksh", ".fish", ".py", ".pyw", ".pyc", ".pyo", ".pl", ".rb", ".php", ".jar", ".scpt", ".scptd", ".applescript", ".workflow", ".action", ".shortcut", ".alfredworkflow",
  // Installers, disk images, profiles and certificates.
  ".pkg", ".mpkg", ".dmg", ".mobileconfig", ".provisionprofile", ".cer", ".crt", ".der", ".p12", ".pfx", ".p7b", ".keychain",
  // Location files, which open whatever file or URL they point at.
  ".fileloc", ".webloc", ".inetloc", ".url", ".afploc", ".ftploc",
  // Other platforms' launchers and packages (xdg-open on Linux).
  ".desktop", ".appimage", ".deb", ".rpm", ".run", ".flatpakref", ".snap", ".exe", ".msi", ".bat", ".cmd", ".ps1", ".vbs",
])

/** What to open: a file or folder on this computer, or a web page. `label` names it in the reply. */
export type OpenTarget = { kind: "path"; path: string; label?: string } | { kind: "url"; url: string; label?: string }

export interface OpenResult {
  /** The path or link it opened. */
  target: string
  /** What happened, in a sentence for Cody. */
  done: string
  /** Why it was revealed instead of opened, or that the opener hadn't answered yet. */
  note?: string
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const ARTIFACT_ID = /^art_[a-f0-9]{12}$/
const ARTIFACT_PATH = /^\/artifacts\/(art_[a-f0-9]{12})(?:[/?#]|$)/

/** The artifact `ref` names: its id alone, its /artifacts/ path, or an http(s) URL to that path. */
export function artifactIdIn(ref: string): string | null {
  const raw = ref.trim()
  if (ARTIFACT_ID.test(raw)) return raw
  if (raw.startsWith("/artifacts/")) return ARTIFACT_PATH.exec(raw)?.[1] ?? null
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    return ARTIFACT_PATH.exec(new URL(raw).pathname)?.[1] ?? null
  } catch {
    return null
  }
}

/** An http(s) link, normalised; null when `ref` isn't a link at all. Other schemes are refused: they start apps. */
export function webLink(ref: string): string | null {
  const raw = ref.trim()
  if (!SCHEME.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" isn't a valid link.`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) links open: a ${url.protocol} link can start another app. For a file, give its absolute path.`)
  }
  return url.href
}

/** An absolute path (or ~/…) that exists, resolved. Relative paths and anything starting with "-" are refused. */
export function localPath(ref: string, home = os.homedir()): string {
  const raw = ref.trim()
  if (!raw) throw new Error("Give an absolute path, an artifact id or an http(s) link.")
  if (raw.startsWith("-")) throw new Error(`"${raw}" starts with "-". Give an absolute path.`)
  if (raw.includes("\0")) throw new Error("That path has a NUL byte in it.")
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw
  if (!path.isAbsolute(expanded)) throw new Error(`"${raw}" isn't an absolute path. Give the full path (/Users/… or ~/…), an artifact id or an http(s) link.`)
  const full = path.resolve(expanded)
  if (!fs.existsSync(full)) throw new Error(`Nothing at ${full}.`)
  const st = fs.statSync(full)
  if (!st.isFile() && !st.isDirectory()) throw new Error(`${full} isn't a file or folder.`)
  return full
}

const extOf = (p: string) => path.extname(path.basename(p).replace(/[\s.]+$/, "")).toLowerCase()

/**
 * Why opening `file` could run something, or null when it only shows it: a launch extension (on the path or what a
 * symlink points at), an app-style bundle folder, or an executable file (Terminal runs those).
 */
export function launchRisk(file: string): string | null {
  let real = file
  try {
    real = fs.realpathSync(file)
  } catch {
    // Checked as given.
  }
  for (const p of new Set([file, real])) {
    const ext = extOf(p)
    if (LAUNCH_EXTENSIONS.has(ext)) return `a ${ext} file runs, installs or redirects when it's opened`
  }
  const st = fs.statSync(real)
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(real, "Contents", "MacOS")) || fs.existsSync(path.join(real, "Contents", "Info.plist"))) return "it's an app or plug-in bundle, which runs when it's opened"
    return null
  }
  if ((st.mode & 0o111) !== 0) return "it's an executable file, which runs when it's opened"
  return null
}

/**
 * The env the opener runs with. macOS apps `open` starts inherit it, so it carries nothing of the server's own
 * (tokens, API keys): only what finding the user's session and language needs.
 */
const ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "__CF_USER_TEXT_ENCODING",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS", "DESKTOP_SESSION",
]
export function openerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]))
}

/** How many opens a minute, across every caller: a confused model can't fill Cody's screen with windows. */
export const OPENS_PER_MINUTE = 10
/** The opener normally answers at once; past this it's still starting (xdg-open may wait on the app). */
const ANSWER_MS = 10_000

export interface OpenerDeps {
  platform?: NodeJS.Platform
  /** Tests pass a fake; without one, tests are refused rather than running the real `open`. */
  spawn?: Spawn
  env?: NodeJS.ProcessEnv
  now?: () => number
  answerMs?: number
}

/** Opens files, folders and links on this computer: macOS `open`, or xdg-open on a Linux desktop. */
export class ComputerOpener {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly answerMs: number
  private readonly spawn: Spawn
  private recent: number[] = []

  constructor(deps: OpenerDeps = {}) {
    this.platform = deps.platform ?? process.platform
    this.env = deps.env ?? process.env
    this.now = deps.now ?? Date.now
    this.answerMs = deps.answerMs ?? ANSWER_MS
    this.spawn =
      deps.spawn ??
      ((command, args, options) => {
        // Never pop windows on the computer running the tests.
        if (process.env.VITEST) throw new Error("Tests never run the real opener: pass a fake spawn.")
        return nodeSpawn(command, args, options)
      })
  }

  /** "Finder" on macOS, "the file manager" elsewhere. */
  get finder(): string {
    return this.platform === "darwin" ? "Finder" : "the file manager"
  }

  /** Why this computer can't open things, or null when it can. */
  unsupported(): string | null {
    if (this.platform === "darwin") return null
    if (this.platform === "linux") {
      return this.env.DISPLAY || this.env.WAYLAND_DISPLAY ? null : "Box Yard runs on Linux here without a desktop session (no DISPLAY or WAYLAND_DISPLAY), so there's no screen to open it on."
    }
    return `Opening things works only when Box Yard runs on macOS (or a Linux desktop); this server runs on ${this.platform}.`
  }

  /**
   * Open `target` in its default app, or reveal it in Finder (`reveal`, or when opening could run it). Resolves once
   * the opener has handed it over; rejects with the opener's own error (a missing app, no session).
   */
  async open(target: OpenTarget, opts: { reveal?: boolean } = {}): Promise<OpenResult> {
    const why = this.unsupported()
    if (why) throw new Error(why)
    const now = this.now()
    this.recent = this.recent.filter((t) => now - t < 60_000)
    if (this.recent.length >= OPENS_PER_MINUTE) throw new Error(`Opened ${OPENS_PER_MINUTE} things in the last minute already. Wait a minute before opening more.`)

    let args: string[]
    let done: string
    let note: string | undefined
    if (target.kind === "url") {
      const url = webLink(target.url)
      if (!url) throw new Error(`"${target.url}" isn't an http(s) link.`)
      args = [url]
      done = `Opened ${target.label ?? url} in the browser.`
    } else {
      const file = localPath(target.path)
      const risk = launchRisk(file)
      const name = target.label ?? file
      if (opts.reveal || risk) {
        // Linux has no "reveal": open the folder it's in.
        args = this.platform === "darwin" ? ["-R", file] : [fs.statSync(file).isDirectory() ? file : path.dirname(file)]
        done = `Showed ${name} in ${this.finder}.`
        if (risk && !opts.reveal) note = `Not opened, because ${risk}. It's selected in ${this.finder}, to open from there by hand.`
      } else {
        args = [file]
        done = `Opened ${name}${fs.statSync(file).isDirectory() ? ` in ${this.finder}` : " in its default app"}.`
      }
    }
    // A fixed binary and an argument array, never a shell: every argument is an absolute path, "-R" or an http(s) URL.
    const command = this.platform === "darwin" ? "/usr/bin/open" : "xdg-open"
    this.recent.push(now)
    const answered = await this.run(command, args)
    const shown = target.kind === "url" ? args[0]! : args[args.length - 1]!
    return { target: shown, done, ...(note || !answered ? { note: [note, answered ? "" : `${command} hasn't answered yet; it may still be starting.`].filter(Boolean).join(" ") } : {}) }
  }

  /** Run the opener; true once it exited 0, false if it's still running after answerMs. */
  private run(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], env: openerEnv(this.env), windowsHide: true })
      } catch (err) {
        reject(err)
        return
      }
      let stderr = ""
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      child.stderr?.on("data", (d: Buffer | string) => {
        if (stderr.length < 2000) stderr += String(d)
      })
      const timer = setTimeout(
        () =>
          settle(() => {
            child.stderr?.destroy()
            child.unref()
            resolve(false)
          }),
        this.answerMs,
      )
      child.once("error", (err: NodeJS.ErrnoException) =>
        settle(() => reject(err.code === "ENOENT" ? new Error(`${command} isn't installed on this computer, so Box Yard can't open things here.`) : err)),
      )
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) =>
        settle(() => (code === 0 ? resolve(true) : reject(new Error(`${path.basename(command)} failed (${code ?? signal}): ${stderr.trim().slice(0, 500) || "no message"}`)))),
      )
    })
  }
}
