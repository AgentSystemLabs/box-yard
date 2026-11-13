import { afterEach, describe, expect, it } from "vitest"
import { chatClaudeLogin } from "../server/chatAgent.js"
import { CoordinatorEnv } from "../server/coordinatorEnv.js"
import { coordinatorClaudeLogin, coordinatorExtraEnv, serverClaudeEnv, turnEnv } from "../server/turnCredentials.js"

// The Coordinator's own env vars (Settings › Coordinator › Env vars): the strongest Claude credential among them is its
// login, picked as a task turn picks its project's, and the rest reach its `claude` as they are.

/** The kv a CoordinatorEnv keeps its vars in. */
function kv() {
  const map = new Map<string, string>()
  return { map, getKv: (k: string) => map.get(k) ?? null, setKv: (k: string, v: string | null) => void (v === null ? map.delete(k) : map.set(k, v)) }
}

describe("coordinatorClaudeLogin", () => {
  it("uses a Claude token in its env vars, filed under the Coordinator", () => {
    expect(coordinatorClaudeLogin({ CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth", OTHER: "x" })).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth" },
      source: "the Coordinator's env vars",
      scope: "coordinator",
    })
  })

  it("has none without one, so the rotation or Settings › Credentials decides", () => {
    expect(coordinatorClaudeLogin({})).toBeNull()
    expect(coordinatorClaudeLogin({ OTHER: "x", ANTHROPIC_API_KEY: "" })).toBeNull()
  })

  it("matches a task turn's pick: only the strongest var", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth", ANTHROPIC_API_KEY: "coord-key", ANTHROPIC_AUTH_TOKEN: "" }
    const own = coordinatorClaudeLogin(env)!
    expect(own.env).toEqual({ ANTHROPIC_API_KEY: "coord-key" })
    expect(Object.fromEntries(Object.entries(turnEnv(env, { claude: {}, githubToken: "" }).env).filter(([k]) => k.startsWith("ANTHROPIC") || k.startsWith("CLAUDE_CODE")))).toEqual(own.env)
  })

  it("passes on its other vars, never a Claude credential or a BOXYARD_* var", () => {
    expect(coordinatorExtraEnv({ CLAUDE_CODE_OAUTH_TOKEN: "a", ANTHROPIC_API_KEY: "b", ANTHROPIC_AUTH_TOKEN: "c", HTTPS_PROXY: "http://proxy", BOXYARD_SECRET_KEY: "k", boxyard_x: "y", EMPTY: "" })).toEqual({ HTTPS_PROXY: "http://proxy" })
  })
})

describe("the Coordinator's claude env with its own login", () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it("gets exactly that one Claude var, over the server's and Settings', and the login is filed under the Coordinator", () => {
    process.env.ANTHROPIC_API_KEY = "server-key"
    process.env.ANTHROPIC_AUTH_TOKEN = "server-auth"
    const own = coordinatorClaudeLogin({ CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth" })!
    const env = serverClaudeEnv(own.env, { ANTHROPIC_API_KEY: "settings-key" })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("coord-oauth")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(chatClaudeLogin(env, own)).toMatchObject({ harness: "claude", kind: "oauth_token", source: "the Coordinator's env vars", scope: "coordinator" })
  })
})

describe("CoordinatorEnv", () => {
  it("keeps values on the server: info names the keys and its Claude login only", () => {
    const store = kv()
    const env = new CoordinatorEnv(store)
    expect(env.info()).toEqual({ keys: [], claudeLogin: null })
    const info = env.update({ env: { ZED: "zed-value-1", CLAUDE_CODE_OAUTH_TOKEN: "  coord-oauth-1\n" } })
    expect(info).toEqual({ keys: ["CLAUDE_CODE_OAUTH_TOKEN", "ZED"], claudeLogin: "CLAUDE_CODE_OAUTH_TOKEN" })
    expect(JSON.stringify(info)).not.toContain("coord-oauth-1")
    // A pasted token's surrounding whitespace goes.
    expect(env.values()).toEqual({ ZED: "zed-value-1", CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth-1" })
    expect(env.secrets().sort()).toEqual(["coord-oauth-1", "zed-value-1"])
    // A second instance over the same kv (a restart) reads the same.
    expect(new CoordinatorEnv(store).values()).toEqual(env.values())
  })

  it("names the strongest Claude credential as its login, as the runs pick it", () => {
    const env = new CoordinatorEnv(kv())
    expect(env.update({ env: { CLAUDE_CODE_OAUTH_TOKEN: "a-oauth", ANTHROPIC_API_KEY: "a-key" } }).claudeLogin).toBe("ANTHROPIC_API_KEY")
    expect(env.update({ removeEnv: ["ANTHROPIC_API_KEY"] }).claudeLogin).toBe("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("removes, then sets, so a name in both is replaced; with none left, the kv entry goes", () => {
    const store = kv()
    const env = new CoordinatorEnv(store)
    env.update({ env: { A_VAR: "first-value", B_VAR: "b-value-1" } })
    expect(env.update({ env: { A_VAR: "second-value" }, removeEnv: ["A_VAR", "B_VAR", "NOT_THERE"] })).toEqual({ keys: ["A_VAR"], claudeLogin: null })
    expect(env.values()).toEqual({ A_VAR: "second-value" })
    env.update({ removeEnv: ["A_VAR"] })
    expect(store.map.size).toBe(0)
  })

  it("refuses bad names, Box Yard's own vars, empty values and unknown fields, and changes nothing", () => {
    const env = new CoordinatorEnv(kv())
    env.update({ env: { KEEP: "keep-value" } })
    for (const patch of [{ env: { "BAD-NAME": "x" } }, { env: { BOXYARD_SECRET_KEY: "x" } }, { env: { boxyard_data_dir: "x" } }, { env: { EMPTY: " " } }, { values: { A: "b" } }]) {
      expect(() => env.update(patch)).toThrow()
    }
    expect(env.values()).toEqual({ KEEP: "keep-value" })
  })

  it("reads a broken kv entry as none", () => {
    const store = kv()
    store.setKv("coordinator_env", "{not json")
    expect(new CoordinatorEnv(store).values()).toEqual({})
    store.setKv("coordinator_env", JSON.stringify({ OK: "fine", N: 1, E: "" }))
    expect(new CoordinatorEnv(store).values()).toEqual({ OK: "fine" })
  })
})
