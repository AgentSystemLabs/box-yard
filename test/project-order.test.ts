import { describe, expect, it } from "vitest"
import { applyOrder } from "../web/src/lib/projectOrder.js"

// The owner's project order, as the event stream applies a saved one to the cached projects (lib/stream.ts).

const ALPHA = { id: "prj_alpha1", name: "alpha" }
const BETA = { id: "prj_beta01", name: "beta" }
const GAMMA = { id: "prj_gamma1", name: "gamma" }

describe("applyOrder", () => {
  it("applies an id order, keeping unnamed items after the named ones", () => {
    expect(applyOrder([ALPHA, BETA, GAMMA], [GAMMA.id, ALPHA.id]).map((p) => p.name)).toEqual(["gamma", "alpha", "beta"])
  })
})
