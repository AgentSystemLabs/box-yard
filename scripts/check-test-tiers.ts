import path from "node:path"
import { fileURLToPath } from "node:url"
import { SLOW_TESTS, type TestTier } from "./testTiers.js"

/** Compare actual Vitest discovery for all three configurations, not just a partition of our list. */
export function validateTiers(all: string[], fast: string[], slow: string[], listed = Object.keys(SLOW_TESTS)): void {
  const errors: string[] = []
  for (const [name, files] of Object.entries({ full: all, fast, slow, listed })) {
    if (!files.length) errors.push(`${name}: empty inventory`)
    if (new Set(files).size !== files.length) errors.push(`${name}: duplicate files`)
  }
  const fullSet = new Set(all)
  const fastSet = new Set(fast)
  const slowSet = new Set(slow)
  const listedSet = new Set(listed)
  for (const file of all) {
    const count = Number(fastSet.has(file)) + Number(slowSet.has(file))
    if (count !== 1) errors.push(`${file}: belongs to ${count} tiers (expected exactly one)`)
    if (slowSet.has(file) !== listedSet.has(file)) errors.push(`${file}: slow routing disagrees with inventory`)
  }
  for (const file of [...fast, ...slow]) if (!fullSet.has(file)) errors.push(`${file}: tier discovers a file absent from full`)
  for (const file of listed) if (!fullSet.has(file)) errors.push(`${file}: stale slow entry`)
  if (errors.length) throw new Error(errors.join("\n"))
}

export async function discoverTier(tier: TestTier): Promise<string[]> {
  const previous = process.env.BOXYARD_TEST_TIER
  process.env.BOXYARD_TEST_TIER = tier
  const { createVitest } = await import("vitest/node")
  try {
    const vitest = await createVitest({ watch: false })
    try {
      return (await vitest.globTestSpecifications()).map((spec) => path.relative(vitest.config.root, spec.moduleId).split(path.sep).join("/")).sort()
    } finally {
      await vitest.close()
    }
  } finally {
    if (previous === undefined) delete process.env.BOXYARD_TEST_TIER
    else process.env.BOXYARD_TEST_TIER = previous
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Sequential: each config reads the tier from the process environment.
    const all = await discoverTier("full")
    const fast = await discoverTier("fast")
    const slow = await discoverTier("slow")
    validateTiers(all, fast, slow)
    console.log(`Test tiers: ${all.length} full = ${fast.length} fast + ${slow.length} slow; no stale entries, omissions or overlap.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
