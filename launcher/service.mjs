// `box-yard service install`: keep Box Yard running on a Linux server (a systemd user service), across logouts and
// reboots. It runs app/current's launcher, so an update from the app is what the next service start runs too.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runLogged } from "./install.mjs"

export const UNIT_NAME = "box-yard.service"

/** Where systemd looks for this user's units. */
export function unitPath(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "systemd", "user", UNIT_NAME)
}

const quote = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`

/**
 * The unit. KillMode=process: stopping it signals only the launcher, which stops the server. Agents' turns run
 * detached and must outlive a restart, as they do when you press Ctrl-C (systemd's default would kill them all).
 */
export function unitText({ node, launcher, args, env }) {
  const envLines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
  return [
    "[Unit]",
    "Description=Box Yard",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[node, launcher, "start", "--no-open", ...args].map(quote).join(" ")}`,
    ...envLines,
    "Restart=on-failure",
    "RestartSec=5",
    "KillMode=process",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

/**
 * Write the unit and start it. `args` are the start flags to keep (--port, --host…). Returns an exit code; `log`
 * hears what happened and what to do next.
 */
export async function installService({ layout, args, env, log, run = runLogged, platform = process.platform, user = os.userInfo().username, file = unitPath() }) {
  if (platform !== "linux") {
    log("✗ `service install` sets up a systemd service, so it's for Linux servers.")
    log("  → On a Mac, keep Box Yard running in a terminal tab (or tmux); it picks up running tasks again when it restarts.")
    return 1
  }
  const launcher = path.join(layout.current, "bin", "box-yard.mjs")
  const keep = { PATH: env.PATH, ...(env.BOXYARD_HOME ? { BOXYARD_HOME: env.BOXYARD_HOME } : {}) }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, unitText({ node: process.execPath, launcher, args, env: keep }))
  log(`▸ Wrote ${file}`)
  for (const cmd of [["daemon-reload"], ["enable", "--now", UNIT_NAME]]) {
    const r = await run("systemctl", ["--user", ...cmd], { cwd: layout.home, env })
    if (r.code !== 0) {
      log(`✗ systemctl --user ${cmd.join(" ")} failed:${r.tail ? `\n${r.tail.replace(/^/gm, "    ")}` : ""}`)
      if (/bus|XDG_RUNTIME_DIR/i.test(r.tail)) {
        log(`  → systemd has no session for ${user} here (common after su or sudo -u). Log in as ${user} directly (ssh ${user}@<server>) and run this again.`)
      }
      return 1
    }
  }
  const linger = await run("loginctl", ["show-user", user, "--property=Linger"], { cwd: layout.home, env })
  log(`✓ Box Yard runs as a service now. Logs: journalctl --user -u box-yard -f`)
  if (linger.code !== 0 || /Linger=no/.test(linger.tail)) {
    log(`! To keep it running after you log out, and start it at boot, run once: sudo loginctl enable-linger ${user}`)
  }
  return 0
}

export async function uninstallService({ layout, env, log, run = runLogged, file = unitPath() }) {
  if (!fs.existsSync(file)) {
    log("No Box Yard service is installed.")
    return 0
  }
  await run("systemctl", ["--user", "disable", "--now", UNIT_NAME], { cwd: layout.home, env })
  fs.rmSync(file, { force: true })
  await run("systemctl", ["--user", "daemon-reload"], { cwd: layout.home, env })
  log(`✓ Removed the Box Yard service. Your data in ${layout.home} is still there.`)
  return 0
}
