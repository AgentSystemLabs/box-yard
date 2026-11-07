import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { CODEX_MODELS } from "../shared/agentCli.js"
import { tmpDir } from "./helpers.js"

describe("Codex task defaults", () => {
  it("reads unset defaults without persisting them, and survives a new SettingsStore", () => {
    const db = openDb(tmpDir(), ":memory:")
    try {
      const store = new Store(db)
      const settings = new SettingsStore(store, {})
      expect(settings.info()).toMatchObject({
        settings: { agentCodexModel: "gpt-6.1-sol", agentCodexEffort: "xhigh", agentEffort: "high" },
        sources: { agentCodexModel: "default", agentCodexEffort: "default" },
      })
      expect(store.getKv("settings")).toBeNull()
      settings.update({ agentCli: "codex", agentCodexModel: "gpt-6-luna", agentCodexEffort: "medium" })
      expect(new SettingsStore(store, {}).info()).toMatchObject({
        settings: { agentCli: "codex", agentCodexModel: "gpt-6-luna", agentCodexEffort: "medium" },
        sources: { agentCodexModel: "ui", agentCodexEffort: "ui" },
      })
    } finally { db.close() }
  })

  it.each(["low", "max", "orchestrator"] as const)("preserves legacy explicit %s effort without rewriting it", (effort) => {
    const db = openDb(tmpDir(), ":memory:")
    try {
      const store = new Store(db)
      const raw = JSON.stringify({ agentEffort: effort, agentCodexModel: "" })
      store.setKv("settings", raw)
      const settings = new SettingsStore(store, {})
      expect(settings.info()).toMatchObject({ settings: { agentCodexModel: "", agentCodexEffort: effort }, sources: { agentCodexEffort: "ui" } })
      expect(store.getKv("settings")).toBe(raw)
      settings.update({ agentEffort: "high" })
      expect(settings.get().agentCodexEffort).toBe(effort)
      settings.update({ agentCodexEffort: "xhigh" })
      settings.update({ agentEffort: "medium" })
      expect(new SettingsStore(store, {}).get().agentCodexEffort).toBe("xhigh")
    } finally { db.close() }
  })

  it("retains explicit custom names, rejects malformed writes, and persists every discovered effort", () => {
    const db = openDb(tmpDir(), ":memory:")
    try {
      const settings = new SettingsStore(new Store(db), {})
      settings.update({ agentCodexModel: "org/gateway-model" })
      for (const model of CODEX_MODELS) for (const effort of model.efforts) {
        expect(settings.update({ agentCodexEffort: effort }).settings.agentCodexEffort).toBe(effort)
      }
      for (const patch of [{ agentCodexModel: "opus" }, { agentCodexModel: "has spaces" }, { agentCodexEffort: "turbo" }]) {
        expect(() => settings.update(patch)).toThrow()
        expect(settings.get().agentCodexModel).toBe("org/gateway-model")
      }
    } finally { db.close() }
  })

  it("keeps new Claude effort edits independent from unset Codex defaults", () => {
    const db = openDb(tmpDir(), ":memory:")
    try {
      const settings = new SettingsStore(new Store(db), {})
      expect(settings.update({ agentEffort: "low" }).settings.agentCodexEffort).toBe("xhigh")
    } finally { db.close() }
  })
})
