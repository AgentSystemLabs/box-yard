import { describe, expect, it } from "vitest"
import { percent, uploadProblem, type PendingFile } from "../web/src/lib/pendingUploads.js"

const file = (name: string, change: Partial<PendingFile> = {}): PendingFile => ({ key: 0, name, size: 1, mime: "text/plain", preview: null, status: "done", ...change })

describe("percent", () => {
  it("rounds down to a whole percent between 0 and 100", () => {
    expect(percent(0.429)).toBe(42)
    expect(percent(0.999)).toBe(99)
    expect(percent(1)).toBe(100)
    expect(percent(1.2)).toBe(100)
    expect(percent(-1)).toBe(0)
  })
})

describe("uploadProblem", () => {
  it("is null while nothing failed", () => {
    expect(uploadProblem([file("a.txt"), file("b.txt", { status: "uploading" })])).toBeNull()
  })

  it("lists each failure and says how to get the send going", () => {
    const retryable = new File(["x"], "a.txt")
    expect(uploadProblem([file("a.txt", { status: "error", error: '"a.txt" didn\'t upload: Offline', file: retryable })])).toEqual({
      errors: [`"a.txt" didn't upload: Offline`],
      fix: "Retry or remove it to send.",
    })
    expect(uploadProblem([file("big.mov", { status: "error", error: "too big" }), file("huge.mov", { status: "error" })])).toEqual({
      errors: ["too big", `"huge.mov" didn't upload.`],
      fix: "Remove them to send.",
    })
  })
})
