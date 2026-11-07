import fs from "node:fs"
import { request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import express from "express"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { acceptedCodings, compressResponses, precompress } from "../server/compress.js"
import { tmpDir } from "./helpers.js"

describe("acceptedCodings", () => {
  it("prefers br, then gzip, and honours q-values and wildcards", () => {
    expect(acceptedCodings("gzip, deflate, br, zstd")).toEqual(["br", "gzip"])
    expect(acceptedCodings("gzip;q=1.0, br;q=0.5")).toEqual(["gzip", "br"])
    expect(acceptedCodings("br;q=0, gzip")).toEqual(["gzip"])
    expect(acceptedCodings("x-gzip")).toEqual(["gzip"])
    expect(acceptedCodings(" BR ; q=0.4 , gzip ; q=0.8")).toEqual(["gzip", "br"])
    expect(acceptedCodings("*")).toEqual(["br", "gzip"])
    expect(acceptedCodings("*;q=0.1, br;q=0")).toEqual(["gzip"])
    expect(acceptedCodings("identity")).toEqual([])
    expect(acceptedCodings("")).toEqual([])
    expect(acceptedCodings(undefined)).toEqual([])
  })
})

type Raw = { res: IncomingMessage; body: Buffer }

/** One request, with the body as sent (Node's http client never decompresses). */
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

describe("compressResponses", () => {
  let base = ""
  let close = () => {}
  const big = Array.from({ length: 400 }, (_, i) => ({ id: `task_${i}`, title: `A task title number ${i}`, status: "idle" }))
  const bigJson = JSON.stringify(big)
  let releaseStream = () => {}

  beforeAll(async () => {
    const app = express()
    app.use(compressResponses())
    app.get("/big", (_req, res) => res.json(big))
    app.get("/small", (_req, res) => res.json({ ok: true }))
    app.get("/missing", (_req, res) => res.status(404).json({ error: "x".repeat(4000) }))
    app.get("/text", (_req, res) => res.type("text").send("plain text ".repeat(500)))
    app.get("/binary", (_req, res) => res.type("png").send(Buffer.alloc(8000, 7)))
    app.get("/encoded", (_req, res) => res.set("Content-Encoding", "gzip").type("json").send(Buffer.from("already")))
    app.get("/no-transform", (_req, res) => res.set("Cache-Control", "no-transform").json(big))
    app.get("/sse", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.write(`data: ${JSON.stringify(big.slice(0, 50))}\n\n`)
      releaseStream = () => res.end()
    })
    app.get("/stream", (_req, res) => {
      res.type("text")
      res.write("first part ".repeat(200))
      setTimeout(() => res.end("last part ".repeat(200)), 5)
    })
    const server = app.listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => {
      server.closeAllConnections()
      server.close()
    }
  })
  afterAll(() => close())

  it("brotli-compresses a large JSON body for a browser that takes br", async () => {
    const raw = await fetchRaw(`${base}/big`, { "Accept-Encoding": "gzip, deflate, br" })
    expect(raw.res.statusCode).toBe(200)
    expect(raw.res.headers["content-encoding"]).toBe("br")
    expect(raw.res.headers["content-type"]).toMatch(/^application\/json/)
    expect(raw.res.headers.vary).toMatch(/Accept-Encoding/)
    expect(raw.res.headers["content-length"]).toBeUndefined()
    expect(raw.body.length).toBeLessThan(bigJson.length / 5)
    expect(JSON.parse(decoded(raw))).toEqual(big)
  })

  it("gzips for a client that only takes gzip, and keeps the status code", async () => {
    const raw = await fetchRaw(`${base}/big`, { "Accept-Encoding": "gzip" })
    expect(raw.res.headers["content-encoding"]).toBe("gzip")
    expect(JSON.parse(decoded(raw))).toEqual(big)
    const missing = await fetchRaw(`${base}/missing`, { "Accept-Encoding": "br" })
    expect(missing.res.statusCode).toBe(404)
    expect(missing.res.headers["content-encoding"]).toBe("br")
    expect(JSON.parse(decoded(missing)).error).toHaveLength(4000)
  })

  it("sends plain bodies to a client without br or gzip, still saying they vary", async () => {
    const raw = await fetchRaw(`${base}/big`)
    expect(raw.res.headers["content-encoding"]).toBeUndefined()
    expect(raw.res.headers.vary).toMatch(/Accept-Encoding/)
    expect(Number(raw.res.headers["content-length"])).toBe(raw.body.length)
    expect(raw.body.toString()).toBe(bigJson)
  })

  it("leaves small, binary, already-encoded and no-transform bodies alone", async () => {
    const ae = { "Accept-Encoding": "br, gzip" }
    const small = await fetchRaw(`${base}/small`, ae)
    expect(small.res.headers["content-encoding"]).toBeUndefined()
    expect(small.body.toString()).toBe('{"ok":true}')
    const binary = await fetchRaw(`${base}/binary`, ae)
    expect(binary.res.headers["content-encoding"]).toBeUndefined()
    expect(binary.body.length).toBe(8000)
    const encoded = await fetchRaw(`${base}/encoded`, ae)
    expect(encoded.res.headers["content-encoding"]).toBe("gzip")
    expect(encoded.body.toString()).toBe("already")
    const noTransform = await fetchRaw(`${base}/no-transform`, ae)
    expect(noTransform.res.headers["content-encoding"]).toBeUndefined()
    expect(noTransform.body.toString()).toBe(bigJson)
    const text = await fetchRaw(`${base}/text`, ae)
    expect(text.res.headers["content-encoding"]).toBe("br")
  })

  it("never compresses a stream: SSE events arrive while it is still open", async () => {
    const first = await new Promise<{ res: IncomingMessage; chunk: string }>((resolve, reject) => {
      request(`${base}/sse`, { headers: { "Accept-Encoding": "br, gzip" } }, (res) => res.once("data", (c: Buffer) => resolve({ res, chunk: c.toString() })))
        .on("error", reject)
        .end()
    })
    expect(first.res.headers["content-encoding"]).toBeUndefined()
    expect(first.chunk).toMatch(/^data: \[/)
    releaseStream()
    const parts = await fetchRaw(`${base}/stream`, { "Accept-Encoding": "br" })
    expect(parts.res.headers["content-encoding"]).toBeUndefined()
    expect(parts.body.toString()).toBe("first part ".repeat(200) + "last part ".repeat(200))
  })

  it("keeps HEAD and ETag revalidation working", async () => {
    const head = await fetchRaw(`${base}/big`, { "Accept-Encoding": "br" }, "HEAD")
    expect(head.res.statusCode).toBe(200)
    expect(head.body.length).toBe(0)
    const { res } = await fetchRaw(`${base}/big`, { "Accept-Encoding": "br" })
    expect(res.headers.etag).toBeTruthy()
    const again = await fetchRaw(`${base}/big`, { "Accept-Encoding": "br", "If-None-Match": res.headers.etag! })
    expect(again.res.statusCode).toBe(304)
    expect(again.res.headers["content-encoding"]).toBeUndefined()
    expect(again.body.length).toBe(0)
  })
})

describe("precompress", () => {
  it("writes .br and .gz beside each text file of at least 1 KB, and nothing else", async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, "assets"))
    const js = "export const answer = 42;\n".repeat(200)
    fs.writeFileSync(path.join(dir, "assets", "index-AbCd1234.js"), js)
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>" + "<p>hi</p>".repeat(200))
    fs.writeFileSync(path.join(dir, "tiny.css"), "a{}")
    fs.writeFileSync(path.join(dir, "icon.png"), Buffer.alloc(4000, 1))

    const done = await precompress(dir)

    expect(done.map((f) => path.relative(dir, f)).sort()).toEqual([path.join("assets", "index-AbCd1234.js"), "index.html"])
    const file = path.join(dir, "assets", "index-AbCd1234.js")
    expect(brotliDecompressSync(fs.readFileSync(file + ".br")).toString()).toBe(js)
    expect(gunzipSync(fs.readFileSync(file + ".gz")).toString()).toBe(js)
    expect(fs.existsSync(path.join(dir, "tiny.css.br"))).toBe(false)
    expect(fs.existsSync(path.join(dir, "icon.png.br"))).toBe(false)
  })
})
