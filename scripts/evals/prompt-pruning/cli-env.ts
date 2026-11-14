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
