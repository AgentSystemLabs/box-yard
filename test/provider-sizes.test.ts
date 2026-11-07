import { describe, expect, it } from "vitest"
import { DAYTONA_CPU, DAYTONA_GPU_GUIDE, DAYTONA_SIZES, DEFAULT_DAYTONA_SETTINGS, daytonaHourlyUsd, daytonaSizeOf, daytonaSizePatch, daytonaSizeUsd } from "../shared/daytona"
import { DEFAULT_DOCKER_SETTINGS, DOCKER_SIZES, dockerSizeOf } from "../shared/docker"

// Settings › Box providers' size cards: each provider's own sizes, read from and written to that provider's settings.

const daytona = (over: Partial<typeof DEFAULT_DAYTONA_SETTINGS> = {}) => ({ ...DEFAULT_DAYTONA_SETTINGS, ...over })

describe("Daytona sizes", () => {
  it("are CPU Small, Standard and Large, then one of each GPU in Daytona's guide", () => {
    const cpu = DAYTONA_SIZES.filter((z) => z.gpus === 0).map((z) => [z.label, z.vcpus, z.memoryGb, z.diskGb])
    expect(cpu).toEqual([
      ["CPU Small", 2, 4, 10],
      ["CPU Standard", 4, 8, 10],
      ["CPU Large", 8, 16, 30],
    ])
    const gpu = DAYTONA_SIZES.filter((z) => z.gpus > 0)
    expect(gpu.map((z) => z.gpuTypes[0])).toEqual(Object.keys(DAYTONA_GPU_GUIDE))
    expect(gpu.every((z) => z.gpus === 1 && z.vcpus === 8 && z.memoryGb === 32 && z.diskGb === 60)).toBe(true)
  })

  it("a CPU size writes the CPU-only fields and leaves the GPU sandbox's alone", () => {
    const small = DAYTONA_SIZES.find((z) => z.key === "cpu-small")!
    expect(daytonaSizePatch(small)).toEqual({ gpuTypes: [DAYTONA_CPU], cpuVcpus: 2, cpuMemoryGb: 4, cpuDiskGb: 10 })
    const after = daytona(daytonaSizePatch(small))
    expect(after.vcpus).toBe(DEFAULT_DAYTONA_SETTINGS.vcpus)
    expect(daytonaSizeOf(after)?.key).toBe("cpu-small")
  })

  it("a GPU size writes one GPU type and the GPU sandbox's numbers", () => {
    const h100 = DAYTONA_SIZES.find((z) => z.key === "gpu-H100")!
    expect(daytonaSizePatch(h100)).toEqual({ gpuTypes: ["H100"], gpus: 1, vcpus: 8, memoryGb: 32, diskGb: 60 })
    expect(daytonaSizeOf(daytona(daytonaSizePatch(h100)))?.key).toBe("gpu-H100")
  })

  it("anything else is Custom: two GPU types (the defaults), or numbers of one's own", () => {
    expect(daytonaSizeOf(DEFAULT_DAYTONA_SETTINGS)).toBeNull()
    expect(daytonaSizeOf(daytona({ gpuTypes: ["H100"], memoryGb: 64 }))).toBeNull()
    expect(daytonaSizeOf(daytona({ gpuTypes: [DAYTONA_CPU], cpuVcpus: 3 }))).toBeNull()
  })

  it("price each size by Daytona's list prices, with no GPU for CPU sizes", () => {
    const small = DAYTONA_SIZES.find((z) => z.key === "cpu-small")!
    const h100 = DAYTONA_SIZES.find((z) => z.key === "gpu-H100")!
    expect(daytonaSizeUsd(small, true)).toBe(daytonaHourlyUsd({ gpuTypes: [], gpus: 0, vcpus: 2, memoryGb: 4, diskGb: 10, spot: false }))
    expect(daytonaSizeUsd(h100, false)).toBeGreaterThan(DAYTONA_GPU_GUIDE.H100!.usd)
    expect(daytonaSizeUsd(h100, true)).toBeLessThan(daytonaSizeUsd(h100, false))
  })
})

describe("Docker sizes", () => {
  it("are Small, Medium and Large containers, and anything else is Custom", () => {
    expect(DOCKER_SIZES.map((z) => [z.key, z.cpus, z.memoryMb])).toEqual([
      ["small", 2, 4096],
      ["medium", 4, 8192],
      ["large", 8, 16_384],
    ])
    expect(dockerSizeOf({ cpus: 4, memoryMb: 8192 })?.key).toBe("medium")
    expect(dockerSizeOf({ cpus: 4, memoryMb: 6000 })).toBeNull()
    // The out-of-the-box container is one of them or Custom, never an error.
    expect(() => dockerSizeOf(DEFAULT_DOCKER_SETTINGS)).not.toThrow()
  })
})
