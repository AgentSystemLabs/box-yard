import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { ChatMessage, CoordinatorEnvInfo } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The Coordinator's own env vars (Settings › Coordinator › Env vars), end to end: names out and values only in, a Claude
// token there is its login over the rotation's and Settings › Credentials', and every run reads them, so a change
// applies from the next run without a restart.

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    await waitFor(() => !r.yard.orchestrator.busy, "the Coordinator to finish")
    await waitFor(() => !r.yard.threads.anyBusy, "side threads to finish")
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start() {
  const dir = tmpDir("coordinator-env-e2e-")
  const log = path.join(dir, "claude-env.log")
  // Writes the Claude credential vars it sees and the Coordinator's extra var, one line per run, then runs the fake claude.
  const claude = path.join(dir, "claude")
  fs.writeFileSync(
    claude,
    `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'const env = Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|COORD_EXTRA)$/.test(k)).map(([k,v]) => k + "=" + v); require("node:fs").appendFileSync(process.argv[1], JSON.stringify(env.sort()) + "\\n")' ${JSON.stringify(log)}\nexec ${FAKE_CLAUDE} "$@"\n`,
    { mode: 0o755 },
  )
  const port = await freePort()
  // Settings › Credentials' login: what the Coordinator falls back on.
  const config = testConfig({ port, claudeBin: claude, anthropicApiKey: "global-key-0001" })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(path.join(dir, "boxes"), claude) })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
  const base = `http://127.0.0.1:${port}`
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await raw(method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${r.text}`)
    return JSON.parse(r.text) as T
  }
  /** The env of each `claude` run so far (the Coordinator's and its side threads': there are no tasks here). */
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line) as string[]) : [])
  /** Sends the Coordinator a message, waits for its turn to end, and gives the env of every run it made. */
  const turn = async (content: string) => {
    const before = runs().length
    const replies = (await call<ChatMessage[]>("GET", "/api/chat")).filter((m) => m.role === "assistant").length
    await call("POST", "/api/chat", { content })
    await waitFor(async () => (await call<ChatMessage[]>("GET", "/api/chat")).filter((m) => m.role === "assistant").length > replies || null, "the Coordinator's reply")
    await waitFor(() => !yard.orchestrator.busy, "the Coordinator's turn to end")
    return runs().slice(before)
  }
  return { yard, raw, call, runs, turn }
}

describe("the Coordinator's env vars", () => {
  it("log the Coordinator in with a Claude token from them, else Settings', read on every run", async () => {
    const r = await start()
    expect(await r.call<CoordinatorEnvInfo>("GET", "/api/orchestrator/env")).toEqual({ keys: [], claudeLogin: null })

    // None of its own: Settings › Credentials' login.
    const first = await r.turn("status")
    expect(first.length).toBeGreaterThan(0)
    for (const env of first) expect(env).toEqual(["ANTHROPIC_API_KEY=global-key-0001"])

    // A token in its env vars wins from the next run, with no restart. Only the strongest Claude var reaches it (as a
    // task's: ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN), its other vars do as they are, and the values never
    // come back.
    const saved = await r.raw("PATCH", "/api/orchestrator/env", { env: { CLAUDE_CODE_OAUTH_TOKEN: "coord-oauth-0001", COORD_EXTRA: "extra-value-01" } })
    expect(saved.status).toBe(200)
    expect(JSON.parse(saved.text)).toEqual({ keys: ["CLAUDE_CODE_OAUTH_TOKEN", "COORD_EXTRA"], claudeLogin: "CLAUDE_CODE_OAUTH_TOKEN" })
    const listed = await r.raw("GET", "/api/orchestrator/env")
    for (const secret of ["coord-oauth-0001", "extra-value-01"]) {
      expect(saved.text).not.toContain(secret)
      expect(listed.text).not.toContain(secret)
    }
    const second = await r.turn("status again")
    expect(second.length).toBeGreaterThan(0)
    for (const env of second) expect(env).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=coord-oauth-0001", "COORD_EXTRA=extra-value-01"])

    // Its side threads run on the same login and vars.
    const reply = (await r.call<ChatMessage[]>("GET", "/api/chat")).filter((m) => m.role === "assistant").at(-1)!
    const before = r.runs().length
    await r.call("POST", "/api/threads", { anchorId: reply.id, quote: "status", question: "Why?" })
    expect(await waitFor(() => r.runs()[before] ?? null, "the Coordinator side thread's run")).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=coord-oauth-0001", "COORD_EXTRA=extra-value-01"])
    await waitFor(() => !r.yard.threads.anyBusy, "the side thread to finish")

    // Transcripts and errors redact its values, as they do Settings › Credentials'.
    expect(r.yard.store.transcriptSecrets()).toEqual(expect.arrayContaining(["coord-oauth-0001", "extra-value-01"]))

    // Removed: the next run is back on Settings' login, again with no restart.
    expect(await r.call<CoordinatorEnvInfo>("PATCH", "/api/orchestrator/env", { removeEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] })).toEqual({ keys: ["COORD_EXTRA"], claudeLogin: null })
    const third = await r.turn("status once more")
    expect(third.length).toBeGreaterThan(0)
    for (const env of third) expect(env).toEqual(["ANTHROPIC_API_KEY=global-key-0001", "COORD_EXTRA=extra-value-01"])
  })

  it("beat a login in the rotation, which the Coordinator takes again once its own is gone", async () => {
    const r = await start()
    await r.call("POST", "/api/logins", { harness: "claude", label: "Rotation", value: "oat-rotation-0001" })
    await r.call("PATCH", "/api/orchestrator/env", { env: { ANTHROPIC_AUTH_TOKEN: "coord-auth-0001" } })
    for (const prompt of ["status", "status again"]) for (const env of await r.turn(prompt)) expect(env).toEqual(["ANTHROPIC_AUTH_TOKEN=coord-auth-0001"])

    await r.call("PATCH", "/api/orchestrator/env", { removeEnv: ["ANTHROPIC_AUTH_TOKEN"] })
    const logins = new Set<string>()
    for (const prompt of ["status", "status again", "status once more"]) for (const env of await r.turn(prompt)) logins.add(env.join(","))
    expect([...logins].every((l) => l === "ANTHROPIC_API_KEY=global-key-0001" || l === "CLAUDE_CODE_OAUTH_TOKEN=oat-rotation-0001")).toBe(true)
  })

  it("refuse Box Yard's own vars and bad names, and change nothing then", async () => {
    const r = await start()
    for (const env of [{ BOXYARD_SECRET_KEY: "nope-0001" }, { "NOT-A-NAME": "x" }, { EMPTY_ONE: "   " }]) {
      const res = await r.raw("PATCH", "/api/orchestrator/env", { env })
      expect(res.status).toBe(400)
      expect(res.text).not.toContain("nope-0001")
    }
    expect(await r.call<CoordinatorEnvInfo>("GET", "/api/orchestrator/env")).toEqual({ keys: [], claudeLogin: null })
    for (const env of await r.turn("status")) expect(env).toEqual(["ANTHROPIC_API_KEY=global-key-0001"])
  })
})
