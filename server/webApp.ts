// Serves the built web app (dist/web). Vite names every file in /assets/ by its content hash, so those are cached
// for a year and never re-checked; index.html revalidates on every load, so a new build shows at once. Text files go
// out as the .br/.gz copies the build wrote (server/compress.ts), when the browser takes them.
import express, { type NextFunction, type Request, type Response } from "express"
import fs from "node:fs"
import path from "node:path"
import { PRECOMPRESSED, acceptedCodings, textFileType } from "./compress.js"
import { withoutFormerHome } from "../shared/formerHome.js"

/** Vite's build output: /assets/<name>-<hash>.<ext>. */
const HASHED = /^\/assets\/[^/]+-[\w-]{8,}\.\w+$/
export const IMMUTABLE = "public, max-age=31536000, immutable"
/** Stored, but checked with the server (ETag) before each use. */
export const REVALIDATE = "no-cache"
/** Icons and the manifest: unhashed, rarely changed. */
const UNHASHED = "public, max-age=3600"

export function cacheControlFor(urlPath: string) {
  if (HASHED.test(urlPath)) return IMMUTABLE
  return urlPath === "/index.html" ? REVALIDATE : UNHASHED
}

/** The router for the web app in `webDir`: its files, then index.html for any other page outside the API. */
export function webApp(webDir: string) {
  const root = path.resolve(webDir)
  const router = express.Router()

  /** `urlPath`'s precompressed copy for this browser, if the build wrote one; else on to `next`. */
  const sendPrecompressed = (req: Request, res: Response, next: NextFunction, urlPath: string) => {
    const type = textFileType(urlPath)
    if (!type) return next()
    res.vary("Accept-Encoding")
    const rel = inside(root, urlPath)
    const pick = rel && acceptedCodings(req.get("accept-encoding")).map((c) => PRECOMPRESSED.find((p) => p.coding === c)!).find((p) => fs.existsSync(path.join(root, rel + p.ext)))
    if (!rel || !pick) return next()
    const headers = { "Content-Encoding": pick.coding, "Content-Type": type, "Cache-Control": cacheControlFor(urlPath) }
    // Relative to `root`, so only the path inside the web app is checked for dotfiles. Failing before any byte went
    // out (say, the file vanished in a rebuild) falls back to the plain file.
    res.sendFile(rel + pick.ext, { root, headers }, (err) => err && !res.headersSent && next())
  }

  // The app's former home (shared/formerHome.ts): an old link opens the same page at its path today, query kept.
  router.use((req, res, next) => {
    const to = req.method === "GET" || req.method === "HEAD" ? withoutFormerHome(req.originalUrl) : null
    if (to === null) next()
    else res.redirect(301, to)
  })
  router.use((req, res, next) => (req.method === "GET" || req.method === "HEAD" ? sendPrecompressed(req, res, next, req.path) : next()))
  router.use(express.static(root, { index: false, setHeaders: (res, file) => res.setHeader("Cache-Control", cacheControlFor(urlOf(root, file))) }))
  // A missing /assets/ file 404s: an old tab asking for a previous build's chunk must not get index.html as code.
  router.get(/^\/(?!api\/|mcp|artifacts\/|qstash\/|assets\/).*/, (req, res) =>
    sendPrecompressed(req, res, () => res.sendFile("index.html", { root, headers: { "Cache-Control": REVALIDATE } }), "/index.html"),
  )
  return router
}

/** The script a page loads first ("/assets/index-<hash>.js"): it names the build, as Vite hashes it by content. */
export function entryScript(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']?module["'\s>]/i.test(tag)) continue
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
    if (src?.startsWith("/assets/")) return src
  }
  return null
}

/**
 * The build the web app in `webDir` serves now: its index.html's entry script, re-read when the file changes (a
 * rebuild), so it's always what a reload would run. Null while there's none. The event stream's "hello" says it, and
 * an open tab still running an older build reloads (web/src/lib/appUpdate.ts).
 */
export function webBuild(webDir: string): () => string | null {
  const file = path.join(path.resolve(webDir), "index.html")
  let stamp = ""
  let build: string | null = null
  return () => {
    try {
      const st = fs.statSync(file)
      const now = `${st.mtimeMs}:${st.size}`
      if (now !== stamp) {
        build = entryScript(fs.readFileSync(file, "utf8"))
        stamp = now
      }
    } catch {
      stamp = ""
      build = null
    }
    return build
  }
}

/** `urlPath` decoded, when it is a plain path inside `root` (no dot segments): else null. */
function inside(root: string, urlPath: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (rel.includes("\0") || rel.split(/[/\\]/).some((s) => s.startsWith("."))) return null
  return path.join(root, rel).startsWith(root + path.sep) ? rel : null
}

function urlOf(root: string, file: string) {
  return "/" + path.relative(root, file).split(path.sep).join("/")
}
