import { afterEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { ConnectorService } from "../server/connectors/service.js"
import { GMAIL_MCP_PATH } from "../server/connectors/builtin.js"
import { mcpConfigJson } from "../server/connectors/sessions.js"
import { redact } from "../server/credentials.js"
import { CONNECTOR_PRESETS, GMAIL_COMMAND, GMAIL_SCOPES, parseGoogleClientFile, presetOf } from "../shared/connectorPresets.js"
import { fakeOAuth } from "./connectorFixtures.js"
import { tmpDir } from "./helpers.js"

// The Gmail preset (docs/connectors.md › Gmail): the connector it adds (the user's own Desktop client, offline access,
// read and draft scopes, the Coordinator only), Box Yard's own server standing in for its command in Test and in
// sessions, with only the access token, and on this computer only. Google is a fake: its OAuth and the Gmail API.

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

const CLIENT = { id: "1234-desktop.apps.googleusercontent.com", secret: "GOCSPX-own-client-secret" }

/** A fake Gmail API that takes the fake provider's access tokens only. */
async function fakeGmail(valid: () => string[]) {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    seen.push(`${req.method} ${url.pathname}`)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    if (!valid().includes(token)) return send(401, { error: { message: "Invalid Credentials" } })
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "")
    if (p === "/messages") return send(200, { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }], resultSizeEstimate: 3 })
    if (p.startsWith("/messages/")) return send(200, { id: p.slice(10), threadId: "t1", snippet: "", payload: { headers: [{ name: "Subject", value: "Hi" }] } })
    if (p === "/profile") return send(200, { emailAddress: "me@example.com", messagesTotal: 3, threadsTotal: 1 })
    send(404, { error: { message: "no" } })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

async function setup() {
  const fake = await fakeOAuth({ noRegistration: true, ownClient: CLIENT })
  cleanups.push(() => fake.close())
  const gmail = await fakeGmail(() => fake.issued)
  const dir = tmpDir()
  const db = openDb(dir)
  const store = new Store(db)
  let svc: ConnectorService
  svc = new ConnectorService({
    db,
    secrets: new SecretBox({ dataDir: dir }),
    statusOnly: () => false,
    projectExists: (id) => Boolean(store.getProject(id)),
    projectName: (id) => store.getProject(id)?.name ?? null,
    port: 4000,
    redact: (t) => redact(t, svc.store.secretValues()),
  })
  // The preset as Settings adds it, with the user's own client, pointed at the fakes.
  const preset = presetOf("gmail")!
  const made = svc.store.create({ ...preset.input, env: { GMAIL_API_BASE: gmail.base }, oauth: { ...preset.input.oauth, issuer: fake.issuer, clientId: CLIENT.id } })
  svc.store.saveSecret(made.id, "client_secret", CLIENT.secret)
  return { svc, c: svc.store, fake, gmail, id: made.id, project: store.createProject({ name: "site", repo: "o/site" }) }
}

async function signIn(s: Awaited<ReturnType<typeof setup>>) {
  const origin = "http://localhost:4000"
  const start = await s.svc.signIns.start(s.id, origin, [origin])
  await s.svc.finishSignIn(new URL(await s.fake.authorize(start.authorizeUrl)).searchParams)
  return start
}

describe("the Gmail preset", () => {
  it("adds a command connector with no client of its own, read and draft scopes, offline access, the Coordinator only", () => {
    const p = presetOf("gmail")!
    expect(CONNECTOR_PRESETS.map((x) => x.id)).toEqual(["gmail"])
    expect(p.input).toMatchObject({ name: "gmail", kind: "stdio", command: GMAIL_COMMAND, auth: "oauth", tokenEnv: "GOOGLE_ACCESS_TOKEN", scope: { sessions: ["coordinator"], projects: null, runners: ["local"] } })
    expect(p.input.oauth).toEqual({ clientKind: "desktop", issuer: "https://accounts.google.com", scopes: [...GMAIL_SCOPES], authParams: { access_type: "offline", prompt: "consent" } })
    // Box Yard ships no Google client: the id and secret are the user's.
    expect(JSON.stringify(CONNECTOR_PRESETS)).not.toMatch(/clientId|apps\.googleusercontent|GOCSPX/)
    expect(GMAIL_SCOPES.join(" ")).not.toMatch(/gmail\.send|gmail\.modify|mail\.google\.com/)
  })

  it("reads a Google client file: a Desktop client's under installed, a Web client's under web", () => {
    expect(parseGoogleClientFile(JSON.stringify({ installed: { client_id: " 1-d.apps.googleusercontent.com ", client_secret: "GOCSPX-x", redirect_uris: ["http://localhost"] } }))).toEqual({ clientId: "1-d.apps.googleusercontent.com", clientSecret: "GOCSPX-x", kind: "desktop" })
    expect(parseGoogleClientFile(JSON.stringify({ web: { client_id: "2-w" } }))).toEqual({ clientId: "2-w", clientSecret: null, kind: "web" })
    expect(parseGoogleClientFile("not json")).toBeNull()
    expect(parseGoogleClientFile(JSON.stringify({ type: "service_account", client_id: "3" }))).toBeNull()
  })

  it("signs in with the user's client (offline, consent), then Test runs Box Yard's server and lists the Gmail tools", async () => {
    const s = await setup()
    const start = await signIn(s)
    const q = s.fake.state.authorizeQueries[0]!
    expect(q.get("client_id")).toBe(CLIENT.id)
    expect(q.get("access_type")).toBe("offline")
    expect(q.get("prompt")).toBe("consent")
    expect(q.get("scope")).toBe(GMAIL_SCOPES.join(" "))
    expect(start.mode).toBe("redirect")
    expect(start.redirectUri).toBe("http://localhost:4000/api/connectors/oauth/callback")

    const tested = await s.svc.test(s.id)
    expect(tested.lastTest?.error ?? null).toBeNull()
    expect(tested.status).toBe("connected")
    expect(tested.lastTest?.tools.map((t) => t.name).sort()).toEqual(["create_draft", "get_profile", "list_labels", "read_message", "read_thread", "search_messages"])
  })

  it("gives the Coordinator Box Yard's server with only the access token, and a read-only search works through it", async () => {
    const s = await setup()
    await signIn(s)
    const session = await s.svc.session({ kind: "coordinator" })
    const spec = session.servers.gmail
    if (spec?.type !== "stdio") throw new Error("not a command")
    expect(spec.args.slice(-3)).toEqual(["GOOGLE_ACCESS_TOKEN=${BOXYARD_CONNECTOR_GMAIL_TOKEN}", process.execPath, GMAIL_MCP_PATH])
    expect(spec.args).toContain(`GMAIL_API_BASE=${s.gmail.base}`)
    expect(Object.keys(session.env)).toEqual(["BOXYARD_CONNECTOR_GMAIL_TOKEN"])
    expect(session.env.BOXYARD_CONNECTOR_GMAIL_TOKEN).toBe(s.c.secret(s.id, "access_token"))
    // Not the refresh token, not the client secret, and no value in the config.
    const all = JSON.stringify(session) + mcpConfigJson({}, session)
    expect(all).not.toContain(s.c.secret(s.id, "refresh_token")!)
    expect(all).not.toContain(CLIENT.secret)
    expect(mcpConfigJson({}, session)).not.toContain(session.env.BOXYARD_CONNECTOR_GMAIL_TOKEN!)

    // Run it the way Claude Code does, and search.
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...session.env }
    const expand = (v: string) => v.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-)?\}/g, (_, k: string) => env[k] ?? "")
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args.map(expand), env, stderr: "ignore" }))
    cleanups.push(() => client.close())
    const r = (await client.callTool({ name: "search_messages", arguments: { query: "newer_than:7d" } })) as { isError?: boolean; content: { text: string }[] }
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.content[0]!.text).messages).toHaveLength(3)
    expect(s.gmail.seen.every((x) => x.startsWith("GET "))).toBe(true)
  })

  it("runs on this computer only: agents elsewhere can't be given it, and a changed command is the user's own", async () => {
    const s = await setup()
    await signIn(s)
    expect(() => s.c.update(s.id, { scope: { sessions: ["coordinator", "agent"], projects: null, runners: ["local", "box"] } })).toThrow(/this computer only/)
    s.c.update(s.id, { scope: { sessions: ["coordinator", "agent"], projects: null, runners: ["local"] } })
    const local = await s.svc.session({ kind: "agent", projectId: s.project.id, runner: "local" })
    expect(local.servers.gmail?.type === "stdio" && local.servers.gmail.args.at(-1)).toBe(GMAIL_MCP_PATH)
    expect((await s.svc.session({ kind: "agent", projectId: s.project.id, runner: "box" })).servers).toEqual({})

    // Another command is no longer Box Yard's server: it runs as named (and its sign-in is forgotten: it moved).
    s.c.update(s.id, { command: "my-gmail-mcp" })
    expect(s.c.require(s.id).command).toBe("my-gmail-mcp")
    expect(s.c.secret(s.id, "access_token")).toBeNull()
  })
})
