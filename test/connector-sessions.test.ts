import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { ConnectorService } from "../server/connectors/service.js"
import { COMMAND_BASE_ENV, ENV_BIN, NO_SESSION_CONNECTORS, connectorServer, mcpConfigJson, sessionConnectors } from "../server/connectors/sessions.js"
import { GLOBAL_CREDENTIALS, splitCredentialSet, withBoxConnectors } from "../server/turnCredentials.js"
import { redact } from "../server/credentials.js"
import type { Connector } from "../shared/connectors.js"
import { FAKE_MCP_STDIO, fakeOAuth } from "./connectorFixtures.js"
import { tmpDir } from "./helpers.js"

// A session's connectors (docs/connectors.md › Sessions): who gets which, that a config names every secret as ${VAR}
// and only the session's env holds the values, that a command connector gets none of the session's env, and that an
// OAuth token is refreshed to last a session. The end-to-end side (real sessions, files, events) is in
// connector-sessions.e2e.test.ts.

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})

const TOKEN = "notion_secret_token_1234567890"
const OTHER_TOKEN = "linear_secret_token_0987654321"
const ENV_SECRET = "env-secret-value-0987654321"

function setup(o: { fetch?: typeof fetch } = {}) {
  const dir = tmpDir()
  const db = openDb(dir)
  const store = new Store(db)
  const sealed = new Set<string>()
  let svc: ConnectorService
  svc = new ConnectorService({
    db,
    secrets: new SecretBox({ dataDir: dir }),
    statusOnly: (id) => sealed.has(id),
    projectExists: (id) => Boolean(store.getProject(id)),
    projectName: (id) => store.getProject(id)?.name ?? null,
    port: 4000,
    redact: (t) => redact(t, svc.store.secretValues()),
    fetch: o.fetch,
  })
  const projects = { a: store.createProject({ name: "alpha", repo: "o/a" }), b: store.createProject({ name: "beta", repo: "o/b" }) }
  return { svc, c: svc.store, projects, sealed }
}

/** Every value a session's config could hold a secret in, as one string. */
const configText = (s: { servers: unknown }) => mcpConfigJson({ type: "http", url: "http://127.0.0.1:1/mcp", headers: {} }, s as never)

describe("a session's connectors", () => {
  it("are the ones its scope reaches: by session, project and runner, never disabled ones, never status-only projects' for the Coordinator's", async () => {
    const { svc, c, projects, sealed } = setup()
    const everyone = c.create({ name: "notion", kind: "http", url: "https://mcp.notion.com/mcp", auth: "token", scope: { sessions: ["coordinator", "captain", "agent"], projects: null, runners: ["local", "box"] } })
    c.saveSecret(everyone.id, "token", TOKEN)
    const agentsOfA = c.create({ name: "linear", kind: "http", url: "https://mcp.linear.app/mcp", auth: "token", scope: { sessions: ["agent"], projects: [projects.a.id], runners: ["docker"] } })
    c.saveSecret(agentsOfA.id, "token", OTHER_TOKEN)
    const off = c.create({ name: "off", kind: "http", url: "https://off.example/mcp", scope: { sessions: ["coordinator", "captain", "agent"], projects: null, runners: ["local"] } })
    c.update(off.id, { enabled: false })

    const names = async (ref: Parameters<typeof svc.session>[0]) => Object.keys((await svc.session(ref)).servers).sort()
    expect(await names({ kind: "coordinator" })).toEqual(["notion"])
    expect(await names({ kind: "captain", projectId: projects.a.id })).toEqual(["notion"])
    expect(await names({ kind: "agent", projectId: projects.a.id, runner: "local" })).toEqual(["notion"])
    expect(await names({ kind: "agent", projectId: projects.a.id, runner: "box" })).toEqual(["notion"])
    expect(await names({ kind: "agent", projectId: projects.a.id, runner: "docker" })).toEqual(["linear"])
    expect(await names({ kind: "agent", projectId: projects.b.id, runner: "docker" })).toEqual([])
    expect(await names({ kind: "agent", projectId: projects.b.id, runner: "gpu" })).toEqual([])
    // Nothing reaches it: the shared empty answer, no work.
    expect(await svc.session({ kind: "agent", projectId: projects.b.id, runner: "ssh" })).toBe(NO_SESSION_CONNECTORS)

    // beta shows the Coordinator status only: a connector the Coordinator uses stops reaching beta's sessions (its
    // Captain and agents could pass what it reads back up), while the Coordinator keeps it.
    sealed.add(projects.b.id)
    expect(await names({ kind: "captain", projectId: projects.b.id })).toEqual([])
    expect(await names({ kind: "agent", projectId: projects.b.id, runner: "local" })).toEqual([])
    expect(await names({ kind: "captain", projectId: projects.a.id })).toEqual(["notion"])
    expect(await names({ kind: "coordinator" })).toEqual(["notion"])
    // An agents-only connector for beta still reaches beta's agents.
    const bOnly = c.create({ name: "b-only", kind: "http", url: "https://b.example/mcp", scope: { sessions: ["agent"], projects: [projects.b.id], runners: ["local"] } })
    expect(await names({ kind: "agent", projectId: projects.b.id, runner: "local" })).toEqual(["b-only"])
    void bOnly
  })

  it("name every secret as ${VAR} in the config, with the values in the session's env only", async () => {
    const { svc, c } = setup()
    const notion = c.create({ name: "notion", kind: "http", url: "https://mcp.notion.com/mcp", auth: "token", scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } })
    c.saveSecret(notion.id, "token", TOKEN)
    const custom = c.create({ name: "my-api", kind: "sse", url: "https://api.example/sse", auth: "token", header: { name: "X-Api-Key", prefix: "" }, scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } })
    c.saveSecret(custom.id, "token", OTHER_TOKEN)
    const open = c.create({ name: "docs", kind: "http", url: "https://docs.example/mcp", scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } })
    void open

    const s = await svc.session({ kind: "coordinator" })
    expect(s.servers).toEqual({
      notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${BOXYARD_CONNECTOR_NOTION_TOKEN}" } },
      "my-api": { type: "sse", url: "https://api.example/sse", headers: { "X-Api-Key": "${BOXYARD_CONNECTOR_MY_API_TOKEN}" } },
      docs: { type: "http", url: "https://docs.example/mcp", headers: {} },
    })
    expect(s.env).toEqual({ BOXYARD_CONNECTOR_NOTION_TOKEN: TOKEN, BOXYARD_CONNECTOR_MY_API_TOKEN: OTHER_TOKEN })
    expect(s.allowed.sort()).toEqual(["mcp__docs", "mcp__my-api", "mcp__notion"])
    expect(s.skipped).toEqual([])
    const config = configText(s)
    expect(config).not.toContain(TOKEN)
    expect(config).not.toContain(OTHER_TOKEN)
    // Box Yard's own server stays `boxyard`, whatever the connectors are.
    expect(Object.keys(JSON.parse(config).mcpServers).sort()).toEqual(["boxyard", "docs", "my-api", "notion"])
  })

  it("leave out one that can't sign in, and say why without a secret", async () => {
    const { svc, c } = setup()
    c.create({ name: "no-token", kind: "http", url: "https://x.example/mcp", auth: "token" })
    c.create({ name: "oauth-off", kind: "http", url: "https://y.example/mcp", auth: "oauth" })
    const s = await svc.session({ kind: "coordinator" })
    expect(s.servers).toEqual({})
    expect(s.allowed).toEqual([])
    expect(s.skipped.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "no-token", why: "it has no token" },
      { name: "oauth-off", why: "it isn't signed in" },
    ])
  })

  it("run a command under env -i: its own vars and the basics, none of the session's (its login, other tokens)", async () => {
    const { svc, c } = setup()
    const made = c.create({ name: "notes", kind: "stdio", command: process.execPath, args: [FAKE_MCP_STDIO], env: { EXPECT_SHA256: createHash("sha256").update(ENV_SECRET).digest("hex") }, auth: "env" })
    c.saveSecret(made.id, "env:FAKE_SECRET", ENV_SECRET)
    const s = await svc.session({ kind: "coordinator" })
    const spec = s.servers.notes
    expect(spec).toEqual({
      type: "stdio",
      command: ENV_BIN,
      args: ["-i", ...COMMAND_BASE_ENV.map((k) => `${k}=\${${k}:-}`), `EXPECT_SHA256=${createHash("sha256").update(ENV_SECRET).digest("hex")}`, "FAKE_SECRET=${BOXYARD_CONNECTOR_NOTES_ENV_FAKE_SECRET}", process.execPath, FAKE_MCP_STDIO],
    })
    expect(s.env).toEqual({ BOXYARD_CONNECTOR_NOTES_ENV_FAKE_SECRET: ENV_SECRET })
    expect(configText(s)).not.toContain(ENV_SECRET)

    // Run it the way Claude Code does: ${VAR}s expanded from the session's env, which it hands the command whole.
    const sessionEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...s.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-login", BOXYARD_CONNECTOR_OTHER_TOKEN: "another-connector-token" }
    const expand = (v: string) => v.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-)?\}/g, (_, k: string) => sessionEnv[k] ?? "")
    if (spec?.type !== "stdio") throw new Error("not a command")
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args.map(expand), env: sessionEnv, stderr: "ignore" }))
    cleanups.push(() => client.close())
    const res = (await client.callTool({ name: "env_keys", arguments: {} })) as { content: { text: string }[] }
    const keys = JSON.parse(res.content[0]!.text) as string[]
    // It started, so FAKE_SECRET arrived; nothing else of the session's env did.
    expect(keys).toContain("FAKE_SECRET")
    expect(keys.filter((k) => !(COMMAND_BASE_ENV as readonly string[]).includes(k) && !["FAKE_SECRET", "EXPECT_SHA256", "__CF_USER_TEXT_ENCODING"].includes(k))).toEqual([])
  })

  it("gives a command its token in the var it names, and a secret env var that can't be read leaves it out", async () => {
    const { svc, c } = setup()
    const made = c.create({ name: "gh", kind: "stdio", command: "gh-mcp", args: ["--stdio"], auth: "token", tokenEnv: "GH_TOKEN" })
    c.saveSecret(made.id, "token", TOKEN)
    const s = await svc.session({ kind: "coordinator" })
    const spec = s.servers.gh
    if (spec?.type !== "stdio") throw new Error("not a command")
    expect(spec.args.slice(-3)).toEqual(["GH_TOKEN=${BOXYARD_CONNECTOR_GH_TOKEN}", "gh-mcp", "--stdio"])
    expect(s.env).toEqual({ BOXYARD_CONNECTOR_GH_TOKEN: TOKEN })
  })

  it("refresh an OAuth token with under 45 minutes left as the session starts, and hand out the access token only", async () => {
    const fake = await fakeOAuth({ expiresIn: 30 * 60 })
    cleanups.push(() => fake.close())
    const { svc, c } = setup()
    const made = c.create({ name: "remote", kind: "http", url: fake.mcpUrl, auth: "oauth" })
    const origin = "http://localhost:4000"
    const start = await svc.signIns.start(made.id, origin, [origin])
    await svc.finishSignIn(new URL(await fake.authorize(start.authorizeUrl)).searchParams)
    const first = c.secret(made.id, "access_token")!
    const refresh = c.secret(made.id, "refresh_token")!

    // 30 minutes left: the session gets a fresh token, refreshed once.
    const s = await svc.session({ kind: "coordinator" })
    expect(fake.state.refreshCount).toBe(1)
    const token = s.env.BOXYARD_CONNECTOR_REMOTE_TOKEN!
    expect(token).toBe(c.secret(made.id, "access_token"))
    expect(token).not.toBe(first)
    expect(Object.values(s.env)).toEqual([token])
    expect(JSON.stringify(s)).not.toContain(c.secret(made.id, "refresh_token")!)
    expect(JSON.stringify(s)).not.toContain(refresh)
    expect(configText(s)).not.toContain(token)

    // A token with an hour left goes out as it is.
    const fresh = await fakeOAuth({ expiresIn: 3600 })
    cleanups.push(() => fresh.close())
    const other = c.create({ name: "fresh", kind: "http", url: fresh.mcpUrl, auth: "oauth" })
    const s2 = await svc.signIns.start(other.id, origin, [origin])
    await svc.finishSignIn(new URL(await fresh.authorize(s2.authorizeUrl)).searchParams)
    const again = await svc.session({ kind: "coordinator" })
    expect(fresh.state.refreshCount).toBe(0)
    expect(again.env.BOXYARD_CONNECTOR_FRESH_TOKEN).toBe(c.secret(other.id, "access_token"))
  })

  it("leave out a connector whose env vars clash with another's", () => {
    const base = { label: null, enabled: true, auth: "token", status: "connected", header: { name: "Authorization", prefix: "Bearer " }, env: {}, args: [], tokenEnv: null, scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } }
    const a = { ...base, id: "a", name: "a", kind: "stdio", command: "a", tokenEnv: "T" } as unknown as Connector
    // a's secret env var B_TOKEN reaches the session as BOXYARD_CONNECTOR_A_ENV_B_TOKEN, which is a-env-b's token var.
    const b = { ...base, id: "b", name: "a-env-b", kind: "http", url: "https://b.example/mcp" } as unknown as Connector
    const s = sessionConnectors([
      { c: a, creds: { token: null, env: { B_TOKEN: "one" } } },
      { c: b, creds: { token: "two", env: {} } },
    ])
    expect(Object.keys(s.servers)).toEqual(["a"])
    expect(s.skipped).toEqual([{ name: "a-env-b", why: "its name or env vars clash with another connector's" }])
    expect(s.env).toEqual({ BOXYARD_CONNECTOR_A_ENV_B_TOKEN: "one" })
    // A built-in server's own command stands in for the connector's.
    const own = connectorServer(a, { token: null, env: {} }, { command: "/opt/node", args: ["gmail.mjs"] })
    expect(own.spec.type === "stdio" && own.spec.args.slice(-2)).toEqual(["/opt/node", "gmail.mjs"])
  })
})

describe("the box wall's connector key", () => {
  it("adds a project's box connectors to its credential set, and reads them back off", () => {
    expect(withBoxConnectors(GLOBAL_CREDENTIALS, "")).toBe(GLOBAL_CREDENTIALS)
    expect(withBoxConnectors("identity:idn_1", "abc123abc123")).toBe("identity:idn_1+con:abc123abc123")
    expect(splitCredentialSet("identity:idn_1+con:abc123abc123")).toEqual({ base: "identity:idn_1", connectors: "abc123abc123" })
    expect(splitCredentialSet("project:prj_a")).toEqual({ base: "project:prj_a", connectors: "" })
  })
})
