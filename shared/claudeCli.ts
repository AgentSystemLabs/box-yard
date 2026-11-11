// Which Claude Code a model needs, and what Box Yard says when a runner's is older. A CLI that doesn't know a model
// still runs it, but in the 200k-token window it assumes for any unknown model: Fable 5.2 (1M) then auto-compacts five
// times too early, and a turn that reads big files ends in "Autocompact is thrashing". So Box Yard updates the CLI where
// it may (its own sandboxes), refuses the turn where it may not (this computer, SSH machines), and stops a turn whose
// CLI says it doesn't recognize the model (runner/box-runner.mjs). Pure, so it is unit tested.

export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code"

/** The first Claude Code that knows each model an older one doesn't. Add a model here when a release brings it. */
const MIN_CLI_FOR_MODEL: Readonly<Record<string, string>> = {
  "claude-fable-5-2": "2.1.321",
}

/** What a new box gets at least: the newest minimum above, so every model the pickers offer runs there. */
export const MIN_CLAUDE_CLI = Object.values(MIN_CLI_FOR_MODEL).reduce((a, b) => (versionBelow(a, b) ? b : a))

/** The window a CLI assumes for a model it doesn't know. */
export const UNKNOWN_MODEL_WINDOW = "200k"

/** "2.1.293" from `claude --version`'s "2.1.293 (Claude Code)". Null for anything else: a wrapper, a test's fake CLI. */
export function claudeCliVersion(text: string | null | undefined): string | null {
  return /(?:^|\n)\s*(\d+\.\d+\.\d+)\s*\(Claude Code\)/.exec(text ?? "")?.[1] ?? null
}

/** Whether version `a` is older than `b` ("2.1.293" is below "2.1.321"). */
export function versionBelow(a: string, b: string): boolean {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d < 0
  }
  return false
}

/** A model name as the table has it: no "[1m]" and no date suffix ("claude-fable-5-2-20261101[1m]" is claude-fable-5-2). */
const bareModel = (model: string) => model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")

/** The oldest Claude Code that knows `model`, or null when any does (or Box Yard can't tell: only the CLI can then). */
export function minClaudeCliFor(model: string | null | undefined): string | null {
  return (model && MIN_CLI_FOR_MODEL[bareModel(model)]) || null
}

/** Whether a CLI at `version` is too old for `model`. False when either is unknown. */
export function claudeCliTooOld(version: string | null, model: string | null | undefined): boolean {
  const min = minClaudeCliFor(model)
  return Boolean(version && min && versionBelow(version, min))
}

const UPDATE = `npm install -g ${CLAUDE_CODE_PACKAGE}@latest`

/** The update for a sandbox Box Yard manages, with sudo where the first try isn't allowed; npm's last words go to stderr when both fail. */
export const CLAUDE_CLI_UPDATE_SCRIPT = `out=$(${UPDATE} --no-audit --no-fund 2>&1) || sudo -n ${UPDATE} --no-audit --no-fund >/dev/null 2>&1 || printf '%s\\n' "$out" | tail -n 5 >&2`

/**
 * Shell for a box's setup: install Claude Code when it is missing or older than `min` (a snapshot keeps the CLI it was
 * made with, and boxes run with the auto-updater off). A failed update of one that is there doesn't fail the setup:
 * the turn that needs the newer one says so (TaskManager.ensureClaudeCli).
 */
export function claudeCliFloorScript(min: string = MIN_CLAUDE_CLI): string {
  const current = `"$(claude --version 2>/dev/null | grep -oE '^[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`
  const atLeast = `[ "$(printf '%s\\n' ${min} ${current} | sort -V | head -n1)" = ${min} ]`
  return `{ { command -v claude >/dev/null && ${atLeast}; } || npm install -g ${CLAUDE_CODE_PACKAGE}@latest >/dev/null 2>&1 || command -v claude >/dev/null; }`
}

export interface OldClaudeCli {
  model: string
  /** The runner's `claude --version`, when it answered. */
  cliVersion: string | null
  /** "this computer", "SSH machine build-1", "box abc". */
  where: string
  /** Box Yard may update the CLI there (its own sandboxes); otherwise it's the owner's to update. */
  managed: boolean
}

/** The start every such error shares; web/src/lib/failure.ts reads it. */
const cliLine = (o: Pick<OldClaudeCli, "model" | "cliVersion" | "where">) => {
  const min = minClaudeCliFor(o.model)
  return `Claude Code${o.cliVersion ? ` ${o.cliVersion}` : ""} on ${o.where} doesn't know the model ${o.model}${min ? `, which needs Claude Code ${min} or later` : ""}.`
}

const ownerFix = `Update it there (claude update, or ${UPDATE}), or pick a model it knows, then retry.`

/** Before a turn, where Box Yard doesn't install: the turn is refused, with why and what to do. */
export function claudeCliRefusal(o: Omit<OldClaudeCli, "managed">): string {
  return `${cliLine(o)} It would run it in a ${UNKNOWN_MODEL_WINDOW}-token window and thrash on auto-compact, so the turn wasn't started. ${ownerFix}`
}

/** Before a turn, in a sandbox: the CLI is too old and the update didn't take (`why`: npm's last words, or what it still is). */
export function claudeCliUpdateFailed(o: Omit<OldClaudeCli, "managed"> & { why: string }): string {
  return `${cliLine(o)} Updating it there failed (${UPDATE}): ${o.why}. Retry, or pick a model it knows.`
}

/** A turn the runner stopped because its CLI said it doesn't recognize the model. */
export function unrecognizedModelError(o: OldClaudeCli): string {
  const next = o.managed
    ? "Box Yard updates Claude Code there before its next turn: retry. If it still fails, the model name is wrong."
    : `${ownerFix} If it's already the latest, the model name is wrong.`
  return `${cliLine(o)} It would run it in a ${UNKNOWN_MODEL_WINDOW}-token window and thrash on auto-compact, so Box Yard stopped the turn. ${next}`
}
