import { describe, expect, it } from "vitest"
import { ago, cloneDenyRules, DEFAULT_REPO_TUNING, repoViewResult, reposToRemove, type RepoSweepEntry } from "../server/captainRepo.js"
import { captainPrompt } from "../server/prompts.js"
import type { Project } from "../shared/types.js"

// A Captain's read-only clone of its repo (server/captainRepo.ts): what it says, what's denied, and which clones
// disk cleanup removes. The clone itself, with real git, is test/captain-repo.test.ts.

const MIN = 60_000
const DAY = 24 * 60 * MIN
const project = (repo: string | null) => ({ id: "prj_demo01", name: "demo", description: "", repo, baseBranch: "main" }) as unknown as Project

describe("a Captain's clone of its repo", () => {
  it("tells the Captain where the clone is, how fresh, and that it's read-only", () => {
    const now = Date.parse("2026-11-05T12:00:00Z")
    const ready = { kind: "ready" as const, path: "/d/captains/prj_demo01/repo", repo: "acme/demo", branch: "main", commit: "abc1234", committedAt: Date.parse("2026-11-04T09:30:00Z"), subject: "Fix it", syncedAt: now - 30_000, error: null }
    expect(repoViewResult(ready, now)).toEqual({
      status: "fresh",
      path: "/d/captains/prj_demo01/repo",
      repo: "acme/demo",
      branch: "main",
      commit: 'abc1234 "Fix it", committed 2026-11-04 09:30 UTC',
      synced: "just now",
      read_only: expect.stringMatching(/Read, Grep and Glob work here\. Nothing can edit, commit, push or run it/),
    })
    // A failed fetch leaves the last copy: it says so, and how old it is.
    const stale = repoViewResult({ ...ready, syncedAt: now - 3 * 60 * MIN, error: "fatal: unable to access" }, now)
    expect(stale).toMatchObject({ status: "stale", synced: "3 h ago" })
    expect(stale.stale).toMatch(/^Fetching origin\/main failed \(fatal: unable to access\), so this is the last copy, synced 3 h ago\./)
    expect(repoViewResult({ kind: "cloning", message: "Still cloning" }, now)).toEqual({ status: "cloning", message: "Still cloning" })
    expect([ago(5_000), ago(4 * MIN), ago(5 * 60 * MIN), ago(3 * DAY)]).toEqual(["just now", "4 min ago", "5 h ago", "3 days ago"])
  })

  it("denies every editing tool in the clone, as absolute-path permission rules", () => {
    expect(cloneDenyRules("/d/captains/prj_demo01/repo")).toEqual(["Edit(//d/captains/prj_demo01/repo/**)", "Write(//d/captains/prj_demo01/repo/**)"])
  })

  it("puts the clone in a Captain's prompt only when it has a repo and file tools", () => {
    const line = /Code questions: answer them yourself from your read-only clone of the repo at \/d\/captains\/prj_demo01\/repo, not with a task\. Call repo_clone first/
    const withClone = captainPrompt(project("acme/demo"), "Cody", undefined, false, "/d/captains/prj_demo01/repo")
    expect(withClone).toMatch(line)
    expect(withClone).toContain("create a task only for work that needs running code, builds or edits")
    // Codex (no file tools) and projects with no repo don't get it.
    expect(captainPrompt(project("acme/demo"), "Cody")).not.toMatch(/Code questions/)
    expect(captainPrompt(project(null), "Cody", undefined, false, "/d/captains/prj_demo01/repo")).not.toMatch(/Code questions/)
  })

  it("removes a deleted project's clone, an idle one, one on a low disk and a half-made one, never a busy one", () => {
    const now = 100 * DAY
    const entry = (projectId: string, e: Partial<RepoSweepEntry>): RepoSweepEntry => ({ projectId, live: true, busy: false, usedAt: now - MIN, leftover: false, ...e })
    const entries = [
      entry("prj_gone", { live: false }),
      entry("prj_idle", { usedAt: now - 15 * DAY }),
      entry("prj_hour", { usedAt: now - 2 * 60 * MIN }),
      entry("prj_used", {}),
      entry("prj_half", { usedAt: null, leftover: true }),
      entry("prj_busy", { live: false, busy: true }),
    ]
    const opts = { now, tuning: DEFAULT_REPO_TUNING }
    expect(reposToRemove(entries, { ...opts, lowDisk: false })).toEqual([
      { projectId: "prj_gone", why: "its project was deleted" },
      { projectId: "prj_idle", why: "unused for 15 days" },
      { projectId: "prj_half", why: "a clone was cut off before it finished" },
    ])
    // On a low disk, a clone unused for an hour goes too; one used a minute ago stays.
    expect(reposToRemove(entries, { ...opts, lowDisk: true }).map((r) => r.projectId)).toEqual(["prj_gone", "prj_idle", "prj_hour", "prj_half"])
  })
})
