// GET /api/captains/recent: every project's Captain as its chat opens (state, newest messages, side threads), in one
// gzipped response. The web app prefetches it once after its first paint (web/src/lib/captainPrefetch.ts), so switching
// Captains shows the conversation at once instead of waiting on three requests per project.
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import type { Request, Response } from "express"
import type { CaptainMessage, CaptainState, Project, RecentCaptain, SideThread } from "../shared/types.js"

/** Messages per Captain: more than the first screen of its chat (useTail renders the newest 60 rows). */
export const RECENT_CAPTAIN_MESSAGES = 100
export const MAX_RECENT_CAPTAIN_MESSAGES = 500
/** A bound on one response; projects past it load when opened, as before. */
export const MAX_RECENT_CAPTAINS = 50

export interface RecentCaptainSources {
  projects: () => Project[]
  state: (projectId: string) => CaptainState
  messages: (projectId: string, limit: number) => CaptainMessage[]
  threads: (projectId: string) => SideThread[]
}

/** The first `MAX_RECENT_CAPTAINS` projects (sidebar order), each with its `limit` newest messages. */
export function recentCaptains(src: RecentCaptainSources, limit = RECENT_CAPTAIN_MESSAGES): RecentCaptain[] {
  return src
    .projects()
    .slice(0, MAX_RECENT_CAPTAINS)
    .map((p) => {
      // One more than asked says whether older messages exist.
      const messages = src.messages(p.id, limit + 1)
      const more = messages.length > limit
      return { projectId: p.id, state: src.state(p.id), messages: more ? messages.slice(1) : messages, more, threads: src.threads(p.id) }
    })
}

/** `?limit=` within 1…MAX_RECENT_CAPTAIN_MESSAGES, else the default. */
export function recentLimit(v: unknown): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_RECENT_CAPTAIN_MESSAGES) : RECENT_CAPTAIN_MESSAGES
}

const gzipAsync = promisify(gzip)

/** JSON, gzipped when the browser takes it: transcripts shrink about 5×, which a phone on a slow link feels. */
export async function sendCompressedJson(req: Request, res: Response, body: unknown): Promise<void> {
  const json = JSON.stringify(body)
  res.vary("Accept-Encoding").type("json")
  if (json.length < 1024 || !/\bgzip\b/.test(req.get("accept-encoding") ?? "")) {
    res.send(json)
    return
  }
  res.set("Content-Encoding", "gzip").send(await gzipAsync(json))
}
