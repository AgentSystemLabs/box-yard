// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { AppNotification } from "../shared/types.js"
import {
  browserNotificationSupport,
  browserNotificationsOn,
  listenForNotificationClicks,
  lockScreenText,
  planBrowserNotification,
  setBrowserNotifications,
  showBrowserNotification,
  type BrowserNote,
} from "../web/src/lib/browserNotifications.js"
import { BATCH_MS, receiveNotification } from "../web/src/lib/notifications.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"

const note = (id: string, taskId: string | null, status: AppNotification["status"], o: Partial<AppNotification> = {}): AppNotification => ({
  id,
  taskId,
  projectId: "prj_1",
  title: `Task ${taskId}`,
  projectName: "site",
  status,
  summary: null,
  createdAt: 1,
  readAt: null,
  ...o,
})

// A browser with notifications: permission as given, an optional service worker, and every `new Notification`.
class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static shown: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this)
  }
}

interface FakeWorker {
  registration: { active: object | null; showNotification: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> } | undefined
  register: ReturnType<typeof vi.fn>
  listeners: ((e: MessageEvent) => void)[]
}
let worker: FakeWorker

function installBrowser({ permission = "default" as NotificationPermission, serviceWorker = true, secure = true } = {}) {
  FakeNotification.permission = permission
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal("Notification", FakeNotification)
  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true })
  worker = { registration: undefined, register: vi.fn(), listeners: [] }
  const registration = () => ({ active: { scriptURL: `${location.origin}/sw.js` }, showNotification: vi.fn(async () => {}), unregister: vi.fn(async () => true) })
  worker.register.mockImplementation(async () => (worker.registration ??= registration()))
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker
      ? {
          register: worker.register,
          getRegistration: async () => worker.registration,
          ready: new Promise(() => {}),
          addEventListener: (_: string, fn: (e: MessageEvent) => void) => worker.listeners.push(fn),
          removeEventListener: (_: string, fn: (e: MessageEvent) => void) => (worker.listeners = worker.listeners.filter((l) => l !== fn)),
        }
      : undefined,
  })
}

beforeEach(() => {
  localStorage.clear()
  installBrowser()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined })
})

describe("lock-screen text", () => {
  it("strips anything shaped like a key or token", () => {
    const cases = [
      "push failed: ghp_abcdefghijklmnopqrstuvwxyz0123",
      "key sk-ant-api03-abcdefghijklmnop in env",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "clone https://cody:hunter2hunter2@github.com/acme/site.git failed",
      'set password="hunter2" and API_KEY: s3cr3t-value',
      "AWS AKIAABCDEFGHIJKLMNOP leaked",
      "slack xoxb-123456789012-abcdefghij",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "token was 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "here: -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA -----END OPENSSH PRIVATE KEY----- done",
    ]
    const secrets = ["ghp_abc", "sk-ant-api03", "abcdefghijklmnopqrstuvwxyz", "hunter2", "s3cr3t", "AKIAABCD", "xoxb-1", "eyJhbGci", "9f86d08", "b3BlbnNz"]
    for (const [i, text] of cases.entries()) {
      const out = lockScreenText(text, 500)
      expect(out, text).toContain("[redacted")
      expect(out, text).not.toContain(secrets[i])
    }
  })

  it("keeps ordinary text, slugs and paths readable", () => {
    expect(lockScreenText("Which database should I use for 271-ux-6-opt-in-browser-notifications?")).toBe("Which database should I use for 271-ux-6-opt-in-browser-notifications?")
    expect(lockScreenText("tests fail in web/src/components/BrowserNotificationSettings.tsx")).toBe("tests fail in web/src/components/BrowserNotificationSettings.tsx")
    expect(lockScreenText("The author: Cody")).toBe("The author: Cody")
  })

  it("is one clipped line", () => {
    expect(lockScreenText("line one\n\n  line two")).toBe("line one line two")
    const long = lockScreenText("word ".repeat(100), 40)
    expect(long).toHaveLength(40)
    expect(long.endsWith("…")).toBe(true)
    expect(lockScreenText(null)).toBe("")
  })
})

describe("which notifications reach the system", () => {
  it("a task that needs input, opened a PR or failed", () => {
    expect(planBrowserNotification([note("n1", "task_a", "needs_input", { summary: "Postgres or SQLite?" })])).toEqual({
      title: "Task task_a",
      body: "Needs your input · site\nPostgres or SQLite?",
      href: "/?session=task_a",
      tag: "n1",
      taskId: "task_a",
    })
    expect(planBrowserNotification([note("n2", "task_b", "pr_ready")])?.body).toBe("Opened a PR · site")
    expect(planBrowserNotification([note("n3", "task_c", "failed", { summary: "exit 1 with token ghp_abcdefghijklmnopqrstuvwxyz0123" })])?.body).toBe("Failed · site\nexit 1 with token [redacted]")
    // A known failure in plain words, as its toast says it.
    expect(planBrowserNotification([note("n4", "task_d", "failed", { summary: "Stopped before it started." })])?.body).toBe("Failed · site\nStopped before it started")
  })

  it("never done, idle, box, read or already-settled ones", () => {
    expect(planBrowserNotification([note("n1", "a", "done"), note("n2", "b", "idle")])).toBeNull()
    expect(planBrowserNotification([note("n1", null, "failed", { boxId: "box_1" })])).toBeNull()
    expect(planBrowserNotification([note("n1", "a", "failed", { readAt: 5 })])).toBeNull()
    // The newest per task decides: a question that was answered and finished in the same burst stays quiet.
    expect(planBrowserNotification([note("n1", "a", "needs_input", { createdAt: 1 }), note("n2", "a", "done", { createdAt: 2 })])).toBeNull()
  })

  it("several tasks share one, most urgent first", () => {
    const plan = planBrowserNotification([
      note("n1", "a", "pr_ready", { createdAt: 1, title: "Fix login" }),
      note("n2", "b", "failed", { createdAt: 2, title: "Ship docs" }),
      note("n3", "c", "done", { createdAt: 3 }),
    ])
    expect(plan).toEqual({ title: "2 tasks need you", body: "1 failed · 1 PR ready\nShip docs, Fix login", href: "/", tag: "n1,n2", taskId: null })
  })
})

describe("showing one", () => {
  const sample: BrowserNote = { title: "Fix login", body: "Failed · site", href: "/?session=a", tag: "n1", taskId: "a" }
  const turnOn = () => {
    FakeNotification.permission = "granted"
    localStorage.setItem("boxyard:browser-notifications", "1")
  }

  it("nothing unless Cody turned them on and the browser allows them", async () => {
    expect(await showBrowserNotification(sample)).toBe(false)
    localStorage.setItem("boxyard:browser-notifications", "1")
    expect(browserNotificationsOn()).toBe(false)
    expect(await showBrowserNotification(sample)).toBe(false)
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it("through the service worker when there is one (phones need it)", async () => {
    turnOn()
    await navigator.serviceWorker.register("/sw.js")
    expect(await showBrowserNotification(sample)).toBe(true)
    expect(worker.registration!.showNotification).toHaveBeenCalledWith("Fix login", expect.objectContaining({ body: "Failed · site", tag: "n1", data: { href: "/?session=a", taskId: "a" } }))
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it("a worker's click comes back to the tab", () => {
    const clicks: unknown[] = []
    const stop = listenForNotificationClicks((c) => clicks.push(c))
    for (const l of worker.listeners) l(new MessageEvent("message", { data: { type: "notification-click", href: "/?session=a", taskId: "a" } }))
    for (const l of worker.listeners) l(new MessageEvent("message", { data: { type: "something-else" } }))
    expect(clicks).toEqual([{ href: "/?session=a", taskId: "a" }])
    stop()
    expect(worker.listeners).toHaveLength(0)
  })

  it("falls back to a page notification, whose click opens the task", async () => {
    turnOn()
    const clicks: unknown[] = []
    const stop = listenForNotificationClicks((c) => clicks.push(c))
    expect(await showBrowserNotification(sample)).toBe(true)
    const shown = FakeNotification.shown[0]!
    expect(shown.title).toBe("Fix login")
    shown.onclick?.()
    expect(clicks).toEqual([{ href: "/?session=a", taskId: "a" }])
    expect(shown.close).toHaveBeenCalled()
    stop()
  })
})

describe("turning them on and off", () => {
  it("asks for permission, then stores only the choice and installs the worker", async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = "granted"))
    expect(await setBrowserNotifications(true)).toBe(true)
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(worker.register).toHaveBeenCalledWith("/sw.js")
    expect({ ...localStorage }).toEqual({ "boxyard:browser-notifications": "1" })
    expect(browserNotificationsOn()).toBe(true)

    expect(await setBrowserNotifications(false)).toBe(false)
    expect(localStorage.length).toBe(0)
    await vi.waitFor(() => expect(worker.registration!.unregister).toHaveBeenCalled())
  })

  it("stays off when the browser says no, without asking again once blocked", async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = "denied"))
    expect(await setBrowserNotifications(true)).toBe(false)
    expect(await setBrowserNotifications(true)).toBe(false)
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(0)
    expect(worker.register).not.toHaveBeenCalled()
  })

  it("says why a browser can't", () => {
    expect(browserNotificationSupport()).toBe("ok")
    installBrowser({ secure: false })
    expect(browserNotificationSupport()).toBe("insecure")
    installBrowser()
    vi.stubGlobal("Notification", undefined)
    delete (window as { Notification?: unknown }).Notification
    expect(browserNotificationSupport()).toBe("unsupported")
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")
    expect(browserNotificationSupport()).toBe("ios-home-screen")
  })
})

describe("live: only while Box Yard is in the background", () => {
  let visibility: DocumentVisibilityState
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")))
    visibility = "hidden"
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
    FakeNotification.permission = "granted"
    localStorage.setItem("boxyard:browser-notifications", "1")
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined })
    for (const t of currentToasts()) dismiss(t.id)
  })

  const client = () => {
    const qc = new QueryClient()
    qc.setQueryData(keys.notifications, [])
    return qc
  }
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(BATCH_MS)
  }

  it("a hidden tab gets a system notification and a toast", async () => {
    receiveNotification(client(), note("n1", "a", "needs_input", { summary: "Which one?" }))
    await flush()
    expect(FakeNotification.shown.map((n) => [n.title, n.options.body])).toEqual([["Task a", "Needs your input · site\nWhich one?"]])
    expect(currentToasts()).toHaveLength(1)
  })

  it("a visible tab only toasts", async () => {
    visibility = "visible"
    receiveNotification(client(), note("n1", "a", "failed"))
    await flush()
    expect(FakeNotification.shown).toHaveLength(0)
    expect(currentToasts()).toHaveLength(1)
  })

  it("finished work stays in-app", async () => {
    receiveNotification(client(), note("n1", "a", "done"))
    await flush()
    expect(FakeNotification.shown).toHaveLength(0)
    expect(currentToasts()).toHaveLength(1)
  })
})
