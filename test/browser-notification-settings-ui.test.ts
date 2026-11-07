// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserNotificationsRow, browserNotificationStatus } from "../web/src/components/BrowserNotificationSettings.js"
import { SettingsDraftContext, type DraftPart, type DraftRegistry } from "../web/src/lib/settingsDraft.js"

// Settings › Notifications › Browser notifications: a draft until Save (Cody's rule), and Save is where the browser
// asks for permission. The row says what the browser allows right now and what to do next.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeNotification {
  static permission: NotificationPermission = "default"
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission)
  static shown: string[] = []
  constructor(title: string) {
    FakeNotification.shown.push(title)
  }
}

let root: Root
let host: HTMLElement
let parts: Record<string, DraftPart>
const registry: DraftRegistry = {
  update: (id, part) => {
    if (part) parts[id] = part
    else delete parts[id]
  },
}

function render() {
  act(() => root.render(createElement(SettingsDraftContext.Provider, { value: registry }, createElement(BrowserNotificationsRow, { fid: (k: string) => `f-${k}` }))))
}
const text = () => host.textContent ?? ""
const checkbox = () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
const save = () => act(async () => void (await Promise.all(Object.values(parts).map((p) => p.save()))))

beforeEach(() => {
  localStorage.clear()
  parts = {}
  FakeNotification.permission = "default"
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockReset().mockImplementation(async () => FakeNotification.permission)
  vi.stubGlobal("Notification", FakeNotification)
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe("browser notifications in Settings", () => {
  it("turning on is a draft; Save asks the browser, then offers a test", async () => {
    render()
    expect(checkbox().checked).toBe(false)
    expect(text()).toContain("Turning this on and saving asks this browser for permission.")

    act(() => checkbox().click())
    expect(checkbox().checked).toBe(true)
    expect(text()).toContain("Save asks this browser for permission. Choose Allow.")
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(Object.keys(parts)).toEqual(["browser-notifications"])

    FakeNotification.requestPermission.mockImplementationOnce(async () => (FakeNotification.permission = "granted"))
    await save()
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("boxyard:browser-notifications")).toBe("1")
    expect(parts).toEqual({})
    expect(checkbox().checked).toBe(true)
    expect(text()).toContain("On in this browser.")

    await act(async () => button("Send a test")!.click())
    expect(FakeNotification.shown).toEqual(["Notifications are on"])
    expect(text()).toContain("Sent. If nothing showed up")
  })

  it("Discard leaves them off without asking", () => {
    render()
    act(() => checkbox().click())
    act(() => Object.values(parts).forEach((p) => p.discard()))
    expect(checkbox().checked).toBe(false)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  })

  it("a dismissed prompt says how to be asked again", async () => {
    render()
    act(() => checkbox().click())
    await save()
    expect(checkbox().checked).toBe(false)
    expect(text()).toContain("The browser didn't allow them. Turn on and Save to be asked again.")
    expect(localStorage.length).toBe(0)
  })

  it("a blocked site points at the site settings, and the row follows when it's unblocked", () => {
    FakeNotification.permission = "denied"
    render()
    expect(checkbox().disabled).toBe(true)
    expect(text()).toContain("Blocked by this browser. Allow notifications for this site")

    FakeNotification.permission = "granted"
    act(() => window.dispatchEvent(new Event("focus")))
    expect(checkbox().disabled).toBe(false)
    expect(text()).not.toContain("Blocked")
  })

  it("on, then blocked from the browser, shows off and says why", () => {
    localStorage.setItem("boxyard:browser-notifications", "1")
    FakeNotification.permission = "granted"
    render()
    expect(checkbox().checked).toBe(true)
    expect(button("Send a test")).toBeDefined()

    FakeNotification.permission = "denied"
    act(() => window.dispatchEvent(new Event("focus")))
    expect(checkbox().checked).toBe(false)
    expect(button("Send a test")).toBeUndefined()
    expect(text()).toContain("Blocked by this browser.")
  })
})

describe("what the row says", () => {
  const base = { support: "ok" as const, permission: "default" as const, on: false, saved: false, refused: false }
  it("says why a browser can't, and locks the switch", () => {
    expect(browserNotificationStatus({ ...base, support: "insecure" })).toMatchObject({ locked: true, text: expect.stringContaining("secure address (https or localhost)") })
    expect(browserNotificationStatus({ ...base, support: "ios-home-screen" })).toMatchObject({ locked: true, text: expect.stringContaining("add Box Yard to your Home Screen") })
    expect(browserNotificationStatus({ ...base, support: "unsupported" })).toMatchObject({ locked: true, text: "This browser doesn't support notifications." })
  })

  it("leaves a blocked switch that's on free to turn off", () => {
    expect(browserNotificationStatus({ ...base, permission: "denied" })?.locked).toBe(true)
    expect(browserNotificationStatus({ ...base, permission: "denied", on: true })?.locked).toBe(false)
  })

  it("says nothing when allowed and off", () => {
    expect(browserNotificationStatus({ ...base, permission: "granted" })).toBeNull()
    expect(browserNotificationStatus({ ...base, permission: "granted", on: true })?.text).toBe("This browser allows them. Save to turn them on.")
  })
})
