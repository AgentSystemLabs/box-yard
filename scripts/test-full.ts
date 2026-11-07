import { fileURLToPath } from "node:url"
import { runLocked } from "./testLock.js"

// Full and both tiers share the existing lock and signal/exit-code handling.
// Consume only our leading tier option; every other argument belongs to Vitest.
const args = process.argv.slice(2)
const tier = args[0] === "--tier" ? args.splice(0, 2)[1] : "full"
if (tier !== "full" && tier !== "fast" && tier !== "slow") throw new Error(`Unknown test tier: ${tier}`)
process.env.BOXYARD_TEST_TIER = tier
process.exitCode = await runLocked(process.execPath, [fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url)), "run", ...args])
