import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { tmpDir } from "./helpers.js"

// A setting a former build saved and this one dropped is ignored: never an error, a warning or a lost neighbour.

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const settingsOf = (store: Store) => new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" })

afterEach(() => vi.restoreAllMocks())

describe("retired settings", () => {
  it("a saved startInZen is dropped quietly, and the values beside it still apply", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const store = memStore()
    store.setKv("settings", JSON.stringify({ startInZen: false, ownerName: "Sam", showCloudMeter: true }))
    const settings = settingsOf(store)
    expect(settings.get()).toMatchObject({ ownerName: "Sam", showCloudMeter: true })
    expect(settings.get()).not.toHaveProperty("startInZen")
    expect(settings.info().sources).toMatchObject({ ownerName: "ui", showCloudMeter: "ui" })
    expect(warn).not.toHaveBeenCalled()
    // The next save leaves it out of the stored settings.
    settings.update({ cardsIdleHours: 4 })
    expect(JSON.parse(store.getKv("settings")!)).toEqual({ ownerName: "Sam", showCloudMeter: true, cardsIdleHours: 4 })
  })

  it("a patch that still carries it (a tab from before) saves the rest", () => {
    const store = memStore()
    const settings = settingsOf(store)
    expect(() => settings.update({ startInZen: true, ownerName: "Sam" })).not.toThrow()
    expect(settings.get().ownerName).toBe("Sam")
    expect(JSON.parse(store.getKv("settings")!)).toEqual({ ownerName: "Sam" })
  })
})
