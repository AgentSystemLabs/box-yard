// Installing a version of Box Yard (launcher/install.mjs) from a real git repo on disk. git runs for real; npm and the
// SQLite check are stand-ins, so the test covers the clone, the steps, the folder swap and the error paths without a
// real `npm ci` and build.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { InstallError, installLatest, isInstalled, latestCommit, READY_MARKER, runLogged } from "../launcher/install.mjs"
import { layout } from "../launcher/paths.mjs"
import { tmpDir } from "./helpers.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim()

/** A bare repo whose main has one commit, like github.com/AgentSystemLabs/box-yard. */
function repo() {
  const root = tmpDir()
  const work = path.join(root, "work")
  const bare = path.join(root, "box-yard.git")
  fs.mkdirSync(work)
  git(work, "init", "-q", "-b", "main")
  fs.writeFileSync(path.join(work, "package.json"), '{ "name": "box-yard" }\n')
  git(work, "add", ".")
  git(work, "commit", "-q", "-m", "first")
  git(root, "clone", "-q", "--bare", work, bare)
  return { root, work, bare, sha: git(work, "rev-parse", "HEAD") }
}

type Run = typeof runLogged
type Call = { cmd: string; args: string[]; cwd: string }

/** git for real; npm "builds" by writing the server entry; `fail` makes one step exit 1. */
function fakeNpm(opts: { fail?: string; during?: (call: Call) => void } = {}) {
  const calls: Call[] = []
  const run: Run = async (cmd, args, o) => {
    if (cmd === "git") return runLogged(cmd, args, o)
    const call = { cmd, args, cwd: o.cwd }
    calls.push(call)
    opts.during?.(call)
    if (opts.fail && [cmd, ...args].join(" ").includes(opts.fail)) return { code: 1, tail: "npm ERR! gyp: make failed" }
    if (cmd === "npm" && args[0] === "run" && args[1] === "build") {
      fs.mkdirSync(path.join(o.cwd, "dist", "server", "server"), { recursive: true })
      fs.writeFileSync(path.join(o.cwd, "dist", "server", "server", "index.js"), "")
    }
    return { code: 0, tail: "" }
  }
  return { run, calls }
}

const steps = (calls: Call[]) => calls.map((c) => (c.cmd === "npm" ? `npm ${c.args.slice(0, 2).join(" ")}` : "sqlite check"))

describe("installLatest", () => {
  it("clones main, installs, builds, prunes, checks SQLite, then moves it into versions/<sha>", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    const npm = fakeNpm()
    const seen: string[] = []
    const out = await installLatest({ layout: L, repo: r.bare, run: npm.run, onStep: (s: string) => seen.push(s) })
    expect(out).toEqual({ sha: r.sha, dir: path.join(L.versions, r.sha), fresh: true })
    expect(seen).toEqual(["download", "dependencies", "build", "finish"])
    expect(steps(npm.calls)).toEqual(["npm ci --include=dev", "npm run build", "npm prune --omit=dev", "sqlite check"])
    // Every step ran in the staging folder, never in the finished one.
    expect(new Set(npm.calls.map((c) => path.basename(c.cwd)).map((n) => n.startsWith("staging-")))).toEqual(new Set([true]))
    expect(isInstalled(out.dir)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(out.dir, READY_MARKER), "utf8"))).toMatchObject({ sha: r.sha })
    // A git checkout, so the app knows its commit (vite.config.ts) and the next update can compare.
    expect(git(out.dir, "rev-parse", "HEAD")).toBe(r.sha)
    expect(fs.readdirSync(L.app).sort()).toEqual(["update.log", "versions"])
    expect(fs.readFileSync(L.updateLog, "utf8")).toMatch(/\$ git clone/)
  })

  it("doesn't build a commit that's already installed", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    await installLatest({ layout: L, repo: r.bare, run: fakeNpm().run })
    const again = fakeNpm()
    expect(await installLatest({ layout: L, repo: r.bare, run: again.run })).toMatchObject({ sha: r.sha, fresh: false })
    expect(again.calls).toEqual([])
  })

  it("installs main's newer commit beside the older one", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    await installLatest({ layout: L, repo: r.bare, run: fakeNpm().run })
    fs.writeFileSync(path.join(r.work, "README.md"), "new\n")
    git(r.work, "add", ".")
    git(r.work, "commit", "-q", "-m", "second")
    git(r.work, "push", "-q", r.bare, "main")
    const newer = git(r.work, "rev-parse", "HEAD")
    expect(await latestCommit({ repo: r.bare })).toBe(newer)
    expect(await installLatest({ layout: L, repo: r.bare, run: fakeNpm().run })).toMatchObject({ sha: newer, fresh: true })
    expect(fs.readdirSync(L.versions).sort()).toEqual([r.sha, newer].sort())
  })

  it("says which step failed, with npm's output and what to install, and leaves nothing behind", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    const err = await installLatest({ layout: L, repo: r.bare, run: fakeNpm({ fail: "npm ci" }).run, buildToolsHint: "sudo apt-get install -y python3 make g++" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstallError)
    expect(err).toMatchObject({ step: "Installing its dependencies", detail: "npm ERR! gyp: make failed" })
    expect((err as InstallError).hint).toMatch(/sudo apt-get install -y python3 make g\+\+/)
    expect(fs.readdirSync(L.versions)).toEqual([])
    expect(fs.readdirSync(L.app).filter((n) => n.startsWith("staging-"))).toEqual([])
  })

  it("names SQLite when the native driver doesn't load", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    const err = await installLatest({ layout: L, repo: r.bare, run: fakeNpm({ fail: "better-sqlite3" }).run }).catch((e: unknown) => e)
    expect(err).toMatchObject({ step: "Finishing up" })
    expect((err as InstallError).hint).toMatch(/SQLite driver \(better-sqlite3\) didn't load/)
    expect(fs.readdirSync(L.versions)).toEqual([])
  })

  it("says the download failed when the repo can't be reached", async () => {
    const L = layout(path.join(tmpDir(), ".boxyard"))
    const err = await installLatest({ layout: L, repo: path.join(tmpDir(), "missing.git"), run: fakeNpm().run }).catch((e: unknown) => e)
    expect(err).toMatchObject({ step: "Downloading the newest Box Yard" })
    expect((err as InstallError).hint).toMatch(/internet connection/)
    expect(await latestCommit({ repo: path.join(tmpDir(), "missing.git") })).toBeNull()
  })

  it("keeps another launcher's install of the same commit, which may be running", async () => {
    const r = repo()
    const L = layout(path.join(tmpDir(), ".boxyard"))
    const theirs = path.join(L.versions, r.sha)
    // While this one builds, another launcher finishes the same commit.
    const npm = fakeNpm({
      during: (call) => {
        if (call.args[0] !== "prune") return
        fs.mkdirSync(path.join(theirs, "dist", "server", "server"), { recursive: true })
        fs.writeFileSync(path.join(theirs, "dist", "server", "server", "index.js"), "theirs")
        fs.writeFileSync(path.join(theirs, READY_MARKER), "{}")
      },
    })
    expect(await installLatest({ layout: L, repo: r.bare, run: npm.run })).toMatchObject({ sha: r.sha, fresh: false })
    expect(fs.readFileSync(path.join(theirs, "dist", "server", "server", "index.js"), "utf8")).toBe("theirs")
    expect(fs.readdirSync(L.app).filter((n) => n.startsWith("staging-"))).toEqual([])
  })
})
