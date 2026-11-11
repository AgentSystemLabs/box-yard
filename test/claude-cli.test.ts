import { describe, expect, it } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  CLAUDE_CLI_UPDATE_SCRIPT,
  MIN_CLAUDE_CLI,
  claudeCliFloorScript,
  claudeCliRefusal,
  claudeCliTooOld,
  claudeCliVersion,
  minClaudeCliFor,
  unrecognizedModelError,
  versionBelow,
} from "../shared/claudeCli.js"
import { ensureClaudeCliKnows, type CliRunner } from "../server/claudeCli.js"
import { workerSetupScript } from "../server/providers/upstash.js"
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

describe("the update Box Yard runs in a sandbox", () => {
  // The real shell line against a fake npm and a fake sudo on PATH (never the real ones).
  function update(npm: string, sudo: string) {
    const bin = tmpDir()
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "2.1.293 (Claude Code)"\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "npm $@" >> ${bin}/log\n${npm}\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, "sudo"), `#!/bin/sh\necho "sudo $@" >> ${bin}/log\n${sudo}\n`, { mode: 0o755 })
    const res = spawnSync("/bin/sh", ["-c", `{ ${CLAUDE_CLI_UPDATE_SCRIPT}; } ; claude --version`], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" })
    return { stdout: res.stdout.trim(), stderr: res.stderr.trim(), log: fs.readFileSync(path.join(bin, "log"), "utf8").trim().split("\n") }
  }
  const INSTALL = "install -g @anthropic-ai/claude-code@latest --no-audit --no-fund"

  it("installs the latest and answers the version, with nothing on stderr", () => {
    expect(update("exit 0", "exit 1")).toEqual({ stdout: "2.1.293 (Claude Code)", stderr: "", log: [`npm ${INSTALL}`] })
  })

  it("tries sudo where npm may not write, and reports npm's last words when both fail", () => {
    expect(update("echo 'npm error EACCES' >&2; exit 1", "exit 0")).toMatchObject({ stderr: "", log: [`npm ${INSTALL}`, `sudo -n npm ${INSTALL}`] })
    expect(update("echo 'npm error EACCES' >&2; exit 1", "echo 'sudo: a password is required' >&2; exit 1")).toMatchObject({ stdout: "2.1.293 (Claude Code)", stderr: "npm error EACCES" })
  })
})

describe("where Box Yard installs Claude Code", () => {
  const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8")

  it("an Upstash box's setup holds the floor, so a box from an old snapshot is brought up to date", () => {
    expect(workerSetupScript()).toContain(claudeCliFloorScript())
    expect(workerSetupScript()).not.toContain("command -v claude >/dev/null || npm install")
  })

  it("the deploy script holds it too, on a redeploy as well", () => {
    expect(read("scripts/deploy-box.ts")).toContain("${claudeCliFloorScript()}; ")
  })

  it("both images install at least the floor (the changed line rebuilds a cached layer)", () => {
    for (const file of ["Dockerfile", "docker/Dockerfile"]) expect(read(file)).toContain(`"@anthropic-ai/claude-code@>=${MIN_CLAUDE_CLI}"`)
  })
})

describe("the check before a turn", () => {
  /** A runner whose `claude --version` answers `versions` in turn, the last one from then on; `calls` is what ran. */
  function runner(versions: (string | null)[], opts: { managed?: boolean; where?: string; stderr?: string } = {}) {
    const calls: string[] = []
    let probes = 0
    const r: CliRunner = {
      claudeBin: "claude",
      managed: opts.managed ?? true,
      where: opts.where ?? "the box",
      exec: async (command) => {
        calls.push(command)
        const v = versions[Math.min(probes++, versions.length - 1)]
        return { exitCode: v ? 0 : 127, stdout: v ? `${v} (Claude Code)\n` : "", stderr: command.includes("npm install") ? (opts.stderr ?? "") : "" }
      },
    }
    return { r, calls }
  }
  const FABLE = "claude-fable-5-2"

  it("leaves a CLI that knows the model alone", async () => {
    const { r, calls } = runner(["2.1.322"])
    expect(await ensureClaudeCliKnows(FABLE, r)).toEqual({ version: "2.1.322" })
    expect(calls).toEqual(["claude --version"])
  })

  it("updates a sandbox's CLI that is too old, and says what it replaced", async () => {
    const { r, calls } = runner(["2.1.293", "2.1.325"])
    expect(await ensureClaudeCliKnows(FABLE, r)).toEqual({ version: "2.1.325", updatedFrom: "2.1.293" })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain("npm install -g @anthropic-ai/claude-code@latest")
    expect(calls[1]).toContain("sudo -n npm install -g @anthropic-ai/claude-code@latest")
    expect(calls[1]!.endsWith("claude --version")).toBe(true)
  })

  it("fails the start with npm's reason when the update doesn't take", async () => {
    const { r } = runner(["2.1.293"], { stderr: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed" })
    const err = await ensureClaudeCliKnows(FABLE, r).catch((e: Error) => e.message)
    expect(err).toContain("Claude Code 2.1.293 on the box doesn't know the model claude-fable-5-2, which needs Claude Code 2.1.321 or later.")
    expect(err).toContain("Updating it there failed (npm install -g @anthropic-ai/claude-code@latest)")
    expect(err).toContain("ENOTFOUND")
    const still = await ensureClaudeCliKnows(FABLE, runner(["2.1.293"]).r).catch((e: Error) => e.message)
    expect(still).toContain("it is still 2.1.293")
  })

  it("never installs on the owner's machine: the turn is refused with what to do", async () => {
    const { r, calls } = runner(["2.1.312"], { managed: false, where: "this computer" })
    const err = await ensureClaudeCliKnows(FABLE, r).catch((e: Error) => e.message)
    expect(err).toContain("Claude Code 2.1.312 on this computer doesn't know the model claude-fable-5-2")
    expect(err).toContain("the turn wasn't started")
    expect(calls).toEqual(["claude --version"])
  })

  it("checks nothing it can't tell: a CLI that doesn't say its version, a model with no minimum", async () => {
    expect(await ensureClaudeCliKnows(FABLE, runner([null]).r)).toEqual({ version: null })
    const { r, calls } = runner(["2.1.100"])
    expect(await ensureClaudeCliKnows("claude-opus-5-5", r)).toEqual({ version: "2.1.100" })
    expect(calls).toEqual(["claude --version"])
  })

  it("after a turn's CLI said it doesn't recognize its model, a sandbox gets the latest whatever its version", async () => {
    const { r, calls } = runner(["2.1.322", "2.1.330"])
    expect(await ensureClaudeCliKnows("claude-next-9", r, { stale: true })).toEqual({ version: "2.1.330", updatedFrom: "2.1.322" })
    expect(calls[1]).toContain("npm install -g")
    // Already the latest: the turn runs, and the runner stops it again if the CLI still doesn't know the model.
    expect(await ensureClaudeCliKnows("claude-next-9", runner(["2.1.330"]).r, { stale: true })).toEqual({ version: "2.1.330" })
    // The owner's machine is only asked again.
    const own = runner(["2.1.330"], { managed: false })
    expect(await ensureClaudeCliKnows("claude-next-9", own.r, { stale: true })).toEqual({ version: "2.1.330" })
    expect(own.calls).toEqual(["claude --version"])
  })
})
