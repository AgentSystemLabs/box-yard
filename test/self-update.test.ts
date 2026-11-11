// The Update button: the server's end (server/selfUpdate.ts), which relays clicks to the npx launcher and holds the
// restart until no reply is running, and what the banner says at each step (web/src/lib/selfUpdate.ts).
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { launcherChannel, QUIET_MAX_WAIT_MS, SelfUpdate, STATUS_MESSAGE, UPDATE_MESSAGE, UpdateNotManagedError } from "../server/selfUpdate.js"
import { UNMANAGED_UPDATE, updateAvailable, type UpdateStatus } from "../shared/selfUpdate.js"
import { NOTHING_SEEN, trackUpdate, updateBanner, updateSummary, waitingText, type UpdateSeen } from "../web/src/lib/selfUpdate.js"

const A = "a".repeat(40)
const B = "b".repeat(40)

class FakeChannel extends EventEmitter {
  connected = true
  sent: unknown[] = []
  send(msg: unknown) {
    this.sent.push(msg)
    return true
  }
  actions() {
    return this.sent.map((m) => (m as { action: string }).action)
  }
  /** The launcher says where things are. */
  status(patch: Partial<UpdateStatus>) {
    this.emit("message", { type: STATUS_MESSAGE, status: { ...launcher(), ...patch } })
  }
}

/** What the launcher sends: everything but `managed` and `waitingFor`. */
const launcher = (): Omit<UpdateStatus, "managed" | "waitingFor"> => {
  const { managed: _m, waitingFor: _w, ...rest } = UNMANAGED_UPDATE
  return { ...rest, current: A }
}

function selfUpdate(busy: () => string[] = () => [], over: { maxWaitMs?: number; now?: () => number } = {}) {
  const channel = new FakeChannel()
  const broadcasts: UpdateStatus[] = []
  const su = new SelfUpdate({ channel, busy, broadcast: (s) => broadcasts.push(s), pollMs: 1_000, ...over })
  return { su, channel, broadcasts }
}

describe("SelfUpdate", () => {
  it("isn't managed outside the launcher: no channel, and the actions say how to update a checkout", () => {
    const su = new SelfUpdate({ channel: null, busy: () => [], broadcast: () => {} })
    expect(su.status()).toEqual(UNMANAGED_UPDATE)
    expect(() => su.start()).toThrow(UpdateNotManagedError)
    expect(() => su.check()).toThrow(/git pull, then \.\/yard local/)
    try {
      su.restartNow()
    } catch (err) {
      expect((err as UpdateNotManagedError).status).toBe(409)
    }
  })

  it("asks the launcher for its status, then relays Check and Update", () => {
    const { su, channel } = selfUpdate()
    expect(channel.actions()).toEqual(["hello"])
    su.check()
    su.start()
    expect(channel.sent.at(-1)).toEqual({ type: UPDATE_MESSAGE, action: "start" })
    expect(channel.actions()).toEqual(["hello", "check", "start"])
  })

  it("shows the launcher's status and broadcasts each change", () => {
    const { su, channel, broadcasts } = selfUpdate()
    channel.status({ latest: B, checkedAt: 5 })
    expect(su.status()).toMatchObject({ managed: true, current: A, latest: B, phase: "idle", waitingFor: [] })
    expect(broadcasts.at(-1)).toEqual(su.status())
    // Anything else on the channel is someone else's.
    channel.emit("message", { type: "other", status: { phase: "ready" } })
    channel.emit("message", "hi")
    expect(broadcasts).toHaveLength(1)
  })

  it("doesn't send to a launcher that's gone", () => {
    const { su, channel } = selfUpdate()
    channel.connected = false
    su.start()
    expect(channel.actions()).toEqual(["hello"])
  })

  it("restarts into a built update at once when nothing is mid-reply", () => {
    const { channel } = selfUpdate()
    channel.status({ phase: "ready", ready: B })
    expect(channel.actions()).toEqual(["hello", "apply"])
  })

  it("waits for replies to finish, saying what it waits for, then restarts once", () => {
    vi.useFakeTimers()
    try {
      let busy = ["the Coordinator", "a Captain"]
      const { su, channel, broadcasts } = selfUpdate(() => busy)
      channel.status({ phase: "ready", ready: B })
      expect(channel.actions()).toEqual(["hello"])
      expect(su.status().waitingFor).toEqual(["the Coordinator", "a Captain"])
      expect(broadcasts.at(-1)!.waitingFor).toEqual(["the Coordinator", "a Captain"])
      busy = ["a Captain"]
      vi.advanceTimersByTime(1_000)
      expect(broadcasts.at(-1)!.waitingFor).toEqual(["a Captain"])
      const count = broadcasts.length
      vi.advanceTimersByTime(3_000)
      // Nothing changed, nothing new to say.
      expect(broadcasts).toHaveLength(count)
      busy = []
      vi.advanceTimersByTime(1_000)
      expect(channel.actions()).toEqual(["hello", "apply"])
      // The same build again (a repeated status) doesn't apply twice.
      channel.status({ phase: "ready", ready: B })
      vi.advanceTimersByTime(5_000)
      expect(channel.actions()).toEqual(["hello", "apply"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("restarts anyway after waiting the longest it may", () => {
    vi.useFakeTimers()
    try {
      const { channel } = selfUpdate(() => ["the Coordinator"], { now: () => Date.now() })
      channel.status({ phase: "ready", ready: B })
      vi.advanceTimersByTime(QUIET_MAX_WAIT_MS - 1_000)
      expect(channel.actions()).toEqual(["hello"])
      vi.advanceTimersByTime(1_000)
      expect(channel.actions()).toEqual(["hello", "apply"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("restarts now on request, but only with a built update", () => {
    vi.useFakeTimers()
    try {
      const { su, channel } = selfUpdate(() => ["the Coordinator"])
      su.restartNow()
      expect(channel.actions()).toEqual(["hello"])
      channel.status({ phase: "ready", ready: B })
      su.restartNow()
      expect(channel.actions()).toEqual(["hello", "apply"])
      expect(su.status().waitingFor).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("can apply the same build again after it failed and was built again", () => {
    const { channel } = selfUpdate()
    channel.status({ phase: "ready", ready: B })
    channel.status({ phase: "restarting", ready: B })
    channel.status({ phase: "failed", ready: null, error: "didn't start" })
    channel.status({ phase: "ready", ready: B })
    expect(channel.actions()).toEqual(["hello", "apply", "apply"])
  })

  it("stops waiting when the update is no longer ready", () => {
    vi.useFakeTimers()
    try {
      let busy = ["a side thread"]
      const { su, channel } = selfUpdate(() => busy)
      channel.status({ phase: "ready", ready: B })
      channel.status({ phase: "failed", ready: null })
      busy = []
      vi.advanceTimersByTime(5_000)
      expect(channel.actions()).toEqual(["hello"])
      expect(su.status().waitingFor).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses this process's channel only when the launcher started it", () => {
    const proc = { send: () => true } as unknown as NodeJS.Process
    expect(launcherChannel({ BOXYARD_LAUNCHER: "1" }, proc)).toBe(proc)
    expect(launcherChannel({}, proc)).toBeNull()
    expect(launcherChannel({ BOXYARD_LAUNCHER: "1" }, {} as NodeJS.Process)).toBeNull()
  })
})

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...UNMANAGED_UPDATE, managed: true, current: A, latest: A, checkedAt: 1, repoPage: "https://github.com/acme/yard", ...patch })
const none: ReadonlySet<string> = new Set()

describe("the Update banner", () => {
  it("says nothing outside the launcher, or when up to date", () => {
    expect(updateBanner(undefined, NOTHING_SEEN, none)).toBeNull()
    expect(updateBanner(UNMANAGED_UPDATE, NOTHING_SEEN, none)).toBeNull()
    expect(updateBanner(status(), NOTHING_SEEN, none)).toBeNull()
    expect(updateBanner(status({ latest: null }), NOTHING_SEEN, none)).toBeNull()
  })

  it("offers Update for a newer main, with the commits to compare, until Later", () => {
    const b = updateBanner(status({ latest: B }), NOTHING_SEEN, none)
    expect(b).toMatchObject({ tone: "info", text: "A newer Box Yard is out: aaaaaaa → bbbbbbb.", actions: ["update", "later"], compare: { from: A, to: B } })
    expect(updateAvailable(status({ latest: B }))).toBe(true)
    expect(updateBanner(status({ latest: B }), NOTHING_SEEN, new Set([b!.key]))).toBeNull()
    // A newer commit still is news again.
    expect(updateBanner(status({ latest: "c".repeat(40) }), NOTHING_SEEN, new Set([b!.key]))).not.toBeNull()
  })

  it("shows each install step without buttons", () => {
    expect(updateBanner(status({ latest: B, phase: "download" }), NOTHING_SEEN, none)).toMatchObject({
      tone: "progress",
      text: "Updating Box Yard in the background, step 1 of 4: downloading the newest version. You can keep working.",
      actions: [],
    })
    expect(updateBanner(status({ latest: B, phase: "build" }), NOTHING_SEEN, none)!.text).toMatch(/step 3 of 4: building it/)
  })

  it("says what the restart waits for, with Restart now", () => {
    expect(updateBanner(status({ phase: "ready", ready: B, waitingFor: ["the Coordinator"] }), NOTHING_SEEN, none)).toMatchObject({
      text: "Box Yard bbbbbbb is ready. It restarts once the Coordinator finishes its reply, so nothing is cut off.",
      actions: ["restart"],
    })
    expect(updateBanner(status({ phase: "ready", ready: B }), NOTHING_SEEN, none)).toMatchObject({ text: "Box Yard bbbbbbb is ready. Restarting into it…", actions: [] })
    expect(updateBanner(status({ phase: "restarting", ready: B }), NOTHING_SEEN, none)!.text).toBe("Restarting Box Yard into bbbbbbb… This page reconnects by itself.")
    expect(waitingText(["the Coordinator", "a Captain", "a side thread"])).toBe("the Coordinator, a Captain and a side thread finish their replies")
  })

  it("offers Refresh once the server is back on the new version", () => {
    let seen: UpdateSeen = NOTHING_SEEN
    for (const s of [status({ latest: B }), status({ latest: B, phase: "build" }), status({ latest: B, phase: "ready", ready: B }), status({ latest: B, phase: "restarting", ready: B })]) seen = trackUpdate(seen, s)
    expect(seen).toEqual({ expecting: B, updatedTo: null })
    // The page reconnects to the new server.
    const after = status({ current: B, latest: B, last: { from: A, to: B, ok: true, at: 9 } })
    seen = trackUpdate(seen, after)
    expect(seen).toEqual({ expecting: null, updatedTo: B })
    const b = updateBanner(after, seen, none)
    expect(b).toMatchObject({ tone: "done", text: "Box Yard updated to bbbbbbb. Refresh to load the new version.", actions: ["refresh", "dismiss"] })
    expect(updateBanner(after, seen, new Set([b!.key]))).toBeNull()
    // A page opened after the update has nothing to refresh.
    expect(updateBanner(after, NOTHING_SEEN, none)).toBeNull()
  })

  it("explains a failed update, with its output and Try again", () => {
    const failed = status({ latest: B, phase: "failed", error: "Box Yard bbbbbbb didn't start, so it went back to aaaaaaa.", detail: "Error: Cannot find module", failed: [B], last: { from: A, to: B, ok: false, at: 9 } })
    const seen = trackUpdate({ expecting: B, updatedTo: null }, failed)
    expect(seen.expecting).toBeNull()
    expect(updateBanner(failed, seen, none)).toMatchObject({ tone: "error", text: failed.error, detail: "Error: Cannot find module", actions: ["retry", "dismiss"] })
    // Later (after a launcher restart) the failed commit is still flagged.
    expect(updateBanner(status({ latest: B, failed: [B] }), NOTHING_SEEN, none)).toMatchObject({ text: "Box Yard bbbbbbb didn't start last time, so this is still aaaaaaa.", actions: ["retry", "later"] })
  })

  it("sums up the state for Settings › About", () => {
    expect(updateSummary(undefined, 0)).toBe("…")
    expect(updateSummary(UNMANAGED_UPDATE, 0)).toMatch(/git pull, then \.\/yard local/)
    expect(updateSummary(status({ checkedAt: 0 }), 5 * 60_000)).toBe("Up to date (checked 5 min ago).")
    expect(updateSummary(status({ checkedAt: null }), 0)).toBe("Not checked yet.")
    expect(updateSummary(status({ latest: B }), 0)).toBe("A newer version is out: bbbbbbb.")
    expect(updateSummary(status({ checking: true }), 0)).toBe("Looking for a newer version…")
    expect(updateSummary(status({ checkError: "Couldn't reach GitHub to look for updates." }), 0)).toBe("Couldn't reach GitHub to look for updates.")
    expect(updateSummary(status({ phase: "dependencies" }), 0)).toBe("Updating: installing its dependencies…")
  })
})
