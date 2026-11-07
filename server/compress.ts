// HTTP compression. The build writes .br and .gz copies of the web app's text files (`precompress`, run by
// vite.config.ts), which server/webApp.ts sends as they are. API bodies are compressed as they go out
// (`compressResponses`): only a body sent whole (res.json, res.send), so SSE, audio and files stream untouched.
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import type { RequestHandler, Response } from "express"

export type Coding = "br" | "gzip"

/** Each coding's precompressed sibling: index-abc.js → index-abc.js.br. Best first. */
export const PRECOMPRESSED: readonly { coding: Coding; ext: string }[] = [
  { coding: "br", ext: ".br" },
  { coding: "gzip", ext: ".gz" },
]

/** Web app files worth compressing (images and fonts are compressed already), with the type each is sent as. */
export const TEXT_FILE_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

export const textFileType = (file: string) => TEXT_FILE_TYPES[path.extname(file)]

/** Response types worth compressing. Never text/event-stream: SSE must reach the browser event by event. */
const COMPRESSIBLE_TYPE = /^(?:text\/(?!event-stream)|application\/(?:[\w.-]+\+)?(?:json|javascript|xml)\b|image\/svg\+xml)/i

/** Below this, the codings' headers cost about what they save. */
export const MIN_COMPRESS_BYTES = 1024

/** The codings an Accept-Encoding header takes, best first (q-values, then br before gzip). */
export function acceptedCodings(header: string | undefined): Coding[] {
  const q = new Map<string, number>()
  for (const part of (header ?? "").split(",")) {
    const [first = "", ...params] = part.toLowerCase().split(";")
    const name = first.trim()
    if (!name) continue
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    const value = qParam ? Number(qParam.slice(2)) : 1
    q.set(name === "x-gzip" ? "gzip" : name, Number.isFinite(value) ? value : 0)
  }
  const weight = (c: Coding) => q.get(c) ?? q.get("*") ?? 0
  return PRECOMPRESSED.map((p) => p.coding)
    .filter((c) => weight(c) > 0)
    .sort((a, b) => weight(b) - weight(a))
}

/** Fast settings for bodies compressed per request: brotli 4 is near gzip 6's size in about a third of the time. */
const LIVE: Record<Coding, (body: Buffer, cb: zlib.CompressCallback) => void> = {
  br: (body, cb) => zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, cb),
  gzip: (body, cb) => zlib.gzip(body, { level: 6 }, cb),
}

/**
 * Compresses API bodies sent whole (res.json, res.send) for a browser that takes br or gzip. The work runs on
 * zlib's thread pool, so a large transcript doesn't hold up the event loop. Left alone: anything written in parts
 * (SSE, streamed audio, files), HEAD, 204/304, small bodies, a Content-Encoding already set, and no-transform.
 */
export function compressResponses(): RequestHandler {
  return (req, res, next) => {
    const coding = req.method === "HEAD" ? undefined : acceptedCodings(req.get("accept-encoding"))[0]
    const end = res.end as (...args: unknown[]) => Response
    res.end = function (this: Response, ...args: unknown[]) {
      res.end = end as Response["end"]
      const [chunk, encoding, cb] = typeof args[1] === "function" ? [args[0], undefined, args[1]] : args
      const body = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, (encoding as BufferEncoding | undefined) ?? "utf8") : null
      // Headers already out means it was written in parts (a stream, like SSE): the end goes out as it is.
      if (!body || res.headersSent || !compressible(res)) return end.apply(this, args)
      res.vary("Accept-Encoding")
      if (!coding || body.length < MIN_COMPRESS_BYTES) return end.apply(this, args)
      res.setHeader("Content-Encoding", coding)
      res.removeHeader("Content-Length")
      // Headers go now, as they would have; the body follows from the thread pool (chunked).
      res.writeHead(res.statusCode)
      LIVE[coding](body, (err, out) => {
        if (err) return void res.destroy(err)
        if (!res.destroyed) end.call(res, out, cb)
      })
      return res
    } as Response["end"]
    next()
  }
}

function compressible(res: Response) {
  const status = res.statusCode
  if (status < 200 || status === 204 || status === 304 || res.getHeader("Content-Encoding")) return false
  if (/\bno-transform\b/i.test(String(res.getHeader("Cache-Control") ?? ""))) return false
  return COMPRESSIBLE_TYPE.test(String(res.getHeader("Content-Type") ?? ""))
}

/**
 * Writes `<file>.br` (best brotli) and `<file>.gz` (best gzip) beside every compressible file under `dir` of at
 * least MIN_COMPRESS_BYTES, in parallel. Slow settings on purpose: it runs once per build, and every download
 * of the bundle after that is about a fifth smaller than per-request brotli. Returns the files it compressed.
 */
export async function precompress(dir: string): Promise<string[]> {
  const files = (await fs.readdir(dir, { recursive: true })).filter((f) => textFileType(f)).map((f) => path.join(dir, f))
  const best: Record<Coding, (body: Buffer) => Promise<Buffer>> = {
    br: (body) =>
      new Promise((resolve, reject) =>
        zlib.brotliCompress(
          body,
          { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } },
          (err, out) => (err ? reject(err) : resolve(out)),
        ),
      ),
    gzip: (body) => new Promise((resolve, reject) => zlib.gzip(body, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, out) => (err ? reject(err) : resolve(out)))),
  }
  const done = await Promise.all(
    files.map(async (file) => {
      if (!(await fs.stat(file)).isFile()) return null
      const body = await fs.readFile(file)
      if (body.length < MIN_COMPRESS_BYTES) return null
      await Promise.all(PRECOMPRESSED.map(async ({ coding, ext }) => fs.writeFile(file + ext, await best[coding](body))))
      return file
    }),
  )
  return done.filter((f): f is string => f !== null)
}
