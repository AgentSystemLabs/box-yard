// Claude Code on a runner, checked against the model a turn asks for before the turn starts (shared/claudeCli.ts says
// why: an older CLI runs a model it doesn't know in a 200k-token window, and the turn thrashes on auto-compact).
// TaskManager.ensureClaudeCli calls this with the box's exec; it is its own module so tests drive it with a fake one.
import { CLAUDE_CLI_UPDATE_SCRIPT, claudeCliRefusal, claudeCliTooOld, claudeCliUpdateFailed, claudeCliVersion } from "../shared/claudeCli.js"
import { errorTail } from "./archive.js"
import type { ExecResult } from "./providers/types.js"

export interface CliRunner {
  exec: (command: string) => Promise<ExecResult>
  /** The command a turn starts there: "claude" on a box, the configured one on this computer. */
  claudeBin: string
  /** Box Yard may install there: its own sandboxes, never this computer or an SSH machine. */
  managed: boolean
  /** "the box", "this computer", "SSH machine build-1". */
  where: string
}

export interface CliCheck {
  /** What `claude --version` says there now; null when it didn't say (a wrapper, a test's fake CLI). */
  version: string | null
  /** Set when this check updated the CLI: the version it replaced. */
  updatedFrom?: string | null
}

/**
 * Make sure the runner's Claude Code knows `model`, updating it where Box Yard may. Throws what the task should say
 * when it is too old and stays so: on the owner's own machine (never updated from here), or after a failed update.
 * `stale`: a turn there was stopped because its CLI didn't recognize a model Box Yard has no minimum for, so a sandbox
 * gets the latest whatever its version; if that changes nothing, the turn runs and the runner stops it again.
 */
export async function ensureClaudeCliKnows(model: string, runner: CliRunner, opts: { stale?: boolean } = {}): Promise<CliCheck> {
  const probe = `${runner.claudeBin} --version`
  const version = claudeCliVersion((await runner.exec(probe)).stdout)
  const tooOld = claudeCliTooOld(version, model)
  if (!tooOld && !(opts.stale && runner.managed)) return { version }
  if (!runner.managed) throw new Error(claudeCliRefusal({ model, cliVersion: version, where: runner.where }))
  const res = await runner.exec(`{ ${CLAUDE_CLI_UPDATE_SCRIPT}; } ; ${probe}`)
  const now = claudeCliVersion(res.stdout)
  if (tooOld && (!now || claudeCliTooOld(now, model))) {
    const why = errorTail(res.stderr) || (now ? `it is still ${now}` : `exit code ${res.exitCode}`)
    throw new Error(claudeCliUpdateFailed({ model, cliVersion: version, where: runner.where, why }))
  }
  return now && now !== version ? { version: now, updatedFrom: version } : { version: now ?? version }
}
