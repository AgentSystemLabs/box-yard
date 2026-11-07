// GET /api/boot's answers into the query cache, all in one go, as if each query had just fetched its own path
// (lib/boot.ts). The live stream keeps them current from there like any other cached data.
import { notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { keys } from "./queries"
import { COORDINATOR_CHAT, threadKeys } from "./threads"
import { captainStatePath, type BootPath, type BootPayload } from "../../../shared/boot"
import type { Health, Project } from "../../../shared/types"

/** The query each boot path answers: the one whose queryFn GETs that path. */
export const BOOT_KEYS: Record<BootPath, QueryKey> = {
  "/api/health": keys.health,
  "/api/projects": keys.projects,
  "/api/tasks": keys.tasks,
  "/api/chat": keys.chat,
  "/api/threads": threadKeys.list(COORDINATOR_CHAT),
  "/api/agent-settings": keys.agentSettings,
  "/api/settings": keys.settings,
  "/api/notifications?limit=50": keys.notifications,
  "/api/schedules": keys.schedules,
  "/api/artifacts": keys.artifacts,
  "/api/boxes": keys.boxes,
}

/** Lands a frame after the rest: it's the heavy render, so the app around it paints first. */
const LATER: BootPath = "/api/chat"
/** If no frame comes (a background tab), the rest lands after this long anyway. */
const FRAME_FALLBACK_MS = 250

/**
 * Seed the cache, never over data a query already fetched for itself: one notification, so one render, then the
 * Coordinator's chat after the next paint. Resolves once it's all in.
 */
export function seedBoot(qc: QueryClient, { responses }: BootPayload): Promise<void> {
  const put = (key: QueryKey, data: unknown) => {
    if (data !== undefined && qc.getQueryData(key) === undefined) qc.setQueryData(key, data)
  }
  notifyManager.batch(() => {
    for (const [path, key] of Object.entries(BOOT_KEYS)) if (path !== LATER) put(key, responses[path])
    for (const p of (responses["/api/projects"] as Project[] | undefined) ?? []) put(keys.captain(p.id), responses[captainStatePath(p.id)])
    // useChatBusy reads it from /api/health too.
    put(keys.chatBusy, (responses["/api/health"] as Health | undefined)?.orchestratorBusy)
  })
  return new Promise((resolve) => {
    let done = false
    const rest = () => {
      if (done) return
      done = true
      put(BOOT_KEYS[LATER], responses[LATER])
      resolve()
    }
    requestAnimationFrame(() => setTimeout(rest, 0))
    setTimeout(rest, FRAME_FALLBACK_MS)
  })
}
