// A task's pull request as the task page's PR sheet shows it: checks, mergeability, review and files changed, read
// from GitHub on demand (server/prDetails.ts, GET /api/tasks/:id/pr). Nothing here is stored.
import type { PrState } from "./types.js"

/** All of the head commit's checks together: GitHub's rollup. `none`: the commit has no checks. */
export type PrChecksState = "passing" | "failing" | "pending" | "none"

/**
 * Whether GitHub would merge it now. `conflicts`: its branch conflicts with the base. `behind`: the base moved on and
 * branch rules want it up to date. `blocked`: branch rules wait on a review or a required check. `unknown`: GitHub
 * is still working it out (it does after every push).
 */
export type PrMergeState = "clean" | "conflicts" | "behind" | "blocked" | "unknown"

/** GitHub's review decision. `none`: the repo doesn't require a review. */
export type PrReviewState = "approved" | "changes_requested" | "required" | "none"

/** One check run or commit status on the head commit. */
export interface PrCheck {
  name: string
  state: "passed" | "failed" | "pending" | "skipped"
  /** Its log or details page on GitHub (or the CI's own site). */
  url: string | null
}

export interface PrDetails {
  url: string
  number: number
  title: string
  state: PrState
  mergedAt: number | null
  mergedBy: string | null
  /** Branch names: it merges `head` into `base`. */
  base: string
  head: string
  headSha: string | null
  checks: {
    state: PrChecksState
    passed: number
    failed: number
    pending: number
    skipped: number
    /** Failing first, then running, then the rest; at most PR_CHECKS_LISTED. */
    list: PrCheck[]
  }
  merge: PrMergeState
  review: PrReviewState
  files: { changed: number; additions: number; deletions: number }
  /**
   * Comments written since the PR was last opened from Box Yard (shared/prComments.ts says what counts), and when
   * that was (null: never). Null for a merged or closed PR, and with Settings › New PR comments off.
   */
  comments: { count: number; viewedAt: number | null } | null
}

/** GET /api/tasks/:id/pr. Exactly one of `details` and `error` is set. */
export interface PrDetailsAnswer {
  details: PrDetails | null
  /** Why there are no details (no PR, no GitHub token, GitHub didn't answer, ...), in words for Cody. */
  error: string | null
  /** When GitHub answered, or null. */
  checkedAt: number | null
}

export const PR_CHECKS_LISTED = 20
