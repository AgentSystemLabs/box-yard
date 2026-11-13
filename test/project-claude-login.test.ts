import { afterEach, describe, expect, it, vi } from "vitest"
import { chatClaudeLogin, type OwnClaudeLogin } from "../server/chatAgent.js"
import { projectClaudeLogin, serverClaudeEnv, turnEnv } from "../server/turnCredentials.js"

// A project's Captain (and its side threads) picks its Claude login in a task turn's order (turnEnv): the project's
// env vars, then its identity's own login, then (null here) the rotation or Settings › Credentials.

const project = { id: "prj_demo01", name: "demo" }
const acme: OwnClaudeLogin = { env: { ANTHROPIC_API_KEY: "identity-key" }, source: "Acme identity", scope: "identity:idn_acme01" }

describe("projectClaudeLogin", () => {
  it("uses a Claude token in the project's env vars, labelled as the project's", () => {
    expect(projectClaudeLogin(project, { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" }, () => null)).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" },
      source: "demo's env vars",
      scope: "project:prj_demo01",
    })
  })

  it("uses the identity's own login when the project's env vars have none", () => {
    expect(projectClaudeLogin(project, { OTHER: "x" }, () => acme)).toBe(acme)
  })

  it("puts the project's env vars before its identity's login, without asking the identity", () => {
    const identity = vi.fn(() => acme)
    expect(projectClaudeLogin(project, { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" }, identity)?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "project-oauth" })
    expect(identity).not.toHaveBeenCalled()
  })

  it("has none of its own with neither, so the rotation or Settings › Credentials decides", () => {
    expect(projectClaudeLogin(project, {}, () => null)).toBeNull()
  })

  it("matches a task turn's pick: only the strongest var, empty ones don't count, and no other project env var", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth", ANTHROPIC_API_KEY: "project-key", ANTHROPIC_AUTH_TOKEN: "", GITHUB_TOKEN: "gh", DATABASE_URL: "postgres://x" }
    const own = projectClaudeLogin(project, env, () => acme)!
    expect(own.env).toEqual({ ANTHROPIC_API_KEY: "project-key" })
    const turn = turnEnv(env, { claude: acme.env, githubToken: "" })
    expect(turn.claudeFrom).toBe("project")
    expect(Object.fromEntries(Object.entries(turn.env).filter(([k]) => k.startsWith("ANTHROPIC") || k.startsWith("CLAUDE_CODE")))).toEqual(own.env)
  })
})

describe("a Captain's claude env with the project's login", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it("gets exactly that one Claude var, over the server's and Settings', and the login is filed under the project", () => {
    process.env.ANTHROPIC_API_KEY = "server-key"
    process.env.ANTHROPIC_AUTH_TOKEN = "server-auth"
    const own = projectClaudeLogin(project, { CLAUDE_CODE_OAUTH_TOKEN: "project-oauth", DATABASE_URL: "postgres://x" }, () => acme)!
    const env = serverClaudeEnv(own.env, { ANTHROPIC_API_KEY: "settings-key" })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("project-oauth")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.DATABASE_URL).toBe(saved.DATABASE_URL)
    expect(chatClaudeLogin(env, own)).toMatchObject({ harness: "claude", kind: "oauth_token", source: "demo's env vars", scope: "project:prj_demo01" })
  })
})
