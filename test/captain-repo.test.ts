import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { CaptainRepo, DEFAULT_REPO_TUNING, repoViewResult, type GitAuth, type RepoTuning } from "../server/captainRepo.js"
import { GITHUB_HELPER } from "../server/gitShare.js"
import type { Project } from "../shared/types.js"
import { tmpDir, waitFor } from "./helpers.js"

// A Captain's read-only clone of its repo (server/captainRepo.ts) with real git: made on first use, fetched at most
// once a throttle, the last copy kept with its age when a fetch fails, and the token kept out of everything it writes.
// Origins are bare repos served over file://.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin with a commit on main (and one on dev), and a seed clone to push more from. */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  const commit = (file: string, text: string, branch = "main") => {
    git(seed, "checkout", "-q", "-B", branch)
    fs.writeFileSync(path.join(seed, file), text)
    git(seed, "add", ".")
    git(seed, "commit", "-qm", `${file}: ${text.trim()}`)
    git(seed, "push", "-q", bare, branch)
    return git(seed, "rev-parse", "--short", "HEAD")
  }
  commit("README.md", "hello from v1\n")
  commit("DEV.md", "dev only\n", "dev")
  git(seed, "checkout", "-q", "main")
  return { url: `file://${bare}`, bare, commit }
}

const repos: CaptainRepo[] = []
afterEach(async () => {
  for (const r of repos.splice(0)) await r.remove()
})

function captainRepo(o: { url: string | null; base?: string; tuning?: Partial<RepoTuning>; auth?: GitAuth | null }) {
  const home = tmpDir("box-yard-captain-")
  let clock = Date.parse("2026-11-05T12:00:00Z")
  const p = { id: "prj_demo01", name: "demo", repo: o.url, baseBranch: o.base ?? "main" } as unknown as Project
  const repo = new CaptainRepo({ home, project: () => p, auth: () => o.auth ?? null, tuning: { ...DEFAULT_REPO_TUNING, ...o.tuning }, now: () => clock })
  repos.push(repo)
  return {
    repo,
    home,
    project: p,
    tick: (ms: number) => (clock += ms),
    now: () => clock,
    read: (file: string) => fs.readFileSync(path.join(repo.dir, file), "utf8"),
  }
}

describe("a Captain's clone of its repo", () => {
  it("is made on first use, as a partial clone of the base branch alone, and fetched at most once a throttle", async () => {
    const o = origin()
    const c = captainRepo({ url: o.url })
    // Nothing until it's used.
    expect(fs.existsSync(c.repo.dir)).toBe(false)
    expect(c.repo.brief()).toBeNull()

    const first = await c.repo.open()
    expect(first).toMatchObject({ kind: "ready", path: path.join(c.home, "repo"), branch: "main", error: null, subject: "README.md: hello from v1" })
    expect(c.read("README.md")).toBe("hello from v1\n")
    expect(git(c.repo.dir, "config", "remote.origin.partialclonefilter")).toBe("blob:none")
    expect(git(c.repo.dir, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/main:refs/remotes/origin/main")
    expect(fs.existsSync(path.join(c.repo.dir, "DEV.md"))).toBe(false)
    expect(git(c.repo.dir, "tag")).toBe("")
    expect(c.repo.brief()).toMatchObject({ syncedAt: c.now(), error: null })

    // A new commit on origin: within the throttle the clone stays as it is; after it, it's fetched and reset.
    const v2 = o.commit("README.md", "hello from v2\n")
    c.tick(30_000)
    expect(await c.repo.open()).toMatchObject({ kind: "ready", commit: first.kind === "ready" ? first.commit : "" })
    expect(c.read("README.md")).toBe("hello from v1\n")
    c.tick(30_000)
    expect(await c.repo.open()).toMatchObject({ kind: "ready", commit: v2, syncedAt: c.now(), error: null })
    expect(c.read("README.md")).toBe("hello from v2\n")
  })

  it("resets to origin's copy, so a change made in it doesn't stay", async () => {
    const o = origin()
    const c = captainRepo({ url: o.url, tuning: { throttleMs: 0 } })
    await c.repo.open()
    fs.writeFileSync(path.join(c.repo.dir, "README.md"), "changed here\n")
    fs.writeFileSync(path.join(c.repo.dir, "stray.txt"), "left here\n")
    await c.repo.open()
    expect(c.read("README.md")).toBe("hello from v1\n")
    expect(fs.existsSync(path.join(c.repo.dir, "stray.txt"))).toBe(false)
  })

  it("answers from the last copy, with its age, when a fetch fails, and catches up once origin is back", async () => {
    const o = origin()
    const c = captainRepo({ url: o.url, tuning: { throttleMs: 60_000 } })
    await c.repo.open()
    const synced = c.now()
    o.commit("README.md", "hello from v2\n")
    // Origin goes away.
    fs.renameSync(o.bare, `${o.bare}.away`)
    c.tick(3 * 60 * 60_000)
    const stale = await c.repo.open()
    expect(stale).toMatchObject({ kind: "ready", syncedAt: synced, error: expect.stringMatching(/\S/) })
    expect(c.read("README.md")).toBe("hello from v1\n")
    const said = repoViewResult(stale, c.now())
    expect(said).toMatchObject({ status: "stale", synced: "3 h ago" })
    expect(said.stale).toMatch(/^Fetching origin\/main failed \(.+\), so this is the last copy, synced 3 h ago\. Say how old it is/)
    expect(c.repo.brief()?.error).toBeTruthy()

    // Within the throttle it doesn't try again; after it, the fetch works and the error is gone.
    fs.renameSync(`${o.bare}.away`, o.bare)
    c.tick(10_000)
    expect(await c.repo.open()).toMatchObject({ syncedAt: synced, error: expect.stringMatching(/\S/) })
    c.tick(60_000)
    expect(await c.repo.open()).toMatchObject({ syncedAt: c.now(), error: null })
    expect(c.read("README.md")).toBe("hello from v2\n")
  })

  it("says why a clone failed, and tries again only after the throttle", async () => {
    const o = origin()
    const c = captainRepo({ url: `${o.url}.missing` })
    const failed = await c.repo.open()
    expect(failed).toMatchObject({ kind: "failed", message: expect.stringMatching(/^Cloning file:\/\/.+\.missing failed: .+/) })
    expect(fs.existsSync(c.repo.dir)).toBe(false)
    expect(fs.existsSync(path.join(c.home, "repo.cloning"))).toBe(false)
    expect(await c.repo.open()).toMatchObject({ kind: "failed", message: expect.stringMatching(/failed just now: /) })
    // The project's repo is fixed: once the throttle is past, it clones.
    c.project.repo = o.url
    c.tick(60_000)
    expect(await c.repo.open()).toMatchObject({ kind: "ready" })
  })

  it("is made again for another repo or base branch", async () => {
    const o = origin()
    const c = captainRepo({ url: o.url })
    await c.repo.open()
    c.project.baseBranch = "dev"
    expect(c.repo.brief()).toBeNull()
    expect(await c.repo.open()).toMatchObject({ kind: "ready", branch: "dev", subject: "DEV.md: dev only" })
    expect(c.read("DEV.md")).toBe("dev only\n")
    expect(git(c.repo.dir, "config", "--get-all", "remote.origin.fetch")).toBe("+refs/heads/dev:refs/remotes/origin/dev")
  })

  it("has no clone to read for a project with no repo", async () => {
    const c = captainRepo({ url: null })
    expect(await c.repo.open()).toEqual({ kind: "none", message: "This project has no repository, so there's no code to read." })
    expect(fs.existsSync(c.repo.dir)).toBe(false)
  })

  it("says it's still cloning when a clone takes long, shares it between calls, and can be removed mid-clone", async () => {
    const o = origin()
    const c = captainRepo({ url: o.url, tuning: { waitMs: 0 } })
    const [a, b] = await Promise.all([c.repo.open(), c.repo.open()])
    expect(a).toMatchObject({ kind: "cloning", message: expect.stringMatching(/^Still cloning .+ It goes on: call repo_clone again in a minute\.$/) })
    expect(b.kind).toBe("cloning")
    await waitFor(() => !c.repo.busy, "the clone")
    expect(await c.repo.open()).toMatchObject({ kind: "ready" })

    // Removing it while a new clone is being made stops that git and leaves nothing behind.
    await c.repo.remove()
    expect(fs.existsSync(c.repo.dir)).toBe(false)
    expect((await c.repo.open()).kind).toBe("cloning")
    await c.repo.remove()
    expect(c.repo.busy).toBe(false)
    expect(fs.readdirSync(c.home).filter((n) => n.startsWith("repo"))).toEqual([])
  })

  it("runs none of the project's hooks while cloning", async () => {
    const o = origin()
    // A git template that would run a post-checkout hook on clone.
    const template = tmpDir("box-yard-template-")
    const marker = path.join(tmpDir("box-yard-marker-"), "ran")
    fs.mkdirSync(path.join(template, "hooks"))
    fs.writeFileSync(path.join(template, "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    const c = captainRepo({ url: o.url, auth: { env: {}, config: [`init.templateDir=${template}`] } })
    expect(await c.repo.open()).toMatchObject({ kind: "ready" })
    expect(fs.existsSync(path.join(c.repo.dir, ".git", "hooks", "post-checkout"))).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it("withholds the project's GitHub token from another origin, and never stores or logs it", async () => {
    const token = "ghp_captainclonetoken123"
    const seen: string[] = []
    const env = { GITHUB_TOKEN: token, GH_TOKEN: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_ASKPASS: "/usr/bin/false" }
    // An unrelated HTTP origin that challenges for authentication must never receive the GitHub token.
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? "")
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end("no")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/demo.git`
      const c = captainRepo({ url, auth: { env, config: ["credential.helper=", `credential.helper=${GITHUB_HELPER}`] } })
      const failed = await c.repo.open()
      expect(failed.kind).toBe("failed")
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((authorization) => authorization === "")).toBe(true)
      expect(JSON.stringify(failed)).not.toContain(token)
      expect(JSON.stringify(failed)).not.toContain("x-access-token")
    } finally {
      server.close()
    }

    // A clone that worked keeps no token anywhere in its folder.
    const o = origin()
    const c = captainRepo({ url: o.url, auth: { env, config: [`credential.helper=${GITHUB_HELPER}`] } })
    expect(await c.repo.open()).toMatchObject({ kind: "ready" })
    expect(git(c.repo.dir, "remote", "get-url", "origin")).toBe(o.url)
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.isFile() ? [path.join(d, e.name)] : []))
    for (const f of files(path.join(c.repo.dir, ".git")).filter((f) => !f.includes(`${path.sep}objects${path.sep}`))) expect(fs.readFileSync(f, "utf8"), f).not.toContain(token)
  })
})
