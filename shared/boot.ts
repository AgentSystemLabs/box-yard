// GET /api/boot: the GETs the web app makes on every load, answered in one response. The page asks for it before the
// app's script has even loaded (web/index.html), and each GET then takes its answer instead of a round trip of its own
// (web/src/lib/boot.ts).

/**
 * Where the event stream stood when a snapshot was read. A stream says the same of itself in its "hello" event, and an
 * open stream hears a "boot" event with it, among its other events, when a snapshot is read.
 */
export interface StreamPosition {
  /** This server's run: a restart starts counting again. */
  epoch: string
  /** Events sent so far. */
  seq: number
}

/** The paths answered, exactly as the app asks for them. Each project's Captain state rides along at its own path. */
export const BOOT_PATHS = [
  "/api/health",
  "/api/projects",
  "/api/tasks",
  "/api/chat",
  "/api/threads",
  "/api/agent-settings",
  "/api/settings",
  "/api/notifications?limit=50",
  "/api/schedules",
  "/api/artifacts",
  "/api/boxes",
] as const

/**
 * A stream's "hello": where it starts, and the web build the server serves now (index.html's entry script,
 * server/webApp.ts webBuild; null when it serves none). A tab running another build reloads (web/src/lib/appUpdate.ts).
 */
export interface StreamHello extends StreamPosition {
  web?: string | null
}

export type BootPath = (typeof BOOT_PATHS)[number]

export const captainStatePath = (projectId: string) => `/api/projects/${projectId}/captain`

const CAPTAIN_STATE = /^\/api\/projects\/[^/?#]+\/captain$/

/** Whether GET /api/boot answers `path`, so a GET for it waits for that instead of going out alone. */
export const isBootPath = (path: string) => (BOOT_PATHS as readonly string[]).includes(path) || CAPTAIN_STATE.test(path)

export interface BootPayload {
  /** The stream position the responses were read at: they include every event up to it, and none after. */
  stream: StreamPosition
  /** Each path's response body, as its own GET would have answered then. */
  responses: Record<string, unknown>
}
