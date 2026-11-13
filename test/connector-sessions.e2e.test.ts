import { afterEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Connector, ConnectorSignIn } from "../shared/connectors.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_MCP_STDIO, fakeOAuth } from "./connectorFixtures.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Connectors in real sessions (docs/connectors.md › Sessions), end to end: the Coordinator, a Captain and an agent turn
// each reach a remote OAuth connector and a command connector through their MCP config (fake-claude's [connectors]
// expands the ${VAR}s from its env, as the real CLI does), dontAsk sessions may use them, and no secret is in any file
// Box Yard writes but task.json, nor in any event it streams.

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

const ENV_SECRET = "notes-env-secret-5555555555"

/** Every file under `dir`, skipping task.json: it carries a turn's credentials, as for identities. */
function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).flatMap((e) => (e.isFile() && e.name !== "task.json" ? [path.join(e.parentPath, e.name)] : []))
}

async function start() {
  const dir = tmpDir("connector-sessions-e2e-")
  const log = path.join(dir, "claude-args.log")
  // Logs the args each `claude` run got (its --allowedTools), then runs the fake one.
  const claude = path.join(dir, "claude")
  fs.writeFileSync(claude, `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}) + "\\n")' ${JSON.stringify(log)} "$@"\nexec ${FAKE_CLAUDE} "$@"\n`, { mode: 0o755 })
  const port = await freePort()
  const config = testConfig({ port, claudeBin: claude, anthropicApiKey: "global-key" })
  const boxes = path.join(dir, "boxes")
  const yard: BoxYard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(boxes, claude) })
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  cleanups.push(async () => {
    await waitFor(() => !yard.orchestrator.busy, "the Coordinator to finish").catch(() => {})
    for (const t of yard.store.listTaskRows()) if (t.current_turn_id) await yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => !(yard.tasks as unknown as { archiving: Set<string> }).archiving.size, "archives to finish").catch(() => {})
    yard.stop()
    await new Promise((res) => server.close(() => res(null)))
  })
  const base = `http://127.0.0.1:${port}`
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + url, { method, headers: { Origin: base, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`)
    return JSON.parse(text) as T
  }
  // Everything the server streams, to check no secret goes out in an event.
  const stream = new AbortController()
  let streamed = ""
  void fetch(`${base}/api/stream`, { signal: stream.signal })
    .then(async (res) => {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) streamed += Buffer.from(chunk).toString("utf8")
    })
    .catch(() => {})
  cleanups.push(() => stream.abort())
  const runs = () =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(0, -1) : []).map((line) => JSON.parse(line) as { cwd: string; args: string[] })
  return { yard, call, base, dir, boxes, dataDir: config.dataDir, runs, streamed: () => streamed }
}

describe("connectors in sessions", () => {
  it("reach the Coordinator, a Captain and an agent through ${VAR}s, and no secret is in a config, event or transcript", async () => {
    const fake = await fakeOAuth()
    cleanups.push(() => fake.close())
    const r = await start()
    const everywhere = { sessions: ["coordinator", "captain", "agent"], projects: null, runners: ["local", "box"] }

    // A remote server Cody signs in to, and a command with a secret env var.
    const remote = await r.call<Connector>("POST", "/api/connectors", { name: "remote", kind: "http", url: fake.mcpUrl, auth: "oauth", scope: everywhere })
    const start1 = await r.call<ConnectorSignIn>("POST", `/api/connectors/${remote.id}/oauth/start`, { origin: r.base })
    const back = await fake.authorize(start1.authorizeUrl)
    expect((await r.call<Connector>("POST", "/api/connectors/oauth/complete", { url: back })).status).toBe("connected")
    const notes = await r.call<Connector>("POST", "/api/connectors", {
      name: "notes",
      kind: "stdio",
      command: process.execPath,
      args: [FAKE_MCP_STDIO],
      env: { EXPECT_SHA256: createHash("sha256").update(ENV_SECRET).digest("hex") },
      auth: "env",
      scope: everywhere,
    })
    await r.call("PUT", `/api/connectors/${notes.id}/env/FAKE_SECRET`, { value: ENV_SECRET })
    // Off: no session gets it.
    const off = await r.call<Connector>("POST", "/api/connectors", { name: "off", kind: "http", url: "https://off.example/mcp", scope: everywhere })
    await r.call("PATCH", `/api/connectors/${off.id}`, { enabled: false })

    const reached = (text: string) => {
      expect(text).toContain("Connector remote: tools echo, whoami")
      const line = text.split("\n").find((l) => l.startsWith("Connector notes:")) ?? ""
      expect(line).toMatch(/^Connector notes: tools ping, env_keys; env /)
      // The command got its own vars and the basics, none of the session's: no login, no other connector's token.
      const env = line.replace(/^.*; env /, "").split(", ")
      expect(env).toEqual(expect.arrayContaining(["EXPECT_SHA256", "FAKE_SECRET", "HOME", "PATH"]))
      expect(env.filter((k) => /TOKEN|KEY|BOXYARD|CLAUDE|ANTHROPIC|GITHUB/.test(k))).toEqual([])
      expect(text).not.toContain("Connector off")
    }

    // The Coordinator.
    await r.call("POST", "/api/chat", { content: "Which connectors do you have? [connectors]" })
    const coordinator = await waitFor(() => r.yard.store.listChat().find((m) => m.role === "assistant" && m.content.includes("Connector "))?.content ?? null, "the Coordinator's reply", 30_000)
    reached(coordinator)

    // A Captain.
    const project = await r.call<Project>("POST", "/api/projects", { name: "site" })
    await r.call("POST", `/api/projects/${project.id}/captain/messages`, { content: "Which connectors do you have? [connectors]" })
    const captain = await waitFor(() => r.yard.store.listCaptainMessages(project.id).find((m) => m.role === "assistant" && m.content.includes("Connector "))?.content ?? null, "the Captain's reply", 30_000)
    reached(captain)

    // An agent's turn, on a pool box.
    const task = await r.call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Connectors", prompt: "Which connectors do you have? [connectors]" })
    const agent = await waitFor(() => r.yard.store.listTaskMessages(task.id).find((m) => m.role === "assistant" && m.content.includes("Connector "))?.content ?? null, "the agent's reply", 60_000)
    reached(agent)

    // dontAsk sessions (the Coordinator's and Captains') may use them; an agent bypasses permissions anyway.
    const allowed = (cwdPart: string) => {
      const run = r.runs().find((x) => x.cwd.includes(cwdPart) && x.args.includes("--allowedTools"))
      return run?.args[run.args.indexOf("--allowedTools") + 1] ?? ""
    }
    expect(allowed(`${path.sep}captains${path.sep}`)).toMatch(/mcp__boxyard\b.*mcp__remote|mcp__remote.*mcp__boxyard/)
    expect(allowed(`${path.sep}captains${path.sep}`)).toContain("mcp__notes")

    // The configs name ${VAR}s; no file Box Yard wrote holds a secret (task.json aside), and no event streamed one.
    const configs = [...files(r.dataDir), ...files(r.boxes)].filter((f) => /(^|[/\\])(orchestrator-)?mcp\.json$/.test(f))
    expect(configs.length).toBeGreaterThanOrEqual(3)
    for (const f of configs) {
      const cfg = JSON.parse(fs.readFileSync(f, "utf8")) as { mcpServers: Record<string, unknown> }
      expect(Object.keys(cfg.mcpServers).sort(), f).toEqual(["boxyard", "notes", "remote"])
      expect(JSON.stringify(cfg.mcpServers.remote)).toContain("${BOXYARD_CONNECTOR_REMOTE_TOKEN}")
    }
    const secrets = [...fake.issued, ENV_SECRET]
    expect(secrets.length).toBeGreaterThanOrEqual(3)
    for (const f of [...files(r.dataDir), ...files(r.boxes), ...files(r.dir).filter((x) => x.endsWith(".log"))]) {
      const body = fs.readFileSync(f)
      for (const s of secrets) expect(body.includes(Buffer.from(s)), `${s.slice(0, 12)}… in ${f}`).toBe(false)
    }
    for (const s of secrets) expect(r.streamed()).not.toContain(s)
    expect(r.streamed()).toContain("Connector remote")
  })
})
