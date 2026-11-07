import type { NextFunction, Request, Response } from "express"
import type os from "node:os"
import { describe, expect, it } from "vitest"
import { browserBoundary, secureBrowserCookie, type BrowserBoundaryConfig } from "../server/browserBoundary.js"

const config: BrowserBoundaryConfig = { host: "127.0.0.1", port: 4260, password: "", allowOpen: false, publicUrl: "", trustedOrigins: [] }
const interfaces = {
  lan: [{ address: "192.168.1.20" }], tailscale: [{ address: "100.100.1.2" }], ipv6: [{ address: "fd00::2" }],
} as unknown as ReturnType<typeof os.networkInterfaces>

function check(headers: Record<string, string | undefined> = {}, opts: { method?: string; config?: Partial<BrowserBoundaryConfig>; tls?: boolean; port?: number } = {}) {
  let effects = 0
  let status = 200
  const req = { method: opts.method ?? "POST", headers: { host: "localhost:4260", ...headers }, socket: { localPort: opts.port ?? 4260, encrypted: opts.tls } } as unknown as Request
  const res = { status: (code: number) => { status = code; return res }, json: () => {} } as unknown as Response
  browserBoundary({ ...config, ...opts.config }, interfaces)(req, res, (() => { effects++ }) as NextFunction)
  return { status, effects }
}

const denied = { status: 403, effects: 0 }
const allowed = { status: 200, effects: 1 }

describe("browser authority boundary", () => {
  it.each(["untrusted.invalid:4260", "localhost.untrusted.invalid:4260", "localhost:4261", "user@localhost:4260", "localhost:4260/path", "localhost:4260,untrusted.invalid", " localhost:4260", "localhost:99999", "[::1", "", undefined])("rejects authority %s before effects", (host) => {
    expect(check({ host }, { method: "GET" })).toEqual(denied)
  })

  it.each(["localhost:4260", "LOCALHOST:4260", "127.0.0.1:4260", "127.0.0.2:4260", "[::1]:4260"])("allows local authority %s", (host) => {
    expect(check({ host })).toEqual(allowed)
  })

  it("ignores forwarded authorities, origins and protocols", () => {
    expect(check({ host: "untrusted.invalid:4260", "x-forwarded-host": "localhost:4260", forwarded: "host=localhost:4260;proto=http" }, { method: "GET" })).toEqual(denied)
    expect(check({ origin: "https://untrusted.invalid", "x-forwarded-origin": "http://localhost:4260" })).toEqual(denied)
    expect(check({ origin: "https://localhost:4260", "x-forwarded-proto": "https" })).toEqual(denied)
    // Spoofing a foreign forwarded host cannot alter the actual local authority either.
    expect(check({ origin: "http://localhost:4260", "x-forwarded-host": "untrusted.invalid" })).toEqual(allowed)
  })

  it.each([false, true])("preserves LAN/Tailscale on an intentional wildcard deployment (allowOpen=%s)", (allowOpen) => {
    const deployment = { host: "0.0.0.0", password: allowOpen ? "" : "fixture", allowOpen }
    for (const host of ["192.168.1.20:4260", "100.100.1.2:4260", "[fd00::2]:4260"]) {
      expect(check({ host, origin: `http://${host}` }, { config: deployment })).toEqual(allowed)
    }
    expect(check({ host: "untrusted.invalid:4260" }, { config: deployment, method: "GET" })).toEqual(denied)
    expect(check({ host: "192.168.1.20:4260", origin: "https://untrusted.invalid" }, { config: deployment })).toEqual(denied)
    expect(check({ host: "100.100.1.2:4260", origin: "http://100.100.1.2:4261" }, { config: deployment })).toEqual(denied)
  })

  it("does not widen a loopback deployment just because allowOpen is set", () => {
    expect(check({ host: "192.168.1.20:4260" }, { config: { allowOpen: true } })).toEqual(denied)
  })

  it("allows an explicitly bound LAN address and an explicitly configured DNS name", () => {
    expect(check({ host: "100.100.1.2:4260", origin: "http://100.100.1.2:4260" }, { config: { host: "100.100.1.2", password: "fixture" } })).toEqual(allowed)
    expect(check({ host: "yard.tailnet.test:4260", origin: "http://yard.tailnet.test:4260" }, { config: { trustedOrigins: ["http://yard.tailnet.test:4260"] } })).toEqual(allowed)
  })

  it("supports default HTTP ports and direct TLS without forwarded headers", () => {
    expect(check({ host: "localhost", origin: "http://localhost" }, { port: 80 })).toEqual(allowed)
    expect(check({ origin: "https://localhost:4260" }, { tls: true })).toEqual(allowed)
  })
})

describe("browser mutation origin boundary", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects foreign/null/same-site origins for %s", (method) => {
    for (const origin of ["https://untrusted.invalid", "http://localhost:4261", "http://127.0.0.1:4260", "https://localhost:4260", "null", "", "http://localhost:4260/path", "http://localhost:4260 https://untrusted.invalid"]) {
      expect(check({ origin, "sec-fetch-site": "same-origin" }, { method })).toEqual(denied)
    }
  })

  it("accepts the exact local origin, including its port", () => {
    expect(check({ origin: "http://localhost:4260", "sec-fetch-site": "same-origin" })).toEqual(allowed)
  })

  it("preserves explicitly configured public and proxy origins with preserved or rewritten Host", () => {
    const deployment = { publicUrl: "https://yard.example.test/base", trustedOrigins: ["https://proxy.example.test:8443"] }
    for (const origin of ["https://yard.example.test", "https://proxy.example.test:8443"]) {
      expect(check({ origin, "sec-fetch-site": "same-origin" }, { config: deployment })).toEqual(allowed)
      expect(check({ host: new URL(origin).host, origin }, { config: deployment })).toEqual(allowed)
    }
    expect(check({ host: "yard.example.test:443", origin: "https://yard.example.test" }, { config: deployment })).toEqual(allowed)
    expect(check({ host: "yard.example.test:8443", origin: "https://yard.example.test" }, { config: deployment })).toEqual(denied)
    expect(check({ origin: "https://proxy.example.test" }, { config: deployment })).toEqual(denied)
    expect(check({ origin: "https://untrusted.invalid", "x-forwarded-host": "yard.example.test" }, { config: deployment })).toEqual(denied)
  })

  it("allows Vite only when its precise origin is configured", () => {
    const origin = "http://localhost:5173"
    expect(check({ origin })).toEqual(denied)
    expect(check({ origin }, { config: { trustedOrigins: [origin] } })).toEqual(allowed)
    expect(check({ origin: "http://localhost:5174" }, { config: { trustedOrigins: [origin] } })).toEqual(denied)
  })

  it.each(["cross-site", "same-site", "unexpected"])("rejects origin-less browser requests marked %s", (site) => {
    expect(check({ "sec-fetch-site": site })).toEqual(denied)
  })

  it("retains origin-less scripts/MCP/QStash and checks an older browser's Referer", () => {
    expect(check({ authorization: "Bearer fake-script-token" })).toEqual(allowed)
    expect(check({ "upstash-signature": "fake-signature" })).toEqual(allowed) // the route must still verify it
    expect(check({ "sec-fetch-site": "same-origin" })).toEqual(allowed)
    expect(check({ "sec-fetch-site": "none" })).toEqual(allowed)
    expect(check({ referer: "http://localhost:4260/settings" })).toEqual(allowed)
    expect(check({ referer: "http://localhost:4261/" })).toEqual(denied)
    expect(check({ referer: "invalid" })).toEqual(denied)
  })

  it.each(["GET", "HEAD", "OPTIONS"])("retains %s including OAuth navigations, with authority checks intact", (method) => {
    expect(check({ "sec-fetch-site": "cross-site", origin: "https://provider.test" }, { method })).toEqual(allowed)
    expect(check({ host: "untrusted.invalid:4260", "sec-fetch-site": "cross-site" }, { method })).toEqual(denied)
  })

  it.each(["null", "*", "https://user:pass@proxy.test", "https://proxy.test/path", "https://proxy.test,https://other.test", "file:///tmp/test"])("fails closed on invalid configured origin %s", (value) => {
    expect(() => browserBoundary({ ...config, trustedOrigins: [value] }, interfaces)).toThrow("BOXYARD_TRUSTED_ORIGINS")
  })
})

describe("secure cookies through a configured HTTPS proxy", () => {
  function cookie(headers: Record<string, string> = {}, options: Partial<BrowserBoundaryConfig> = {}, secure = false) {
    return secureBrowserCookie({ headers: { host: "localhost:4260", ...headers }, secure } as unknown as Request, { ...config, ...options })
  }
  it("does not trust spoofed forwarding, but uses direct TLS or configured HTTPS authorities", () => {
    expect(cookie({ "x-forwarded-proto": "https" })).toBe(false)
    expect(cookie({}, {}, true)).toBe(true)
    expect(cookie({ host: "yard.example.test" }, { publicUrl: "https://yard.example.test" })).toBe(true)
    expect(cookie({ host: "yard.example.test:443" }, { publicUrl: "https://yard.example.test" })).toBe(true)
    expect(cookie({ origin: "https://yard.example.test" }, { publicUrl: "https://yard.example.test" })).toBe(true)
    expect(cookie({ host: "proxy.test" }, { trustedOrigins: ["https://proxy.test"] })).toBe(true)
    expect(cookie({ origin: "https://untrusted.invalid" }, { publicUrl: "https://yard.example.test" })).toBe(false)
  })
})
