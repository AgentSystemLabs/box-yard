// The PR a review task reviews (shared/reviewPr.ts, Task.reviewPrUrl): read from its title and prompt, followed by the
// PR poll for its state alone, and never taken for the task's own PR.
import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { PrTracker, taskBranches, type PrChange } from "../server/prs.js"
import { detectReviewedPr, parsePrRef, reviewPrKey, samePr } from "../shared/reviewPr.js"
import type { TaskStatus } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const PR90 = "https://github.com/acme/site/pull/90"

describe("detectReviewedPr", () => {
  it("reads the PR a review title names: a URL, owner/repo#N, or PR #N for the project's repo", () => {
    expect(detectReviewedPr("Review PR #90 (Pick Latest runs the current model) and leave a verdict comment", "Read the diff.", "acme/site")).toBe(PR90)
    expect(detectReviewedPr("Security review of PR #38: allowing dot/hidden files", "", "acme/site")).toBe("https://github.com/acme/site/pull/38")
    expect(detectReviewedPr("Review acme/other#4", "", "acme/site")).toBe("https://github.com/acme/other/pull/4")
    expect(detectReviewedPr("Review https://github.com/Acme/Site/pull/90/files", "", null)).toBe("https://github.com/Acme/Site/pull/90")
    expect(detectReviewedPr("Re-review pull request #12", "", "acme/site")).toBe("https://github.com/acme/site/pull/12")
  })

  it("takes the one PR a review task's prompt names when the title names none", () => {
    expect(detectReviewedPr("Review the model picker change", `The PR is ${PR90}. Leave a verdict comment.`, "acme/site")).toBe(PR90)
    // Two different PRs and no review phrase: it can't tell which.
    expect(detectReviewedPr("Review the model picker change", "Compare PR #90 with PR #91.", "acme/site")).toBeNull()
  })

  it("reads a prompt that asks for a review of a PR", () => {
    expect(detectReviewedPr("Verdict on the picker", `Please review ${PR90} and leave a comment.`, "acme/site")).toBe(PR90)
    expect(detectReviewedPr("Verdict", "Context: PR #12 landed last week. Now review PR #90 carefully.", "acme/site")).toBe(PR90)
  })

  it("never takes a PR a task fixes, rebases or merges for one it reviews", () => {
    expect(detectReviewedPr("Fix merge conflict on PR #1073", "Rebase https://github.com/acme/site/pull/1073 on main.", "acme/site")).toBeNull()
    expect(detectReviewedPr("Merge PR #90", "", "acme/site")).toBeNull()
    expect(detectReviewedPr("Address the reviewer's comments", "The reviewed PR #90 needs fixes.", "acme/site")).toBeNull()
    expect(detectReviewedPr("Build the cart page", "Ready for review when done.", "acme/site")).toBeNull()
  })

  it("needs the project's repo for a bare PR #N", () => {
    expect(detectReviewedPr("Review PR #90", "", null)).toBeNull()
  })
})

describe("parsePrRef and samePr", () => {
  it("reads a URL, owner/repo#N, #N, N and PR #N, and nothing else", () => {
    expect(parsePrRef(PR90, null)).toBe(PR90)
    expect(parsePrRef(`${PR90}#discussion_r1`, null)).toBe(PR90)
    expect(parsePrRef("acme/site#90", null)).toBe(PR90)
    for (const ref of ["#90", "90", "PR #90", "pr#90", "pull request #90", " #90 "]) expect(parsePrRef(ref, "acme/site")).toBe(PR90)
    expect(parsePrRef("#90", null)).toBeNull()
    expect(parsePrRef("https://github.com/acme/site/issues/90", "acme/site")).toBeNull()
    expect(parsePrRef("the picker PR", "acme/site")).toBeNull()
    expect(parsePrRef("0", "acme/site")).toBeNull()
  })

  it("compares PRs by repo and number in any case", () => {
    expect(samePr("https://github.com/Acme/Site/pull/90/files", PR90)).toBe(true)
    expect(samePr(PR90, "https://github.com/acme/site/pull/91")).toBe(false)
    expect(samePr(null, null)).toBe(false)
    expect(reviewPrKey(PR90)).toBe("acme/site/90")
  })
})

type Gh = { state: "OPEN" | "CLOSED" | "MERGED"; headRefName?: string; mergedBy?: { login: string } | null }

/** A fake GitHub GraphQL endpoint: PRs by "owner/name#number" and PRs on a branch, with a log of what was asked. */
function fakeGithub() {
  const prs = new Map<string, Gh>()
  const onBranch: { number: number; headRefName: string }[] = []
  const asked: string[][] = []
  const fetch = (async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, string | number> }
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
    const keys: string[] = []
    for (const k of Object.keys(variables)) {
      let m = /^p(\d+)$/.exec(k)
      if (m) {
        const key = `${variables[`o${m[1]}`]}/${variables[`n${m[1]}`]}#${variables[k]}`
        keys.push(key)
        data[`p${m[1]}`] = prs.has(key) ? { pullRequest: prs.get(key) } : null
      }
      m = /^b(\d+)$/.exec(k)
      if (m) {
        keys.push(`@${variables[k]}`)
        const nodes = onBranch
          .filter((p) => p.headRefName === variables[k])
          .map((p) => ({ url: `https://github.com/acme/site/pull/${p.number}`, state: "OPEN", isDraft: false, createdAt: new Date().toISOString(), headRefName: p.headRefName, headRefOid: "abc", headRepository: { nameWithOwner: "acme/site" } }))
        data[`d${m[1]}`] = { nameWithOwner: "acme/site", pullRequests: { nodes }, parent: null }
      }
    }
    asked.push(keys)
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof globalThis.fetch
  return { prs, onBranch, asked, fetch }
}

function setup() {
  const store = new Store(openDb(tmpDir()))
  const gh = fakeGithub()
  const changes: PrChange[] = []
  const reviews: string[] = []
  const project = store.createProject({ name: "site" })
  store.updateProject(project.id, { repo: "https://github.com/acme/site" })
  const tracker = new PrTracker({ store, token: () => "tok", fetch: gh.fetch, onChange: (c) => changes.push(c), onReview: (id) => reviews.push(id) })
  /** A review task of PR #n, resting in `status`, on its own branch. */
  const review = (n: number, status: TaskStatus = "idle", extra: Parameters<Store["updateTask"]>[1] = {}) => {
    const t = store.createTask({ projectId: project.id, title: `Review PR #${n}`, prompt: "p", branch: `review-${n}`, reviewPrUrl: `https://github.com/acme/site/pull/${n}` })
    store.updateTask(t.id, { status, ...extra }, { quiet: true })
    return t.id
  }
  return { store, gh, changes, reviews, tracker, review, project }
}

describe("following a reviewed PR", () => {
  it("asks about it in the same batch as tasks' own PRs, and saves its state and head branch only", async () => {
    const { store, gh, tracker, review, changes, reviews, project } = setup()
    const own = store.createTask({ projectId: project.id, title: "Own", prompt: "p" })
    store.updateTask(own.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/5" }, { quiet: true })
    const id = review(90)
    gh.prs.set("acme/site#5", { state: "OPEN" })
    gh.prs.set("acme/site#90", { state: "OPEN", headRefName: "picker" })
    await tracker.pollAll()
    expect(gh.asked).toEqual([["acme/site#5", "acme/site#90"]])
    expect(store.getTask(id)).toMatchObject({ status: "idle", prUrl: null, prState: null, reviewPrUrl: PR90, reviewPrState: "open" })
    expect(store.getTaskRow(id)!.review_pr_head).toBe("picker")
    expect(reviews).toEqual([id])
    expect(changes.map((c) => c.taskId)).toEqual([own.id])
    expect(tracker.reviewCheck(id).checkedAt).not.toBeNull()
    // Nothing moved: no second save.
    await tracker.pollAll()
    expect(reviews).toEqual([id])
  })

  it("a merged or closed reviewed PR never moves its task: no done, no pr_ready drop, no change, no notification", async () => {
    const { store, gh, tracker, review, changes } = setup()
    const idle = review(1, "idle")
    const ready = review(2, "pr_ready")
    gh.prs.set("acme/site#1", { state: "MERGED", mergedBy: { login: "cody" } })
    gh.prs.set("acme/site#2", { state: "CLOSED" })
    await tracker.pollAll()
    expect(store.getTask(idle)).toMatchObject({ status: "idle", reviewPrState: "merged", prState: null })
    expect(store.getTask(ready)).toMatchObject({ status: "pr_ready", reviewPrState: "closed" })
    expect(changes).toEqual([])
    expect(store.listNotifications()).toEqual([])
    // Final: never asked about again.
    const before = gh.asked.length
    await tracker.pollAll()
    expect(gh.asked.length).toBe(before)
  })

  it("stops asking for an old done review's PR, but keeps a recent one's", async () => {
    const { store, gh, tracker, review } = setup()
    const old = review(3, "done", { lastActiveAt: Date.now() - 30 * 24 * 60 * 60_000 })
    const recent = review(4, "done")
    gh.prs.set("acme/site#3", { state: "OPEN" })
    gh.prs.set("acme/site#4", { state: "OPEN" })
    await tracker.pollAll()
    expect(gh.asked).toEqual([["acme/site#4"]])
    expect(store.getTask(old)!.reviewPrState).toBeNull()
    expect(store.getTask(recent)!.reviewPrState).toBe("open")
  })

  it("refresh() asks about a new review's PR soon", async () => {
    const { store, gh, tracker, review } = setup()
    const id = review(7)
    gh.prs.set("acme/site#7", { state: "OPEN", headRefName: "x" })
    tracker.refresh(id, 1)
    await new Promise((r) => setTimeout(r, 30))
    await tracker.pollAll() // waits behind the refresh's request
    expect(gh.asked[0]).toEqual(["acme/site#7"])
    expect(store.getTask(id)!.reviewPrState).toBe("open")
  })

  it("ignores an answer for a reviewed PR the task has since changed", () => {
    const { store, tracker, review, reviews } = setup()
    const id = review(8)
    tracker.applyReview(id, "https://github.com/acme/site/pull/99", { state: "merged", mergedAt: null, mergedBy: null })
    expect(store.getTask(id)!.reviewPrState).toBeNull()
    expect(reviews).toEqual([])
  })
})

describe("a reviewed PR is never the task's own (lookup by branch)", () => {
  it("a reviewer that checked out the reviewed PR's branch doesn't get that PR, even before its head branch is known", async () => {
    const { store, gh, tracker, review, changes } = setup()
    // Its turn-end push found the workspace on the PR's branch (gh pr checkout 90), whose head Box Yard doesn't know yet.
    const id = review(90, "idle", { pushState: { status: "pushed", at: Date.now(), branch: "picker", head: "abc", wip: null, reason: null } })
    gh.onBranch.push({ number: 90, headRefName: "picker" })
    expect(await tracker.discover()).toBe(0)
    expect(store.getTask(id)).toMatchObject({ status: "idle", prUrl: null, reviewPrUrl: PR90 })
    expect(changes).toEqual([])
  })

  it("once the head branch is known, it isn't looked up at all, and the task's own branch still is", async () => {
    const { store, gh, tracker, review } = setup()
    const id = review(90, "idle", { reviewPrHead: "picker", pushState: { status: "pushed", at: Date.now(), branch: "picker", head: "abc", wip: null, reason: null } })
    gh.onBranch.push({ number: 90, headRefName: "picker" }, { number: 91, headRefName: "review-90" })
    expect(await tracker.discover()).toBe(1)
    expect(gh.asked).toEqual([["@review-90"]])
    // A PR on its own branch is its own, shown next to the one it reviews.
    expect(store.getTask(id)).toMatchObject({ status: "pr_ready", prUrl: "https://github.com/acme/site/pull/91", reviewPrUrl: PR90 })
  })

  it("taskBranches leaves out the reviewed PR's head branch", () => {
    const push = JSON.stringify({ status: "pushed", at: 1, branch: "picker", head: "abc", wip: null, reason: null })
    expect(taskBranches({ branch: "own", push_state_json: push, review_pr_head: "picker" }, "main")).toEqual(["own"])
    expect(taskBranches({ branch: "own", push_state_json: push, review_pr_head: null }, "main")).toEqual(["picker", "own"])
  })
})
