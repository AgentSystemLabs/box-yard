import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { validateTiers } from "../scripts/check-test-tiers.js"
import { testTier } from "../scripts/testTiers.js"

describe("test tier routing", () => {
  const all = ["test/new.test.ts", "test/runner.e2e.test.ts"]
  const fast = [all[0]!]
  const slow = [all[1]!]

  it("accepts a complete disjoint inventory with new tests in fast", () => {
    expect(() => validateTiers(all, fast, slow, slow)).not.toThrow()
  })

  it("rejects omissions, overlaps, stale entries, duplicates and wrong routing", () => {
    expect(() => validateTiers([...all, "test/missing.test.ts"], fast, slow, slow)).toThrow(/belongs to 0 tiers/)
    expect(() => validateTiers(all, all, slow, slow)).toThrow(/belongs to 2 tiers/)
    expect(() => validateTiers(all, fast, slow, [...slow, "test/deleted.test.ts"])).toThrow(/stale slow entry/)
    expect(() => validateTiers(all, [...fast, ...fast], slow, slow)).toThrow(/duplicate files/)
    expect(() => validateTiers(all, slow, fast, slow)).toThrow(/routing disagrees/)
    expect(() => validateTiers(all, [...fast, "test/extra.test.ts"], slow, slow)).toThrow(/absent from full/)
  })

  it("rejects typos instead of silently selecting the wrong tier", () => {
    expect(testTier("fast")).toBe("fast")
    expect(testTier("full")).toBe("full")
    expect(() => testTier("fasst")).toThrow(/Unknown BOXYARD_TEST_TIER/)
  })

  it("checks actual Vitest discovery against the shared inventory without running suites", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-test-tiers.ts"], { encoding: "utf8", timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/no stale entries, omissions or overlap/)
  })
})
