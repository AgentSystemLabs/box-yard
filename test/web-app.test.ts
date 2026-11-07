import fs from "node:fs"
import { request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import express from "express"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { precompress } from "../server/compress.js"
import { IMMUTABLE, REVALIDATE, cacheControlFor, webApp } from "../server/webApp.js"
import { tmpDir } from "./helpers.js"

type Raw = { res: IncomingMessage; body: Buffer }

function fetchRaw(url: string, headers: OutgoingHttpHeaders = {}, method = "GET"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject).end()
  })
}

const decoded = ({ res, body }: Raw) =>
  (res.headers["content-encoding"] === "br" ? brotliDecompressSync(body) : res.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString()

const JS = "/assets/index-AbCd_123.js"
const js = "console.log('the app');\n".repeat(400)
const html = `<!doctype html><html><head><script type="module" src="${JS}"></script></head><body>${"<!-- padding -->".repeat(80)}</body></html>`

/** A built web app (precompressed or not) behind the router, with a file outside it that must never be served. */
async function serve(opts: { precompressed: boolean; hidden?: boolean }) {
  const root = tmpDir()
  const webDir = path.join(root, opts.hidden ? ".worktrees/x/dist/web" : "web")
  fs.mkdirSync(path.join(webDir, "assets"), { recursive: true })
  fs.writeFileSync(path.join(webDir, "index.html"), html)
  fs.writeFileSync(path.join(webDir, JS), js)
  fs.writeFileSync(path.join(webDir, "favicon.ico"), Buffer.alloc(1500, 1))
  fs.writeFileSync(path.join(webDir, "manifest.webmanifest"), JSON.stringify({ name: "x".repeat(2000) }))
  fs.writeFileSync(path.join(root, "secret.js"), "SECRET".repeat(400))
  if (opts.precompressed) await precompress(webDir)
  const app = express()
  app.get("/api/thing", (_req, res) => res.json({ api: true }))
  app.use(webApp(webDir))
  const server = app.listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

describe("cacheControlFor", () => {
  it("caches hashed build files for a year and revalidates index.html", () => {
    expect(cacheControlFor("/assets/index-iHl4CH5W.js")).toBe(IMMUTABLE)
    expect(cacheControlFor("/assets/Markdown-B_x-9aQz.css")).toBe(IMMUTABLE)
    expect(cacheControlFor("/index.html")).toBe(REVALIDATE)
    // Not Vite-hashed: a short cache, never immutable.
    expect(cacheControlFor("/assets/logo.svg")).not.toBe(IMMUTABLE)
    expect(cacheControlFor("/favicon.ico")).not.toBe(IMMUTABLE)
  })
})

describe("webApp, precompressed build", () => {
  let base = ""
  let close = () => {}
  beforeAll(async () => ({ base, close } = await serve({ precompressed: true })))
  afterAll(() => close())

  it("sends a hashed bundle as brotli or gzip, cached for a year", async () => {
    const br = await fetchRaw(base + JS, { "Accept-Encoding": "gzip, deflate, br" })
    expect(br.res.statusCode).toBe(200)
    expect(br.res.headers["content-encoding"]).toBe("br")
    expect(br.res.headers["content-type"]).toBe("text/javascript; charset=utf-8")
    expect(br.res.headers["cache-control"]).toBe(IMMUTABLE)
    expect(br.res.headers.vary).toMatch(/Accept-Encoding/)
    expect(br.body.length).toBeLessThan(js.length / 10)
    expect(decoded(br)).toBe(js)

    const gz = await fetchRaw(base + JS, { "Accept-Encoding": "gzip" })
    expect(gz.res.headers["content-encoding"]).toBe("gzip")
    expect(decoded(gz)).toBe(js)

    const plain = await fetchRaw(base + JS)
    expect(plain.res.headers["content-encoding"]).toBeUndefined()
    expect(plain.res.headers["cache-control"]).toBe(IMMUTABLE)
    expect(plain.body.toString()).toBe(js)
  })

  it("serves index.html for app pages, compressed and revalidated on every load", async () => {
    for (const page of ["/", "/tasks/task_abc123", "/index.html"]) {
      const raw = await fetchRaw(base + page, { "Accept-Encoding": "br" })
      expect(raw.res.statusCode).toBe(200)
      expect(raw.res.headers["content-type"]).toBe("text/html; charset=utf-8")
      expect(raw.res.headers["cache-control"]).toBe(REVALIDATE)
      expect(raw.res.headers["content-encoding"]).toBe("br")
      expect(decoded(raw)).toBe(html)
    }
    const { res } = await fetchRaw(base + "/", { "Accept-Encoding": "br" })
    const again = await fetchRaw(base + "/", { "Accept-Encoding": "br", "If-None-Match": res.headers.etag! })
    expect(again.res.statusCode).toBe(304)
    const plain = await fetchRaw(base + "/tasks/task_abc123")
    expect(plain.res.headers["cache-control"]).toBe(REVALIDATE)
    expect(plain.body.toString()).toBe(html)
  })

  it("redirects the app's former /zen home to the same page without it, query and all", async () => {
    for (const [from, to] of [
      ["/zen", "/"],
      ["/zen/", "/"],
      ["/zen?session=task_abc123&stack=task_def456", "/?session=task_abc123&stack=task_def456"],
      ["/zen/tasks/task_abc123?x=1", "/tasks/task_abc123?x=1"],
      // Never an open redirect to another host.
      ["/zen//evil.example/x", "/evil.example/x"],
    ]) {
      const { res } = await fetchRaw(base + from!)
      expect(res.statusCode, from).toBe(301)
      expect(res.headers.location, from).toBe(to)
    }
    // Only that segment: a page whose name starts with it is a page like any other.
    const other = await fetchRaw(base + "/zenith")
    expect(other.res.statusCode).toBe(200)
    expect(other.body.toString()).toBe(html)
  })

  it("404s a previous build's chunk instead of answering with index.html", async () => {
    const raw = await fetchRaw(base + "/assets/index-OldHash9.js", { "Accept-Encoding": "br" })
    expect(raw.res.statusCode).toBe(404)
    expect(raw.res.headers["content-type"]).not.toMatch(/javascript/)
  })

  it("keeps unhashed files on a short cache, and binary files uncompressed", async () => {
    const icon = await fetchRaw(base + "/favicon.ico", { "Accept-Encoding": "br" })
    expect(icon.res.headers["content-encoding"]).toBeUndefined()
    expect(icon.res.headers["cache-control"]).toBe("public, max-age=3600")
    const manifest = await fetchRaw(base + "/manifest.webmanifest", { "Accept-Encoding": "br" })
    expect(manifest.res.headers["content-encoding"]).toBe("br")
    expect(manifest.res.headers["content-type"]).toBe("application/manifest+json; charset=utf-8")
    expect(manifest.res.headers["cache-control"]).toBe("public, max-age=3600")
  })

  it("answers HEAD without a body and leaves the API to its own routes", async () => {
    const head = await fetchRaw(base + JS, { "Accept-Encoding": "br" }, "HEAD")
    expect(head.res.statusCode).toBe(200)
    expect(head.res.headers["content-encoding"]).toBe("br")
    expect(head.body.length).toBe(0)
    const api = await fetchRaw(base + "/api/thing")
    expect(JSON.parse(api.body.toString())).toEqual({ api: true })
  })

  it("never serves a file outside the web app, or a .br copy by its own name as code", async () => {
    for (const p of ["/..%2fsecret.js", "/%2e%2e/secret.js", "/assets/..%2f..%2fsecret.js"]) {
      const raw = await fetchRaw(base + p, { "Accept-Encoding": "br" })
      expect(decoded(raw)).not.toContain("SECRET")
    }
    const sibling = await fetchRaw(base + JS + ".br")
    expect(sibling.res.headers["content-type"]).not.toMatch(/javascript/)
  })
})

describe("webApp, build without precompressed copies", () => {
  let base = ""
  let close = () => {}
  beforeAll(async () => ({ base, close } = await serve({ precompressed: false })))
  afterAll(() => close())

  it("sends the plain files with the same cache rules", async () => {
    const asset = await fetchRaw(base + JS, { "Accept-Encoding": "br, gzip" })
    expect(asset.res.statusCode).toBe(200)
    expect(asset.res.headers["content-encoding"]).toBeUndefined()
    expect(asset.res.headers["cache-control"]).toBe(IMMUTABLE)
    expect(asset.body.toString()).toBe(js)
    const page = await fetchRaw(base + "/projects/x", { "Accept-Encoding": "br, gzip" })
    expect(page.res.headers["cache-control"]).toBe(REVALIDATE)
    expect(page.body.toString()).toBe(html)
  })
})

describe("webApp, checkout inside a hidden folder", () => {
  let base = ""
  let close = () => {}
  beforeAll(async () => ({ base, close } = await serve({ precompressed: true, hidden: true })))
  afterAll(() => close())

  it("still serves the pages and the compressed bundle", async () => {
    const page = await fetchRaw(base + "/tasks/task_abc123", { "Accept-Encoding": "br" })
    expect(page.res.statusCode).toBe(200)
    expect(decoded(page)).toBe(html)
    const asset = await fetchRaw(base + JS, { "Accept-Encoding": "br" })
    expect(asset.res.headers["content-encoding"]).toBe("br")
    expect(decoded(asset)).toBe(js)
  })
})
