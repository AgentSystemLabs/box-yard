import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { GIT_PREP_MARK, RESTORE_MARK, gitPrepScript, parseGitPrep, parseGitRestore, stageBaseScript } from "../server/gitFirst.js"
import { tmpDir } from "./helpers.js"

const b64 = (s: string) => Buffer.from(s).toString("base64")
const line = (fields: Record<string, string>) => `${GIT_PREP_MARK} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}`
const W = "a".repeat(40)
const I = "b".repeat(40)
const H = "c".repeat(40)

describe("turn-end branch push", () => {
  it.each(["second-task", "feature/second-task", "boxyard/second"])("publishes %s even when another remote branch already has its commit", (branch) => {
    const root = tmpDir("git-first-shared-tip-")
    const work = path.join(root, "work")
    const bare = path.join(root, "origin.git")
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, env, stdio: "pipe" }).toString().trim()
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(root, "init", "-q", "-b", "main", work)
    fs.writeFileSync(path.join(work, "file.txt"), "same work\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "shared commit")
    git(work, "remote", "add", "origin", bare)
    git(work, "push", "-q", "origin", "HEAD:main")
    git(work, "checkout", "-qb", "boxyard/first")
    fs.appendFileSync(path.join(work, "file.txt"), "a task's commit\n")
    git(work, "commit", "-qam", "task commit")
    git(work, "push", "-q", "origin", "HEAD:boxyard/first")
    git(work, "checkout", "-qb", branch)
    expect(git(work, "rev-list", "HEAD", "--not", "--remotes")).toBe("")
    expect(git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)).toBe("")
    const result = parseGitPrep(execFileSync("bash", ["-c", gitPrepScript({ root, work, taskId: path.basename(root), branch, baseBranch: "main", lastWip: null, packMaxBytes: 0, git: "git", env: "true" })], { env, encoding: "utf8" }))
    try {
      expect(result).toMatchObject({ status: "pushed", branch })
      expect(git(bare, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)).toBe(git(work, "rev-parse", "HEAD"))
    } finally {
      if (result.stage) fs.rmSync(result.stage, { recursive: true, force: true })
    }
  })
})

// On Upstash, root's own git (/workspace/.step-git) rewrites a task's .git/index as root:root 0600 (gitFirst.ts).
// chmod 000 makes it just as unreadable here; root reads anything, so these need another user.
describe.skipIf(process.getuid?.() === 0)("turn-end push with an index this user can't read or write", () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, env, stdio: "pipe" }).toString().trim()
  const stages: string[] = []
  afterAll(() => stages.forEach((s) => fs.rmSync(s, { recursive: true, force: true })))

  /** A clone of a bare origin on its own branch with a commit, a staged edit under an unstaged one, a staged new file, an untracked and an ignored file. */
  function task() {
    const root = tmpDir("git-first-index-")
    const work = path.join(root, "work")
    const bare = path.join(root, "origin.git")
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(root, "init", "-q", "-b", "main", work)
    fs.writeFileSync(path.join(work, "README.md"), "hello\n")
    fs.writeFileSync(path.join(work, ".gitignore"), ".env\n")
    git(work, "add", ".")
    git(work, "commit", "-qm", "init")
    git(work, "remote", "add", "origin", bare)
    git(work, "push", "-q", "origin", "HEAD:main")
    git(work, "fetch", "-q", "origin")
    git(work, "checkout", "-qb", "task-branch")
    fs.writeFileSync(path.join(work, "own.txt"), "committed\n")
    git(work, "add", "own.txt")
    git(work, "commit", "-qm", "own commit")
    fs.writeFileSync(path.join(work, "README.md"), "staged edit\n")
    git(work, "add", "README.md")
    fs.writeFileSync(path.join(work, "README.md"), "staged edit\nthen an unstaged one\n")
    fs.writeFileSync(path.join(work, "new.txt"), "new and staged\n")
    git(work, "add", "new.txt")
    fs.writeFileSync(path.join(work, "notes.md"), "untracked\n")
    fs.writeFileSync(path.join(work, ".env"), "SECRET=1\n")
    const index = path.join(work, ".git", "index")
    const id = path.basename(root)
    const prep = () => {
      const r = parseGitPrep(execFileSync("bash", ["-c", gitPrepScript({ root, work, taskId: id, branch: "task-branch", baseBranch: "main", lastWip: null, packMaxBytes: 1 << 20, git: "git", env: "true" })], { env, encoding: "utf8" }))
      if (r.stage) stages.push(r.stage)
      return r
    }
    /** What a write to the repo would change; the index read with its mode put back for a moment. */
    const state = () => {
      const mode = fs.statSync(index).mode & 0o777
      fs.chmodSync(index, 0o600)
      try {
        return { mode, index: fs.readFileSync(index).toString("base64"), head: git(work, "rev-parse", "HEAD"), reflog: git(work, "reflog"), status: git(work, "status", "--porcelain=v2", "--untracked-files=all") }
      } finally {
        fs.chmodSync(index, mode)
      }
    }
    return { root, work, bare, index, id, prep, state }
  }

  it("pushes the branch and every file of the work when the index can't be read, and leaves the index alone", () => {
    const t = task()
    fs.chmodSync(t.index, 0o000)
    expect(() => git(t.work, "status")).toThrow(/Permission denied/)
    const before = t.state()
    const r = t.prep()
    expect(r).toMatchObject({ status: "pushed", branch: "task-branch", branchPush: "yes", dirty: true, pack: "yes" })
    expect(r.reason).toMatch(/^couldn't read work\/\.git\/index \(.*Permission denied\), so the snapshot started from HEAD and saved anything staged as unstaged$/)
    // Origin has the branch and the WIP ref: the whole working tree, what was staged included.
    expect(git(t.bare, "rev-parse", "refs/heads/task-branch")).toBe(before.head)
    const w = git(t.bare, "rev-parse", `refs/boxyard/wip/${t.id}`)
    expect(w).toBe(r.wip)
    expect(git(t.bare, "show", `${w}:README.md`)).toBe("staged edit\nthen an unstaged one")
    expect(git(t.bare, "show", `${w}:new.txt`)).toBe("new and staged")
    expect(git(t.bare, "show", `${w}:notes.md`)).toBe("untracked")
    expect(git(t.bare, "ls-tree", "--name-only", w)).not.toContain(".env")
    // The index commit is HEAD's tree: what was staged can't be told apart without the index.
    expect(git(t.bare, "rev-parse", `${w}^1`)).toBe(before.head)
    expect(git(t.bare, "rev-parse", `${w}^2^{tree}`)).toBe(git(t.bare, "rev-parse", `${before.head}^{tree}`))
    // No commit, no index write: the repo is as it was, its index still unreadable.
    expect(t.state()).toEqual(before)
    expect(fs.statSync(t.index).mode & 0o777).toBe(0)
    // The same work again is the same snapshot, and a no-op push.
    expect(t.prep()).toMatchObject({ status: "pushed", wip: r.wip, index: r.index, branchPush: "up-to-date" })
  })

  it("keeps what was staged apart when the index can be read but not written", () => {
    const t = task()
    fs.chmodSync(t.index, 0o444)
    const before = t.state()
    const r = t.prep()
    expect(r).toMatchObject({ status: "pushed", branchPush: "yes", reason: null })
    const w = git(t.bare, "rev-parse", `refs/boxyard/wip/${t.id}`)
    expect(git(t.bare, "show", `${w}:README.md`)).toBe("staged edit\nthen an unstaged one")
    expect(git(t.bare, "show", `${w}^2:README.md`)).toBe("staged edit")
    expect(git(t.bare, "show", `${w}^2:new.txt`)).toBe("new and staged")
    expect(t.state()).toEqual(before)
  })

  it("still skips what a snapshot can't carry when the index can't be read: submodules, another repo inside", () => {
    const sub = task()
    // A submodule HEAD already has: a gitlink in the tree.
    git(sub.work, "update-index", "--add", "--cacheinfo", `160000,${git(sub.work, "rev-parse", "HEAD")},lib`)
    git(sub.work, "commit", "-qm", "add a submodule")
    fs.chmodSync(sub.index, 0o000)
    expect(sub.prep()).toMatchObject({ status: "skipped", reason: "the repo has submodules" })

    const nested = task()
    git(nested.root, "init", "-q", path.join(nested.work, "inner"))
    fs.writeFileSync(path.join(nested.work, "inner", "x.txt"), "x\n")
    fs.chmodSync(nested.index, 0o000)
    expect(nested.prep()).toMatchObject({ status: "skipped", reason: "work/ holds another git repo" })
    expect(git(nested.bare, "for-each-ref", "refs/boxyard")).toBe("")
  })
})

describe("parseGitPrep", () => {
  it("reads a pushed snapshot", () => {
    const out = `noise\n${line({ status: "pushed", stage: "/tmp/boxyard-git-t1", head: H, branch: "boxyard/x", wip: W, index: I, pushed: W, dirty: "1", pack: "yes", branchpush: "yes", why: "" })}\n`
    expect(parseGitPrep(out)).toEqual({
      status: "pushed",
      stage: "/tmp/boxyard-git-t1",
      head: H,
      branch: "boxyard/x",
      wip: W,
      index: I,
      pushedWip: W,
      dirty: true,
      pack: "yes",
      branchPush: "yes",
      reason: null,
    })
  })

  it("reads '-' as nothing, and an unknown pack or status as not asked / failed", () => {
    const r = parseGitPrep(line({ status: "odd", stage: "-", head: "-", branch: "-", wip: "-", index: "-", pushed: "-", dirty: "0", pack: "?", branchpush: "-", why: "" }))
    expect(r).toMatchObject({ status: "failed", stage: null, head: null, branch: null, wip: null, pushedWip: null, dirty: false, pack: "-" })
  })

  it("is a failure, with the end of stderr, when the script never printed its line", () => {
    expect(parseGitPrep("", "line one\nbash: git: command not found\n")).toMatchObject({ status: "failed", reason: "the git snapshot didn't finish: line one; bash: git: command not found" })
    expect(parseGitPrep("")).toMatchObject({ status: "failed", reason: "the git snapshot didn't finish" })
  })

  it("turns a push the token can't make into a quiet skip, naming only git's line, token redacted", () => {
    const why = `git push of refs/boxyard/wip/t1: remote: Permission to o/r.git denied to bot.\nfatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/': The requested URL returned error: 403\n`
    const r = parseGitPrep(line({ status: "failed", stage: "/tmp/s", head: H, branch: "b", wip: W, index: I, pushed: "-", dirty: "1", pack: "yes", branchpush: "-", why: b64(why) }))
    expect(r.status).toBe("skipped")
    expect(r.reason).toBe("no write access to origin (git push of refs/boxyard/wip/t1: remote: Permission to o/r.git denied to bot.)")
    const only403 = parseGitPrep(line({ status: "failed", why: b64("git push: fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/': The requested URL returned error: 403") }))
    expect(only403.status).toBe("skipped")
    expect(only403.reason).toContain("x-access-token:***@github.com")
    expect(only403.reason).not.toContain("ghs_secret")
  })

  it("keeps other failures as failures, on one line", () => {
    const r = parseGitPrep(line({ status: "failed", why: b64("git push: To github.com:o/r.git\n ! [remote rejected] HEAD -> x (protected branch hook declined)\n") }))
    expect(r).toMatchObject({ status: "failed", reason: "git push: To github.com:o/r.git; ! [remote rejected] HEAD -> x (protected branch hook declined)" })
    expect(parseGitPrep(line({ status: "skipped", why: b64("the repo has submodules") })).reason).toBe("the repo has submodules")
  })
})

describe("parseGitRestore", () => {
  it("reads each outcome", () => {
    expect(parseGitRestore(`x\n${RESTORE_MARK} git -\n`)).toEqual({ ok: true, from: "git", reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} partial -`)).toEqual({ ok: true, from: "partial", reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} none -`)).toEqual({ ok: true, from: null, reason: null })
    expect(parseGitRestore(`${RESTORE_MARK} failed ${b64("git clone failed: https://x-access-token:abc@github.com/o/r: 403")}`)).toEqual({
      ok: false,
      from: null,
      reason: "git clone failed: https://x-access-token:***@github.com/o/r: 403",
    })
    expect(parseGitRestore("", "Killed")).toEqual({ ok: false, from: null, reason: "the restore script didn't finish: Killed" })
  })
})

describe("stageBaseScript", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-test-stage-"))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** Where the stage goes when df reports these free KB for /tmp and for the work disk. */
  const base = (tmpKb: number, workKb: number) => {
    const bin = path.join(dir, `bin-${tmpKb}-${workKb}`)
    fs.mkdirSync(bin, { recursive: true })
    const df = `#!/bin/sh\nlast=; for a; do last=$a; done\n[ "$last" = /tmp ] && f=${tmpKb} || f=${workKb}\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "fs 9999999 1 $f 1% /x"\n`
    fs.writeFileSync(path.join(bin, "df"), df, { mode: 0o755 })
    const script = `${stageBaseScript(path.join(dir, "root"))}\necho "$bybase"`
    return execFileSync("bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).toString().trim()
  }

  it("stages on whichever of /tmp and the work disk has more room", () => {
    expect(base(5_000_000, 100)).toBe("/tmp")
    expect(base(100, 5_000_000)).toBe(path.join(dir, "root", ".boxyard", "tmp"))
    // A tie stays on /tmp.
    expect(base(100, 100)).toBe("/tmp")
  })
})
