import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  MIN_CLAUDE_CLI,
  claudeCliFloorScript,
  claudeCliRefusal,
  claudeCliTooOld,
  claudeCliVersion,
  minClaudeCliFor,
  unrecognizedModelError,
  versionBelow,
} from "../shared/claudeCli.js"
import { tmpDir } from "./helpers.js"

describe("which Claude Code a model needs", () => {
  it("reads the version from `claude --version`, and nothing from a wrapper or a fake", () => {
    expect(claudeCliVersion("2.1.293 (Claude Code)\n")).toBe("2.1.293")
    expect(claudeCliVersion("warning: something\n2.1.321 (Claude Code)")).toBe("2.1.321")
    expect(claudeCliVersion("0.0.0 (fake claude for Box Yard)")).toBeNull()
    expect(claudeCliVersion("")).toBeNull()
    expect(claudeCliVersion(null)).toBeNull()
  })

  it("compares versions by number, not by text", () => {
    expect(versionBelow("2.1.293", "2.1.321")).toBe(true)
    expect(versionBelow("2.1.321", "2.1.321")).toBe(false)
    expect(versionBelow("2.1.1000", "2.1.321")).toBe(false)
    expect(versionBelow("2.0.999", "2.1.0")).toBe(true)
    expect(versionBelow("3.0.0", "2.1.321")).toBe(false)
  })

  it("knows Fable 5.2 needs 2.1.321, with or without a date or [1m]", () => {
    expect(minClaudeCliFor("claude-fable-5-2")).toBe("2.1.321")
    expect(minClaudeCliFor("claude-fable-5-2[1m]")).toBe("2.1.321")
    expect(minClaudeCliFor("claude-fable-5-2-20261101")).toBe("2.1.321")
    expect(minClaudeCliFor("claude-fable-5-1")).toBeNull()
    expect(minClaudeCliFor("fable")).toBeNull()
    expect(minClaudeCliFor("")).toBeNull()
    expect(minClaudeCliFor(null)).toBeNull()
    expect(MIN_CLAUDE_CLI).toBe("2.1.321")
  })

  it("calls a CLI too old only when it knows both the version and the model's minimum", () => {
    expect(claudeCliTooOld("2.1.293", "claude-fable-5-2")).toBe(true)
    expect(claudeCliTooOld("2.1.321", "claude-fable-5-2")).toBe(false)
    expect(claudeCliTooOld("2.1.293", "claude-opus-5-5")).toBe(false)
    expect(claudeCliTooOld(null, "claude-fable-5-2")).toBe(false)
  })
})

describe("what an old Claude Code's failure says", () => {
  it("names the model, the CLI version, where it is and what to do", () => {
    const refused = claudeCliRefusal({ model: "claude-fable-5-2", cliVersion: "2.1.312", where: "this computer" })
    expect(refused).toContain("Claude Code 2.1.312 on this computer doesn't know the model claude-fable-5-2")
    expect(refused).toContain("needs Claude Code 2.1.321 or later")
    expect(refused).toContain("the turn wasn't started")
    expect(refused).toContain("npm install -g @anthropic-ai/claude-code@latest")
  })

  it("says Box Yard updates a sandbox itself, and leaves the owner's machine to the owner", () => {
    const box = unrecognizedModelError({ model: "claude-fable-5-2", cliVersion: "2.1.293", where: "box abc", managed: true })
    expect(box).toContain("Claude Code 2.1.293 on box abc doesn't know the model claude-fable-5-2")
    expect(box).toContain("Box Yard stopped the turn")
    expect(box).toContain("Box Yard updates Claude Code there before its next turn")
    const own = unrecognizedModelError({ model: "claude-nope-9", cliVersion: null, where: "SSH machine build-1", managed: false })
    expect(own).toContain("Claude Code on SSH machine build-1 doesn't know the model claude-nope-9.")
    expect(own).toContain("Update it there")
    expect(own).toContain("the model name is wrong")
  })
})

describe("a box's setup keeps Claude Code at the floor", () => {
  // Runs the real shell snippet against a fake `claude` and a fake `npm` on PATH: npm "installs" by rewriting claude.
  function run(have: string | null, opts: { npmFails?: boolean } = {}) {
    const bin = tmpDir()
    const log = path.join(bin, "npm.log")
    const claude = (v: string) => `#!/bin/sh\necho "${v} (Claude Code)"\n`
    if (have) fs.writeFileSync(path.join(bin, "claude"), claude(have), { mode: 0o755 })
    const npm = opts.npmFails
      ? `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`
      : `#!/bin/sh\necho "$@" >> ${log}\nprintf '%s' '${claude("9.9.9")}' > ${path.join(bin, "claude")}\nchmod +x ${path.join(bin, "claude")}\n`
    fs.writeFileSync(path.join(bin, "npm"), npm, { mode: 0o755 })
    let ok = true
    try {
      execFileSync("/bin/sh", ["-c", `${claudeCliFloorScript()} && claude --version`], { env: { PATH: `${bin}:/usr/bin:/bin` }, stdio: "pipe" })
    } catch {
      ok = false
    }
    const version = fs.existsSync(path.join(bin, "claude")) ? execFileSync(path.join(bin, "claude")).toString().trim() : null
    return { ok, version, npm: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : null }
  }

  it("installs it when it is missing", () => {
    expect(run(null)).toEqual({ ok: true, version: "9.9.9 (Claude Code)", npm: "install -g @anthropic-ai/claude-code@latest" })
  })

  it("updates one older than the floor, as a snapshot's is", () => {
    expect(run("2.1.293")).toEqual({ ok: true, version: "9.9.9 (Claude Code)", npm: "install -g @anthropic-ai/claude-code@latest" })
  })

  it("leaves one at or above the floor alone", () => {
    expect(run("2.1.321")).toEqual({ ok: true, version: "2.1.321 (Claude Code)", npm: null })
    expect(run("2.2.4")).toEqual({ ok: true, version: "2.2.4 (Claude Code)", npm: null })
  })

  it("keeps the box when the update fails but a CLI is there, and fails when there is none", () => {
    expect(run("2.1.293", { npmFails: true })).toMatchObject({ ok: true, version: "2.1.293 (Claude Code)" })
    expect(run(null, { npmFails: true })).toMatchObject({ ok: false, version: null })
  })
})
