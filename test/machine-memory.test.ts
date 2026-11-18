import { describe, expect, it } from "vitest"
import { MachineStats, MEMORY_CACHE_MS, type MachineReaders } from "../server/machineStats.js"

// MachineStats.memory: this computer's memory for the memory guard on new local turns (TaskManager.localMemoryWait).

const GB = 1024 ** 3

describe("MachineStats.memory", () => {
  const readers = (free: () => number): MachineReaders & { reads: number } => {
    const r = { platform: "freebsd" as NodeJS.Platform, totalmem: () => (r.reads++, 16 * GB), freemem: free, loadavg: () => [1, 1, 1], cpuCount: () => 8, run: async () => null, readFile: () => null, reads: 0 }
    return r
  }

  it("reads at most every few seconds, and takes a fresh background sample instead", async () => {
    let now = 1_000_000
    let free = 6 * GB
    const r = readers(() => free)
    const stats = new MachineStats(r, { now: () => now })
    const [a, b] = await Promise.all([stats.memory(), stats.memory()])
    expect(a).toEqual({ totalBytes: 16 * GB, usedBytes: 10 * GB })
    expect(b).toEqual(a)
    expect(r.reads).toBe(1)
    free = 2 * GB
    now += MEMORY_CACHE_MS - 1
    expect(await stats.memory()).toEqual({ totalBytes: 16 * GB, usedBytes: 10 * GB })
    now += 1
    expect(await stats.memory()).toEqual({ totalBytes: 16 * GB, usedBytes: 14 * GB })
    expect(r.reads).toBe(2)
    // The minute's background sample is newer: it's the reading.
    now += 1000
    free = 8 * GB
    await stats.tick()
    expect(await stats.memory()).toEqual({ totalBytes: 16 * GB, usedBytes: 8 * GB })
    expect(r.reads).toBe(3)
  })

  it("is null when the memory can't be read", async () => {
    const stats = new MachineStats({ ...readers(() => 0), totalmem: () => 0 })
    expect(await stats.memory()).toBeNull()
  })
})
