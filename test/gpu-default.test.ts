import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { findGpuChoice, gpuChoices, gpuPickLabel, gpuSlug, gpuTypesWords, sameGpu } from "../shared/gpuCatalog.js"
import { tmpDir } from "./helpers.js"

// Settings › Box providers › Default GPU cloud, and each cloud's own list of GPUs (shared/gpuCatalog.ts).

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const settingsOf = (store: Store) => new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" })

describe("Default GPU cloud", () => {
  it("is RunPod out of the box, and saves like any setting", () => {
    const settings = settingsOf(memStore())
    expect(settings.get().gpuProvider).toBe("runpod")
    expect(settings.update({ gpuProvider: "daytona" }).settings.gpuProvider).toBe("daytona")
    expect(() => settings.update({ gpuProvider: "lambda" })).toThrow()
  })

  it("takes over the old 'Use for GPU projects' checkboxes once (Daytona's won), and keeps a saved default", () => {
    const store = memStore()
    const settings = settingsOf(store)
    expect(settings.upgradeGpuDefault({ vast: true, daytona: true })).toBe("daytona")
    expect(settings.info()).toMatchObject({ settings: { gpuProvider: "daytona" }, sources: { gpuProvider: "ui" } })
    // Once: a later change stays.
    settings.update({ gpuProvider: "runpod" })
    expect(settings.upgradeGpuDefault({ vast: true, daytona: false })).toBeNull()
    expect(settings.get().gpuProvider).toBe("runpod")

    const vast = settingsOf(memStore())
    expect(vast.upgradeGpuDefault({ vast: true, daytona: false })).toBe("vast")
    expect(vast.get().gpuProvider).toBe("vast")

    const none = settingsOf(memStore())
    expect(none.upgradeGpuDefault({ vast: false, daytona: false })).toBeNull()
    expect(none.info().sources.gpuProvider).toBe("default")

    const saved = memStore()
    saved.setKv("settings", JSON.stringify({ gpuProvider: "runpod" }))
    expect(settingsOf(saved).upgradeGpuDefault({ vast: true, daytona: false })).toBeNull()
    expect(settingsOf(saved).get().gpuProvider).toBe("runpod")
  })
})

describe("each cloud's GPUs", () => {
  it("lists a cloud's own GPUs, its configured extras after, one per slug", () => {
    const runpod = gpuChoices("runpod")
    expect(runpod.map((g) => g.slug)).toContain("rtx-a5000")
    expect(runpod.find((g) => g.slug === "rtx-a5000")).toMatchObject({ id: "NVIDIA RTX A5000", label: "RTX A5000" })
    expect(runpod.some((g) => g.slug === "h100")).toBe(false)
    const daytona = gpuChoices("daytona")
    expect(daytona.map((g) => g.slug)).toEqual(["rtx-4090", "rtx-5090", "rtx-pro-6000", "h100", "h200", "b200", "b300", "mi355x", "cpu"])
    expect(daytona.at(-1)).toMatchObject({ id: "CPU", label: "CPU only" })
    expect(gpuChoices("vast").find((g) => g.slug === "rtx-4090")).toMatchObject({ id: "RTX 4090" })
    const extra = gpuChoices("runpod", ["NVIDIA H100 80GB HBM3", "NVIDIA RTX A5000"])
    expect(extra.at(-1)).toMatchObject({ id: "NVIDIA H100 80GB HBM3", slug: "h100-80gb-hbm3", hint: null })
    expect(extra.filter((g) => g.slug === "rtx-a5000")).toHaveLength(1)
  })

  it("finds a GPU by slug or by any cloud's spelling, and says picks in words", () => {
    expect(gpuSlug("NVIDIA GeForce RTX 3070")).toBe("rtx-3070")
    expect(findGpuChoice("daytona", "h100")?.id).toBe("H100")
    expect(findGpuChoice("daytona", "RTX 4090")?.id).toBe("RTX-4090")
    expect(findGpuChoice("vast", "NVIDIA RTX A5000")?.id).toBe("RTX A5000")
    expect(findGpuChoice("runpod", "h100")).toBeNull()
    expect(sameGpu("NVIDIA RTX A5000", "RTX A5000")).toBe(true)
    expect(sameGpu("RTX-4090", "RTX 4090")).toBe(true)
    expect(sameGpu("RTX 4090", "RTX 5090")).toBe(false)
    expect(gpuTypesWords("runpod", ["NVIDIA RTX A5000", "NVIDIA A40"])).toBe("RTX A5000 or A40")
    expect(gpuTypesWords("daytona", ["CPU"])).toBe("CPU only")
    expect(gpuPickLabel("daytona", "H100")).toBe("Daytona H100")
    expect(gpuPickLabel("vast", null)).toBe("Vast.ai GPU")
  })
})
