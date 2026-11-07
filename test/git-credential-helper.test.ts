import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { GITHUB_HELPER, githubCredentialHelper, gitWithHelper, setHelperScript } from "../server/gitShare.js"
import { gitRestoreScript } from "../server/gitFirst.js"
import { thinRestoreScript } from "../server/archive.js"
import { q } from "../server/providers/types.js"
import { tmpDir } from "./helpers.js"

// F1: on an Upstash box whose global git config had `credential.helper=store`, git asked the store first and pushed
// with whatever token it held, never the project's GITHUB_TOKEN. Box Yard's helper now clears the inherited ones.

/** A box's git: a global config with a stored credential and gh's github.com helper, and no system config. */
function box() {
  const dir = tmpDir("f1-")
  const global = path.join(dir, "gitconfig")
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: global, GIT_CONFIG_COUNT: "0", GITHUB_TOKEN: "project-token", GIT_TERMINAL_PROMPT: "0" }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString()
  git(dir, "config", "--global", "credential.helper", "!f() { echo username=stored; echo password=stored-token; }; f")
  git(dir, "config", "--global", "credential.https://github.com.helper", "!f() { echo username=gh; echo password=gh-token; }; f")
  const repo = path.join(dir, "repo")
  git(dir, "init", "-q", repo)
  const sh = (script: string) => execFileSync("bash", ["-c", script], { cwd: repo, env, stdio: "pipe" }).toString()
  /** The password git would send to github.com from the repo. */
  const password = (prefix = "git") => sh(`printf 'protocol=https\\nhost=github.com\\n\\n' | ${prefix} credential fill`).match(/^password=(.*)$/m)?.[1]
  return { dir, repo, git, sh, password }
}

describe("Box Yard's GitHub credential helper (F1)", () => {
  it("the inherited helpers answered first before the fix", () => {
    const b = box()
    b.sh(`git config credential.helper ${q(GITHUB_HELPER)}`)
    expect(b.password()).toBe("stored-token")
    expect(b.password(`git -c credential.helper=${q(GITHUB_HELPER)}`)).toBe("stored-token")
  })

  it("only: the repo's config and one-off git commands use the project's token", () => {
    const b = box()
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.password()).toBe("project-token")
    // Safe to run again (each turn does): still one empty entry and Box Yard's helper.
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.git(b.repo, "config", "--local", "--get-all", "credential.helper").split("\n").filter(Boolean)).toEqual([GITHUB_HELPER])
    expect(fs.readFileSync(path.join(b.repo, ".git", "config"), "utf8")).toMatch(/helper = \n\s*helper = /)
    expect(b.password(gitWithHelper(GITHUB_HELPER, true))).toBe("project-token")
  })

  it("not only (this computer, no project token): the owner's own git login still answers first", () => {
    const b = box()
    b.sh(setHelperScript(GITHUB_HELPER, false))
    expect(b.password()).toBe("stored-token")
    expect(b.password(gitWithHelper(GITHUB_HELPER, false))).toBe("stored-token")
    // Going back to only from there, and the other way, works on the same repo.
    b.sh(setHelperScript(GITHUB_HELPER, true))
    expect(b.password()).toBe("project-token")
    b.sh(setHelperScript(GITHUB_HELPER, false))
    expect(b.password()).toBe("stored-token")
  })

  it.each([true, false])("refreshes an older installed helper while preserving only=%s precedence", (only) => {
    const b = box()
    b.sh(setHelperScript('!f() { echo username=old; echo password=old-unscoped-token; }; f', only))
    b.sh(setHelperScript(GITHUB_HELPER, only))
    expect(b.password()).toBe(only ? "project-token" : "stored-token")
    expect(b.git(b.repo, "config", "--local", "--get-all", "credential.helper")).not.toContain("old-unscoped-token")
    // With inherited helpers cleared, a non-GitHub request cannot obtain the application's token.
    expect(b.sh(`printf 'protocol=https\\nhost=attacker.invalid\\n\\n' | ${gitWithHelper(GITHUB_HELPER, true)} credential fill 2>/dev/null || true`)).toBe("")
  })

  it("the restore scripts set it the same way", () => {
    const helper = { helper: GITHUB_HELPER, only: true }
    const thin = thinRestoreScript("/t", { root: "/r", mirror: "/r/m.git", url: "https://github.com/a/b.git", partial: false, git: "git" }, { ...helper, userName: "t", userEmail: "t@t" })
    expect(thin).toContain(setHelperScript(GITHUB_HELPER, true))
    const first = gitRestoreScript({ dir: "/t", taskId: "t", baseBranch: "main", clone: { script: "true", ...helper }, git: gitWithHelper(GITHUB_HELPER, true), env: "true" })
    expect(first).toContain(setHelperScript(GITHUB_HELPER, true, "git -C work"))
  })
})

// S03: exercise Git's credential protocol without network requests or any personal/system Git config.
function isolatedCredentials() {
  const dir = tmpDir("s03-credentials-")
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
    GITHUB_TOKEN: "fake-s03-project-token", GH_TOKEN: "fake-s03-fallback-token",
  }
  const dockerHelper = execFileSync("git", ["config", "--file", path.resolve("docker/gitconfig"), "--get-all", "credential.https://github.com.helper"], { cwd: dir, env, encoding: "utf8" }).trim()
  const run = (script: string, input: string, extra = {}) => spawnSync("sh", ["-c", script], { cwd: dir, env: { ...env, ...extra }, input, encoding: "utf8" })
  return { dockerHelper, run }
}

describe("GitHub credential recipient boundary (S03)", () => {
  it("keeps Docker's installed helper in sync and preserves its GH_TOKEN fallback", () => {
    const b = isolatedCredentials()
    expect(b.dockerHelper).toBe(githubCredentialHelper(true))
    const input = "protocol=https\nhost=github.com\n\n"
    expect(b.run(`${b.dockerHelper.slice(1)} get`, input, { GITHUB_TOKEN: "" }).stdout).toContain("password=fake-s03-fallback-token\n")
    expect(b.run(`${GITHUB_HELPER.slice(1)} get`, input, { GITHUB_TOKEN: "" }).stdout).toBe("")
  })

  it.each([
    ["HTTPS elsewhere", "protocol=https\nhost=attacker.invalid\n\n"],
    ["HTTP elsewhere", "protocol=http\nhost=attacker.invalid\n\n"],
    ["insecure GitHub", "protocol=http\nhost=github.com\n\n"],
    ["SSH", "protocol=ssh\nhost=github.com\n\n"],
    ["lookalike", "protocol=https\nhost=github.com.attacker.invalid\n\n"],
    ["subdomain", "protocol=https\nhost=api.github.com\n\n"],
    ["trailing dot", "protocol=https\nhost=github.com.\n\n"],
    ["userinfo", "protocol=https\nhost=github.com@attacker.invalid\n\n"],
    ["reverse userinfo", "protocol=https\nhost=attacker.invalid@github.com\n\n"],
    ["nonstandard port", "protocol=https\nhost=github.com:8443\n\n"],
    ["explicit port", "protocol=https\nhost=github.com:443\n\n"],
    ["encoded host", "protocol=https\nhost=%67ithub.com\n\n"],
    ["leading whitespace", "protocol=https\nhost= github.com\n\n"],
    ["trailing whitespace", "protocol=https\nhost=github.com \n\n"],
  ])("does not return the application token for %s", (_name, input) => {
    const b = isolatedCredentials()
    for (const helper of [GITHUB_HELPER, b.dockerHelper]) {
      const result = b.run(`${gitWithHelper(helper, true)} credential fill`, input)
      expect(result.stdout).not.toContain("fake-s03-")
      expect(result.status).not.toBe(0)
    }
  })

  it("answers HTTPS GitHub clone and push credential requests with the current token", () => {
    const b = isolatedCredentials()
    for (const helper of [GITHUB_HELPER, b.dockerHelper]) {
      for (const input of ["protocol=https\nhost=github.com\n", "protocol=https\nhost=github.com\n\n", "protocol=https\nhost=github.com\npath=owner/repo.git\nusername=x-access-token\nwwwauth[]=Basic realm=git\n\n"]) {
        const result = b.run(`${gitWithHelper(helper, true)} -c credential.useHttpPath=true credential fill`, input)
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("username=x-access-token\npassword=fake-s03-project-token\n")
      }
    }
  })

  it.each([
    "host=github.com\n\n",
    "protocol=https\n\n",
    "protocol=https\nhost=github.com\nhost=attacker.invalid\n\n",
    "host=attacker.invalid\nprotocol=https\nhost=github.com\n\n",
    "protocol=http\nprotocol=https\nhost=github.com\n\n",
    "protocol=https\nhost=github.com\nhost=github.com\n\n",
    "protocol=https\nhost=github.com\nbroken-line\n\n",
    "protocol=https\nhost=github.com\r\n\n",
    "protocol=https\nhost=github.com\nurl=https://attacker.invalid\n\n",
    "protocol=https\nhost=github.com",
  ])("rejects malformed or ambiguous raw helper input %#", (input) => {
    const b = isolatedCredentials()
    for (const helper of [GITHUB_HELPER, b.dockerHelper]) {
      // Git normalizes some fields before invoking a helper; also verify the helper's own parser directly.
      const result = b.run(`${helper.slice(1)} get`, input)
      expect(result.stdout).toBe("")
      expect(result.status).toBe(0)
    }
  })

  it("emits nothing for store/erase or a missing token", () => {
    const b = isolatedCredentials()
    const input = "protocol=https\nhost=github.com\n\n"
    for (const helper of [GITHUB_HELPER, b.dockerHelper]) {
      for (const operation of ["store", "erase"]) expect(b.run(`${helper.slice(1)} ${operation}`, input).stdout).toBe("")
      expect(b.run(`${helper.slice(1)} get`, input, { GITHUB_TOKEN: "", GH_TOKEN: "" }).stdout).toBe("")
    }
  })
})
