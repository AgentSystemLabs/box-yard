// Opt-in system notifications for what needs Cody: a task that needs input, opened a PR or failed, sent only
// while Box Yard is in the background (lib/notifications.ts decides when). They go through a small service worker
// (public/sw.js) when one can run, which phones require, and fall back to `new Notification` elsewhere. The text can
// show on a lock screen, so it's clipped and stripped of anything shaped like a key or token. Only the on/off choice
// is stored in this browser, never what a notification said.
import { redactSecretShapes } from "../../../shared/secretShapes"
import type { AppNotification, NotifyStatus } from "../../../shared/types"
import { failureSummary } from "./failure"
import { taskSessionHref, APP_HOME } from "./navigation"

const BROWSER_KEY = "boxyard:browser-notifications"
const WORKER_URL = "/sw.js"
const ICON = "/icons/box-yard-192.png"

/** The task notifications worth a system notification. Done and idle stay in-app (toast, Recent). */
export const BROWSER_NOTIFY_STATUSES = ["needs_input", "pr_ready", "failed"] as const satisfies readonly NotifyStatus[]
type BrowserStatus = (typeof BROWSER_NOTIFY_STATUSES)[number]
const isBrowserStatus = (s: NotifyStatus): s is BrowserStatus => (BROWSER_NOTIFY_STATUSES as readonly NotifyStatus[]).includes(s)

/** Most urgent first. */
const URGENCY: BrowserStatus[] = ["failed", "needs_input", "pr_ready"]
const PHRASE: Record<BrowserStatus, string> = { needs_input: "Needs your input", pr_ready: "Opened a PR", failed: "Failed" }
const COUNT_LABEL: Record<BrowserStatus, string> = { needs_input: "need you", pr_ready: "PR ready", failed: "failed" }

/** What a system notification shows and where a click goes. */
export interface BrowserNote {
  title: string
  body: string
  href: string
  /** Same notification, same tag: a second tab or a repeat replaces it instead of stacking. */
  tag: string
  taskId: string | null
}

// ------------------------------------------------------------------ text

// On top of the key shapes the server redacts (shared/secretShapes.ts): what else a lock screen shouldn't show.
const LOCK_SCREEN_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[redacted private key]"],
  // user:password@ in a URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  // password=…, api_key: "…"
  [/\b((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key|token)["']?\s*[:=]\s*)["']?[^\s"',;]+/gi, "$1[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  // Any other long run of letters and digits, like an unlabeled key (hyphenated slugs and dotted paths break it up).
  [/(?=[A-Za-z0-9_+/=]*\d)(?=[A-Za-z0-9_+/=]*[A-Za-z])[A-Za-z0-9_+/=]{32,}/g, "[redacted]"],
]

/** One line, at most `max` characters, with anything that looks like a secret replaced by "[redacted]". */
export function lockScreenText(text: string | null | undefined, max = 140): string {
  if (!text) return ""
  let out = redactSecretShapes(text)
  for (const [pattern, to] of LOCK_SCREEN_PATTERNS) out = out.replace(pattern, to)
  out = out.replace(/\s+/g, " ").trim()
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out
}

/**
 * The system notification for a burst of task notifications, or null when none is worth one: the newest per task,
 * kept only if it needs input, opened a PR or failed. Several tasks share one "N tasks need you" notification.
 */
export function planBrowserNotification(burst: readonly AppNotification[]): BrowserNote | null {
  const latest = new Map<string, AppNotification>()
  for (const n of burst) {
    if (!n.taskId) continue
    const prev = latest.get(n.taskId)
    if (!prev || n.createdAt >= prev.createdAt) latest.set(n.taskId, n)
  }
  const items = [...latest.values()]
    .filter((n): n is AppNotification & { status: BrowserStatus; taskId: string } => !n.readAt && isBrowserStatus(n.status))
    .sort((a, b) => b.createdAt - a.createdAt)
  if (!items.length) return null
  if (items.length === 1) {
    const n = items[0]!
    const project = lockScreenText(n.projectName, 40)
    // A failure in plain words, like its toast ("Claude's usage limit is used up · resets 3:17 PM").
    const line = n.status === "failed" && n.summary ? failureSummary(n.summary) : n.summary
    return {
      title: lockScreenText(n.title, 80) || "A task",
      body: [project ? `${PHRASE[n.status]} · ${project}` : PHRASE[n.status], lockScreenText(line)].filter(Boolean).join("\n"),
      href: taskSessionHref(n.taskId),
      tag: n.id,
      taskId: n.taskId,
    }
  }
  const breakdown = URGENCY.map((s) => [s, items.filter((n) => n.status === s).length] as const)
    .filter(([, k]) => k > 0)
    .map(([s, k]) => `${k} ${COUNT_LABEL[s]}`)
    .join(" · ")
  return {
    title: `${items.length} tasks need you`,
    body: [breakdown, lockScreenText(items.map((n) => n.title).join(", "))].join("\n"),
    href: APP_HOME,
    tag: items.map((n) => n.id).sort().join(","),
    taskId: null,
  }
}

// ------------------------------------------------------------------ support and permission

/** Why this browser can or can't show notifications. */
export type BrowserSupport = "ok" | "insecure" | "ios-home-screen" | "unsupported"

function iosBrowserTab() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true
  return ios && !standalone
}

export function browserNotificationSupport(): BrowserSupport {
  if (typeof window === "undefined") return "unsupported"
  // Browsers only allow notifications on https or localhost, e.g. not on a plain-http network address.
  if (window.isSecureContext === false) return "insecure"
  if ("Notification" in window) return "ok"
  // iPhone and iPad only offer them to a site added to the Home Screen.
  return iosBrowserTab() ? "ios-home-screen" : "unsupported"
}

export type PermissionState = NotificationPermission | "unsupported"

export const notificationPermission = (): PermissionState => (browserNotificationSupport() === "ok" ? Notification.permission : "unsupported")

/** Calls `cb` when the permission may have changed: the browser says so, or Cody comes back from its site settings. */
export function subscribePermission(cb: () => void): () => void {
  let status: PermissionStatus | null = null
  let gone = false
  window.addEventListener("focus", cb)
  document.addEventListener("visibilitychange", cb)
  navigator.permissions
    ?.query({ name: "notifications" })
    .then((s) => {
      if (gone) return
      status = s
      s.addEventListener("change", cb)
    })
    .catch(() => {})
  return () => {
    gone = true
    window.removeEventListener("focus", cb)
    document.removeEventListener("visibilitychange", cb)
    status?.removeEventListener("change", cb)
  }
}

export function browserNotificationsOn() {
  return notificationPermission() === "granted" && localStorage.getItem(BROWSER_KEY) === "1"
}

/**
 * Turn browser notifications on or off. On asks for permission first, so call it straight from a click (the Settings
 * dialog's Save). Returns whether they are on.
 */
export async function setBrowserNotifications(on: boolean): Promise<boolean> {
  if (!on || browserNotificationSupport() !== "ok") {
    localStorage.removeItem(BROWSER_KEY)
    void unregisterNotificationWorker()
    return false
  }
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
  if (permission !== "granted") return false
  localStorage.setItem(BROWSER_KEY, "1")
  await registerNotificationWorker()
  return true
}

// ------------------------------------------------------------------ the service worker

/** Install sw.js, which shows notifications and opens Box Yard from one. Only once Cody turned them on. */
export async function registerNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!navigator.serviceWorker || !window.isSecureContext) return null
  return navigator.serviceWorker.register(WORKER_URL).catch(() => null)
}

/** Turning notifications off removes the worker again, so nothing stays installed. */
async function unregisterNotificationWorker() {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  const script = reg?.active ?? reg?.waiting ?? reg?.installing
  if (reg && script && new URL(script.scriptURL).pathname === WORKER_URL) await reg.unregister().catch(() => false)
}

/** The worker, once it's running; null where there's none (the caller falls back to `new Notification`). */
async function activeWorker(): Promise<ServiceWorkerRegistration | null> {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  if (!reg) return null
  if (reg.active) return reg
  // Just registered (a test right after Save): wait a moment for it to start.
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((done) => setTimeout(() => done(null), 3000))])
}

// ------------------------------------------------------------------ showing and clicking

export interface NotificationClick {
  href: string
  taskId: string | null
}

const clickListeners = new Set<(click: NotificationClick) => void>()

/**
 * Calls `onClick` when Cody clicks one of these notifications, from the service worker (which already focused the
 * tab) or from a `new Notification`.
 */
export function listenForNotificationClicks(onClick: (click: NotificationClick) => void): () => void {
  const fromWorker = (e: MessageEvent) => {
    const data = e.data as { type?: string; href?: unknown; taskId?: unknown } | null
    if (data?.type !== "notification-click" || typeof data.href !== "string") return
    onClick({ href: data.href, taskId: typeof data.taskId === "string" ? data.taskId : null })
  }
  clickListeners.add(onClick)
  navigator.serviceWorker?.addEventListener("message", fromWorker)
  return () => {
    clickListeners.delete(onClick)
    navigator.serviceWorker?.removeEventListener("message", fromWorker)
  }
}

/** Show `note` if browser notifications are on. Resolves to whether it was shown. */
export async function showBrowserNotification(note: BrowserNote): Promise<boolean> {
  if (!browserNotificationsOn()) return false
  const click: NotificationClick = { href: note.href, taskId: note.taskId }
  const options: NotificationOptions = { body: note.body, tag: note.tag, icon: ICON, data: click }
  try {
    const worker = await activeWorker()
    if (worker) {
      await worker.showNotification(note.title, options)
      return true
    }
    const shown = new Notification(note.title, options)
    shown.onclick = () => {
      window.focus()
      for (const listener of clickListeners) listener(click)
      shown.close()
    }
    return true
  } catch {
    // Toasts and the Recent list still have it.
    return false
  }
}

/** A sample, from Settings, so Cody sees what one looks like and that the browser lets them through. */
export const sendTestNotification = () =>
  showBrowserNotification({
    title: "Notifications are on",
    body: "You'll get one like this when a task needs your input, opens a PR or fails while Box Yard is in the background.",
    href: APP_HOME,
    tag: "test",
    taskId: null,
  })
