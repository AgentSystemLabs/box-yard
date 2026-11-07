import fs from "node:fs"
import http, { type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { uploadsDir } from "../server/uploads.js"
import type { Config } from "../server/config.js"
import { signLikeQStash } from "../server/qstash.js"
import { OAUTH_CALLBACK_PATH } from "../shared/connectors.js"
import { freePort, testConfig } from "./helpers.js"

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const { yard, server } of running.splice(0)) {
    yard.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function start(password = "", overrides: Partial<Config> = {}) {
  const port = await freePort()
  const config = testConfig({ port, password, publicUrl: "", allowOpen: false, ...overrides })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  running.push({ yard, server })
  return { base: `http://127.0.0.1:${port}`, port, config, yard }
}

// Native HTTP preserves a deliberately chosen Host; fetch can replace it with the connection URL's authority.
async function request(base: string, route: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers }, (res) => {
      let text = ""
      res.setEncoding("utf8").on("data", (s) => { text += s }).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

describe("browser request trust boundary in the server", () => {
  it("rejects an untrusted authority even without a password or with spoofed proxy headers", async () => {
    const { base, port } = await start()
    const res = await request(base, "/api/projects", {
      Host: `untrusted.invalid:${port}`,
      "X-Forwarded-Host": `localhost:${port}`,
      "X-Forwarded-Proto": "http",
    })
    expect(res.status).toBe(403)
    expect((await fetch(`${base}/api/projects`)).status).toBe(200)
  })

  it("rejects foreign browser submissions before JSON parsing, raw upload writes or logout", async () => {
    const { base, port, config } = await start()
    for (const origin of ["https://untrusted.invalid", `http://127.0.0.1:${port + 1}`, "null"]) {
      const headers = { Origin: origin, "Sec-Fetch-Site": "same-site", "X-Forwarded-Origin": base }
      const json = await fetch(`${base}/api/login`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{invalid",
      })
      expect(json.status).toBe(403)
      const raw = await fetch(`${base}/api/uploads?name=fixture.txt`, {
        method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "isolated fixture",
      })
      expect(raw.status).toBe(403)
      expect(fs.readdirSync(uploadsDir(config.dataDir))).toEqual([])
      const logout = await fetch(`${base}/api/logout`, { method: "POST", headers })
      expect(logout.status).toBe(403)
      expect(logout.headers.get("set-cookie")).toBeNull()
    }
  })

  it("blocks a cookie-authenticated same-site mutation while retaining same-origin and script access", async () => {
    const password = "fixture orbit violet lantern"
    const { base, port } = await start(password)
    const login = await fetch(`${base}/api/login`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    const denied = await fetch(`${base}/api/logout`, { method: "POST", headers: {
      Cookie: cookie, Origin: `http://127.0.0.1:${port + 1}`, "Sec-Fetch-Site": "same-site",
    } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get("set-cookie")).toBeNull()
    expect((await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } })).status).toBe(200)
    const script = await fetch(`${base}/api/uploads?name=fixture.txt`, {
      method: "POST", headers: { Authorization: `Bearer ${password}`, "Content-Type": "text/plain" }, body: "isolated fixture",
    })
    expect(script.status).toBe(201)
    expect((await fetch(`${base}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: base } })).status).toBe(200)
  })

  it("preserves configured public/proxy/Vite requests and sets Secure from configuration", async () => {
    const password = "fixture orbit violet lantern"
    const { base } = await start(password, {
      publicUrl: "https://yard.example.test", trustedOrigins: ["https://proxy.example.test:8443", "http://localhost:5173"],
    })
    for (const origin of ["https://yard.example.test", "https://proxy.example.test:8443", "http://localhost:5173"]) {
      // A proxy may preserve the public Host or rewrite it to the internal target. Both require configured origins.
      for (const headers of [{ Host: new URL(origin).host, Origin: origin }, { Origin: origin }]) {
        const login = await request(base, "/api/login", { ...headers, "Content-Type": "application/json" }, "POST", JSON.stringify({ password }))
        expect(login.status).toBe(200)
        expect(login.headers["set-cookie"]![0]!.includes("; Secure")).toBe(origin.startsWith("https:"))
      }
    }
  })

  it("keeps OAuth state and QStash signature verification on origin-less external callbacks", async () => {
    const publicUrl = "https://yard.example.test"
    const key = "fake-qstash-signing-key"
    const { base } = await start("fixture orbit violet lantern", { publicUrl, qstashCurrentSigningKey: key })
    const host = { Host: "yard.example.test" }
    const callback = await request(base, `${OAUTH_CALLBACK_PATH}?state=invalid-fixture&code=fixture`, { ...host, "Sec-Fetch-Site": "cross-site" })
    expect(callback.status).toBe(400) // OAuth rejected the state, rather than the boundary blocking navigation.
    const route = "/qstash/schedules/sched_fixture1"
    const body = "{}"
    const unsigned = await request(base, route, { ...host, "Content-Type": "application/json" }, "POST", body)
    expect(unsigned.status).toBe(401)
    const signed = await request(base, route, {
      ...host, "Content-Type": "application/json", "Upstash-Signature": signLikeQStash({ key, url: `${publicUrl}${route}`, body }),
    }, "POST", body)
    expect(signed.status).toBe(200)
    expect(JSON.parse(signed.body)).toEqual({ result: "gone" })
    const mcp = await request(base, "/mcp", { "Content-Type": "application/json", Authorization: "Bearer invalid-fixture" }, "POST", "{}")
    expect(mcp.status).toBe(401) // MCP authentication is still required after the boundary.
  })
})
