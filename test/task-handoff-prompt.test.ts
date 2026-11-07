import { describe, expect, it } from "vitest"
import { recapPrompt } from "../server/prompts.js"
import type { TaskMessage } from "../shared/types.js"

describe("cross-harness recap", () => {
  it("bounds the original instructions, summary and recent conversation and describes the existing workspace honestly", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", content: `message-${i}: ${"x".repeat(5000)}` } as TaskMessage))
    messages.push({ role: "event", content: "internal event excluded from conversation" } as TaskMessage)
    const prompt = recapPrompt({ title: "Example feature", prompt: "Instruction ".repeat(5000), summary: "Progress ".repeat(5000), branch: "example-feature", prUrl: "https://github.com/acme/example/pull/12" }, messages, { handoff: { from: "claude", to: "codex", needsWorkspace: true } })
    expect(prompt.length).toBeLessThan(22_000)
    expect(prompt).toContain("SAME task on Codex after Claude Code")
    expect(prompt).toContain("not a resume of the other harness's session")
    expect(prompt).toContain("uncommitted work and attachments")
    expect(prompt).not.toContain("workspace is gone")
    expect(prompt).not.toContain("session for this task was lost")
    expect(prompt).toContain("message-99:")
    expect(prompt).not.toContain("message-0:")
    expect(prompt).not.toContain("internal event excluded")
    expect(prompt).toContain("https://github.com/acme/example/pull/12")
  })
})
