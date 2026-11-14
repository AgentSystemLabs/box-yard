import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The environment for a `claude` run in these evals: the machine's own login, not the calling agent's. It drops the
 * caller's CLAUDE_* session vars (a Box Yard task's CLAUDE_CONFIG_DIR has no login of its own) and any GitHub or API
 * tokens, which an eval never needs.
 */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDE|^GH_|^GITHUB_|_TOKEN$|_API_KEY$/.test(k)) env[k] = v
  return { ...env, DISABLE_TELEMETRY: "1" }
}

/**
 * Even with --no-session-persistence, a `claude` run makes an empty ~/.claude/projects/<its cwd, every
 * non-alphanumeric as "-"> folder. Call this once nothing runs in `cwd` any more, so a bench leaves nothing there. It
 * removes empty folders only: one with anything in it stays.
 */
export function removeEmptyProjectDir(cwd: string): void {
  let dir: string
  try {
    dir = path.join(os.homedir(), ".claude", "projects", fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"))
  } catch {
    return
  }
  const prune = (d: string): void => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(d, e.name))
      fs.rmdirSync(d)
    } catch {
      /* gone already, or not empty: leave it */
    }
  }
  prune(dir)
}
