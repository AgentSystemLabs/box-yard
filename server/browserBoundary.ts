import os from "node:os"
import type { Request, RequestHandler } from "express"
import { isLoopback, isWildcard } from "./bind.js"

export type BrowserBoundaryConfig = {
  host: string
  port: number
  password: string
  allowOpen: boolean
  publicUrl: string
  trustedOrigins: string[]
}

/** Parse an HTTP origin without accepting credentials, paths, opaque origins or lists. */
function originUrl(value: string): URL | null {
  try {
    const u = new URL(value)
    return /^(http|https):$/.test(u.protocol) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash ? u : null
  } catch {
    return null
  }
}

function hostUrl(value: string | undefined, protocol: string): URL | null {
  // URL alone also accepts userinfo, paths and whitespace in an authority.
  if (!value || !/^(?:\[[\da-fA-F:.]+\]|[a-zA-Z\d.-]+)(?::\d{1,5})?$/.test(value)) return null
  return originUrl(`${protocol}//${value}`)
}

const portOf = (u: URL) => Number(u.port || (u.protocol === "https:" ? 443 : 80))
const urlHost = (host: string) => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host

/**
 * An authority gate for every route, followed by an origin gate for unsafe methods. Install before all parsers.
 * Forwarded headers are deliberately irrelevant: only configured origins can name a reverse proxy's public side.
 * Origin-less scripts, MCP and signed QStash deliveries still pass through their existing authentication gates.
 */
export function browserBoundary(c: BrowserBoundaryConfig, interfaces = os.networkInterfaces()): RequestHandler {
  const trusted = c.trustedOrigins.map((value) => {
    const u = originUrl(value)
    if (!u) throw new Error("BOXYARD_TRUSTED_ORIGINS must contain comma-separated HTTP(S) origins without paths")
    return u
  })
  if (c.publicUrl) {
    const u = new URL(c.publicUrl)
    if (!/^(http|https):$/.test(u.protocol) || u.username || u.password) throw new Error("BOXYARD_PUBLIC_URL must be an HTTP(S) URL")
    trusted.push(new URL(u.origin))
  }
  const origins = new Set(trusted.map((u) => u.origin))
  const directHosts = new Set<string>()
  if (!isWildcard(c.host)) directHosts.add(urlHost(c.host).toLowerCase())
  // Retain the LAN/Tailscale URLs the server advertises for an intentional network deployment.
  // ALLOW_OPEN widens this address list, never the browser-origin policy or arbitrary DNS names.
  if (isWildcard(c.host) && (c.password || c.allowOpen)) {
    for (const infos of Object.values(interfaces)) {
      for (const info of infos ?? []) directHosts.add(urlHost(info.address).toLowerCase())
    }
  }

  return (req, res, next) => {
    const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https:" : "http:"
    const target = hostUrl(req.headers.host, protocol)
    const direct = target && portOf(target) === (req.socket.localPort || c.port) && (isLoopback(target.hostname) || directHosts.has(target.hostname))
    const configured = trusted.some((u) => hostUrl(req.headers.host, u.protocol)?.host === u.host)
    if (!target || (!direct && !configured)) {
      res.status(403).json({ error: "Untrusted request host." })
      return
    }
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next()

    const allowed = (value: string) => {
      const u = originUrl(value)
      return u && (origins.has(u.origin) || (direct && u.origin === target.origin))
    }
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (typeof origin !== "string" || !allowed(origin)) {
        res.status(403).json({ error: "Untrusted request origin." })
        return
      }
    } else {
      const site = req.headers["sec-fetch-site"]
      if (site !== undefined && site !== "same-origin" && site !== "none") {
        res.status(403).json({ error: "Cross-origin browser request rejected." })
        return
      }
      // Older browsers may send Referer without Origin. Programmatic callers can omit both.
      if (req.headers.referer !== undefined) {
        let origin: string | undefined
        try { origin = new URL(req.headers.referer).origin } catch { /* invalid referer */ }
        if (!origin || !allowed(origin)) {
          res.status(403).json({ error: "Untrusted request referer." })
          return
        }
      }
    }
    next()
  }
}

/** Secure cookies behind configured HTTPS proxies, without trusting X-Forwarded-Proto from a client. */
export function secureBrowserCookie(req: Request, c: Pick<BrowserBoundaryConfig, "publicUrl" | "trustedOrigins">): boolean {
  if (req.secure) return true
  const urls = [c.publicUrl, ...c.trustedOrigins].filter(Boolean).map((value) => new URL(value))
  return urls.some((u) => u.protocol === "https:" && (hostUrl(req.headers.host, u.protocol)?.host === u.host || u.origin === req.headers.origin))
}
