// What a computer needs before Box Yard can install and start, checked up front so a missing piece is named with the
// command that fixes it, on this OS, instead of failing halfway through an install or a task.
//
// A "stop" problem ends the launch: Box Yard can't install or run without it. A "warn" one doesn't: the app's Setup
// card covers it (signing in to Claude, Codex, GitHub), or it only limits something.
// Every check reads the computer through `probe`, so tests can describe any computer.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { NPX_COMMAND } from "./paths.mjs"

/** The oldest Node.js Box Yard installs on: Vite's build needs ^20.19 || >=22.12, and Node 20 left support in April 2026. */
export const MIN_NODE = "22.12.0"
/** Free space an install needs: a clone, its dependencies while it builds, and the build. */
export const INSTALL_FREE_BYTES = 1024 ** 3
/** Below this the server itself is short of room for workspaces and the database. */
export const LOW_FREE_BYTES = 2 * 1024 ** 3

/** Whether Node `version` ("22.11.0" or "v22.11.0") is older than `min`. */
export function nodeTooOld(version, min = MIN_NODE) {
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0)
  const [a, b] = [parse(version), parse(min)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

/** The kind of system, for install commands: mac, debian (apt), fedora (dnf), arch (pacman), alpine (apk), linux, windows. */
export function osFamily(platform, osRelease = "") {
  if (platform === "darwin") return "mac"
  if (platform === "win32") return "windows"
  const ids = (osRelease.match(/^ID(?:_LIKE)?=.*$/gm) ?? []).join(" ").toLowerCase()
  if (/debian|ubuntu/.test(ids)) return "debian"
  if (/fedora|rhel|centos|rocky|almalinux/.test(ids)) return "fedora"
  if (/arch/.test(ids)) return "arch"
  if (/alpine/.test(ids)) return "alpine"
  return "linux"
}

const PACKAGE_INSTALL = {
  debian: (pkgs) => `sudo apt-get install -y ${pkgs}`,
  fedora: (pkgs) => `sudo dnf install -y ${pkgs}`,
  arch: (pkgs) => `sudo pacman -S --needed ${pkgs}`,
  alpine: (pkgs) => `sudo apk add ${pkgs}`,
}

/** The command (or page) that installs `tool` on `family`. */
export function installHint(tool, family) {
  switch (tool) {
    case "node":
      return family === "mac"
        ? "brew install node@22, or the LTS installer from https://nodejs.org (with nvm: nvm install 22)"
        : "the LTS from https://nodejs.org/en/download, or with nvm: nvm install 22 && nvm use 22"
    case "git":
      if (family === "mac") return "xcode-select --install (or brew install git)"
      return PACKAGE_INSTALL[family]?.("git") ?? "your package manager's git package (https://git-scm.com/downloads)"
    case "build-tools":
      if (family === "mac") return "xcode-select --install"
      if (family === "debian") return PACKAGE_INSTALL.debian("python3 make g++")
      if (family === "fedora") return PACKAGE_INSTALL.fedora("python3 make gcc-c++")
      if (family === "arch") return PACKAGE_INSTALL.arch("python make gcc")
      if (family === "alpine") return PACKAGE_INSTALL.alpine("python3 make g++")
      return "Python 3, make and a C++ compiler"
    case "claude":
      return "npm install -g @anthropic-ai/claude-code, then run claude once and log in"
    case "gh":
      if (family === "mac") return "brew install gh, then gh auth login"
      return "https://github.com/cli/cli#installation, then gh auth login"
    default:
      return tool
  }
}

/** "1.4 GB" */
export function formatBytes(n) {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`
}

/**
 * Check this computer. `want` says what this launch needs:
 * - `install`: no built version yet, so git, npm and room for a build are needed now
 * - `dirs`: folders Box Yard must be able to write (its home and the data folder)
 * - `agents`: real agents run here (not `demo`), so look for claude and gh
 * - `allowRoot`: `--allow-root` was given
 * Returns `{ stop: Problem[], warn: Problem[] }`, each `{ id, message, fix }`.
 */
export async function checkComputer(want, probe = realProbe()) {
  const stop = []
  const warn = []
  const family = osFamily(probe.platform, probe.osRelease())

  if (probe.platform === "win32") {
    stop.push({
      id: "windows",
      message: "Box Yard runs on macOS and Linux. On Windows, run it inside WSL 2 (Ubuntu).",
      fix: `wsl --install, then in the Ubuntu terminal install Node.js 22 and git and run ${NPX_COMMAND}`,
    })
    return { stop, warn }
  }
  if (nodeTooOld(probe.nodeVersion)) {
    stop.push({ id: "node", message: `Box Yard needs Node.js ${MIN_NODE} or newer; this is ${probe.nodeVersion}.`, fix: `Install it: ${installHint("node", family)}` })
  }
  if (probe.uid === 0 && !want.allowRoot) {
    stop.push({
      id: "root",
      message:
        "You're running as root. Box Yard's agents run Claude Code with full permissions on this computer, and Claude Code refuses to do that as root, so every task would fail.",
      fix: `Make a user and run it as that user: adduser boxyard, then log in as boxyard (ssh boxyard@<server>) and run ${NPX_COMMAND}. If your agents only run in Upstash boxes or Docker, add --allow-root.`,
    })
  }
  if (!probe.which("git")) {
    stop.push({ id: "git", message: "git isn't installed. Box Yard installs and updates itself with it, and every task works in a git checkout.", fix: `Install it: ${installHint("git", family)}` })
  }
  if (want.install && !probe.which("npm")) {
    stop.push({ id: "npm", message: "npm isn't on the PATH. It comes with Node.js and installs Box Yard's dependencies.", fix: `Reinstall Node.js: ${installHint("node", family)}` })
  }
  for (const dir of want.dirs ?? []) {
    const err = probe.writable(dir)
    if (err) {
      stop.push({
        id: "writable",
        message: `Box Yard can't write to ${dir} (${err}).`,
        fix: probe.uid === 0 ? `Pick another folder with BOXYARD_HOME or --data.` : `Give it back to your user: sudo chown -R "$USER" ${quote(dir)}, or pick another folder with BOXYARD_HOME or --data.`,
      })
      break
    }
  }
  const free = want.dirs?.length ? probe.freeBytes(want.dirs[0]) : null
  if (free !== null && want.install && free < INSTALL_FREE_BYTES) {
    stop.push({ id: "disk", message: `Only ${formatBytes(free)} is free on the disk with ${want.dirs[0]}; installing Box Yard needs about ${formatBytes(INSTALL_FREE_BYTES)}.`, fix: "Free some space, or set BOXYARD_HOME to a folder on a bigger disk." })
  } else if (free !== null && free < LOW_FREE_BYTES) {
    warn.push({ id: "disk", message: `Only ${formatBytes(free)} is free on the disk with ${want.dirs[0]}. Agents need room for their checkouts.`, fix: "Free some space when you can." })
  }

  if (want.agents) {
    if (!probe.which("claude")) {
      warn.push({ id: "claude", message: "Claude Code (claude) isn't installed. Agents on this computer run it.", fix: `Install it: ${installHint("claude", family)}. Or add a Claude key in the app and run agents in Upstash boxes or Docker.` })
    }
    if (!probe.which("gh")) {
      warn.push({ id: "gh", message: "The GitHub CLI (gh) isn't installed. Agents use it to open pull requests; a GitHub token in Settings › Credentials works too.", fix: `Install it: ${installHint("gh", family)}` })
    }
  }
  return { stop, warn }
}

const quote = (s) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * Whether `port` is free on `host`, and on the wildcard addresses: on macOS a server on 0.0.0.0 or :: doesn't stop
 * another from taking 127.0.0.1, and the two would split the connections. An address this computer doesn't have
 * (no IPv6) counts as free.
 */
export function portFree(port, host = "127.0.0.1") {
  const hosts = [...new Set([host, "0.0.0.0", "::"])]
  return hosts.reduce((ok, h) => ok.then((free) => free && tryListen(port, h)), Promise.resolve(true))
}

function tryListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", (err) => resolve(err.code !== "EADDRINUSE" && err.code !== "EACCES"))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** Which process listens on `port`, e.g. "node (pid 4242)", from lsof; null when unknown. */
export function portHolder(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    const pid = /^p(\d+)/m.exec(out)?.[1]
    const cmd = /^c(.+)/m.exec(out)?.[1]
    return pid ? `${cmd ?? "a process"} (pid ${pid})` : null
  } catch {
    return null
  }
}

/**
 * The port to listen on. An explicit one (flag, env or settings file) must be free. The default (3000) moves to the
 * next free one up to 3020, so a second app on 3000 doesn't stop Box Yard. Returns `{ port, moved }` or `{ error }`.
 */
export async function pickPort({ port, explicit, host }, free = portFree, holder = portHolder) {
  if (await free(port, host)) return { port, moved: false }
  if (explicit) {
    const who = holder(port)
    return { error: `Port ${port} is already in use${who ? ` by ${who}` : ""}.`, fix: `Stop that, or pick another port: --port ${port + 1} (or PORT in the settings file).` }
  }
  for (let p = port + 1; p <= port + 20; p++) if (await free(p, host)) return { port: p, moved: true }
  return { error: `Ports ${port}–${port + 20} are all in use.`, fix: "Pick a free one with --port." }
}

/** This computer, as checkComputer reads it. */
export function realProbe() {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    osRelease: () => {
      try {
        return fs.readFileSync("/etc/os-release", "utf8")
      } catch {
        return ""
      }
    },
    which,
    writable: (dir) => {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const probe = path.join(dir, `.write-test-${process.pid}`)
        fs.writeFileSync(probe, "")
        fs.rmSync(probe)
        return null
      } catch (err) {
        return err?.code ?? String(err)
      }
    },
    freeBytes: (dir) => {
      try {
        let at = dir
        while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at)
        const s = fs.statfsSync(at)
        return s.bavail * s.bsize
      } catch {
        return null
      }
    },
  }
}

/** The full path of `cmd` on the PATH, or null. */
export function which(cmd, envPath = process.env.PATH ?? "") {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, cmd)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      // not here
    }
  }
  return null
}

/** Lines for a problem list: "✗ message" then "  → fix". */
export function formatProblems(problems, mark) {
  return problems.flatMap((p) => [`${mark} ${p.message}`, ...(p.fix ? [`  → ${p.fix}`] : [])])
}
