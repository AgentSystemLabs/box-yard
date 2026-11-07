import { configDefaults, defineConfig } from "vitest/config"
import { SLOW_TESTS, TEST_INCLUDE, testTier } from "./scripts/testTiers.js"

const tier = testTier()
const slow = Object.keys(SLOW_TESTS)

export default defineConfig({
  test: {
    include: tier === "slow" ? slow : TEST_INCLUDE,
    exclude: [...configDefaults.exclude, ...(tier === "fast" ? slow : [])],
    // Removes the temp folders each test file made (tmpDir in test/helpers.ts).
    setupFiles: ["test/setup.ts"],
    environment: "node",
    // DOM fixtures must never request assets from the live Box Yard on localhost:3000.
    environmentOptions: { happyDOM: {
      url: "http://boxyard.invalid",
      settings: {
        // Rendering fixtures asserts src/href; loading real pages or scripts is never part of a unit test.
        // Create the frame DOM, but block its navigation below (disabling frames themselves logs errors).
        enableIframePageLoading: true,
        enableImageFileLoading: false,
        enableCSSFileLoading: false,
        disableJavaScriptFileLoading: true,
        handleDisabledFileLoadingAsSuccess: true,
        navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
      },
    } },
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
