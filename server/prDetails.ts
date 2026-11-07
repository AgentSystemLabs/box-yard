import type { Store } from "./store.js"
import { parsePrUrl, type PrInfo } from "./prs.js"
import { errorMessage } from "./util/retry.js"
import { PR_CHECKS_LISTED, type PrCheck, type PrDetails, type PrDetailsAnswer, type PrMergeState, type PrReviewState } from "../shared/prDetails.js"
import type { PrState } from "../shared/types.js"

/**
 * The task page's PR sheet (shared/prDetails.ts): one PR's checks, mergeability, review and files changed, asked from
 * GitHub when the page shows the PR and again at most every PR_DETAILS_FRESH_MS however many tabs ask. One GraphQL
 * query costs 1 point of the token's 5,000 an hour; a token PrTracker paused for its rate limit isn't asked at all.
 * The state it reads (merged, closed, ...) is saved like a poll's answer, so the header never disagrees with the sheet.
 */
export const PR_DETAILS_FRESH_MS = 20_000

export interface PrDetailsDeps {
  store: Store
  /** Null in mock mode: nothing asks GitHub. */
  fetch: typeof fetch | null
  token: (projectId: string) => string | null
  /** When a token's GitHub budget is paused until (PrTracker.tokenHealth), else 0. */
  pausedUntil?: (token: string) => number
  /** Save the PR's state as a poll would (PrTracker.apply). */
  apply?: (taskId: string, prUrl: string, info: PrInfo) => void
  now?: () => number
}

const QUERY = `query($o: String!, $n: String!, $p: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $p) {
  number title url state isDraft mergedAt mergedBy { login } baseRefName headRefName headRefOid
  mergeable mergeStateStatus reviewDecision changedFiles additions deletions
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }
} } }`

interface GqlContext {
  __typename?: string
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  context?: string
  state?: string
  targetUrl?: string | null
}

export interface GqlPrDetails {
  number?: number
  title?: string
  url?: string
  state?: "OPEN" | "CLOSED" | "MERGED"
  isDraft?: boolean
  mergedAt?: string | null
  mergedBy?: { login?: string } | null
  baseRefName?: string
  headRefName?: string
  headRefOid?: string | null
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  mergeStateStatus?: string
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null
  changedFiles?: number
  additions?: number
  deletions?: number
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: (GqlContext | null)[] | null } | null } | null } | null } | null)[] | null } | null
}

/** A check run (GitHub Actions and apps) or a commit status (older CI integrations) in four words. */
export function checkState(c: GqlContext): PrCheck["state"] {
  if (c.__typename === "StatusContext") return c.state === "SUCCESS" ? "passed" : c.state === "FAILURE" || c.state === "ERROR" ? "failed" : "pending"
  if (c.status !== "COMPLETED") return "pending"
  if (c.conclusion === "SUCCESS") return "passed"
  // GitHub counts neutral and skipped checks as passing; they're listed apart so "3 passed" means three ran green.
  if (c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED") return "skipped"
  return "failed"
}

const ORDER: Record<PrCheck["state"], number> = { failed: 0, pending: 1, passed: 2, skipped: 3 }

/** GitHub's mergeable and mergeStateStatus, as one answer. */
export function mergeState(pr: Pick<GqlPrDetails, "mergeable" | "mergeStateStatus">): PrMergeState {
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflicts"
  if (pr.mergeStateStatus === "BEHIND") return "behind"
  if (pr.mergeStateStatus === "BLOCKED") return "blocked"
  // UNSTABLE: mergeable, with a check that isn't required failing (the checks row says which).
  if (pr.mergeable === "MERGEABLE" || pr.mergeStateStatus === "CLEAN" || pr.mergeStateStatus === "UNSTABLE" || pr.mergeStateStatus === "HAS_HOOKS") return "clean"
  return "unknown"
}

const REVIEW: Record<string, PrReviewState> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "required" }

/** A check's link only when it's a web page: CI integrations set it, and the sheet opens it in a new tab. */
const webUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null)

/** GitHub's answer as the sheet's details; null when it isn't a pull request. */
export function toDetails(pr: GqlPrDetails, url: string): PrDetails | null {
  const state: PrState | null =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : null
  if (!state || typeof pr.number !== "number") return null
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null
  const all: PrCheck[] = (rollup?.contexts?.nodes ?? [])
    .filter((c): c is GqlContext => Boolean(c))
    .map((c) => ({ name: (c.__typename === "StatusContext" ? c.context : c.name) || "check", state: checkState(c), url: webUrl(c.__typename === "StatusContext" ? c.targetUrl : c.detailsUrl) }))
  const count = (s: PrCheck["state"]) => all.filter((c) => c.state === s).length
  const failed = count("failed")
  const pending = count("pending")
  const rollupState = rollup?.state
  const checks = {
    // The rollup covers checks past the first 100 too; the counts settle it when GitHub leaves it out.
    state:
      !rollup || (!all.length && !rollupState)
        ? ("none" as const)
        : rollupState === "FAILURE" || rollupState === "ERROR" || failed
          ? ("failing" as const)
          : rollupState === "PENDING" || rollupState === "EXPECTED" || pending
            ? ("pending" as const)
            : ("passing" as const),
    passed: count("passed"),
    failed,
    pending,
    skipped: count("skipped"),
    list: [...all].sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, PR_CHECKS_LISTED),
  }
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
  return {
    url: pr.url || url,
    number: pr.number,
    title: pr.title ?? "",
    state,
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
    mergedBy: pr.mergedBy?.login ?? null,
    base: pr.baseRefName ?? "",
    head: pr.headRefName ?? "",
    headSha: pr.headRefOid ?? null,
    checks,
    merge: state === "open" || state === "draft" ? mergeState(pr) : "clean",
    review: (pr.reviewDecision && REVIEW[pr.reviewDecision]) || "none",
    files: { changed: pr.changedFiles ?? 0, additions: pr.additions ?? 0, deletions: pr.deletions ?? 0 },
  }
}

/** Ask GitHub about one PR. Throws with a message for Cody when it can't. */
export async function fetchPrDetails(fetchFn: typeof fetch, token: string, url: string): Promise<PrDetails> {
  const pr = parsePrUrl(url)
  if (!pr) throw new Error("It isn't a github.com pull request URL.")
  let res: Response
  try {
    res = await fetchFn("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "box-yard" },
      body: JSON.stringify({ query: QUERY, variables: { o: pr.owner, n: pr.name, p: pr.number } }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    throw new Error(`GitHub didn't answer: ${errorMessage(err)}`)
  }
  if (res.status === 401) throw new Error("GitHub refused this project's token (HTTP 401).")
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub's rate limit for this project's token (HTTP ${res.status}). Try again in a minute.`)
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`)
  const body = (await res.json().catch(() => null)) as { data?: { repository?: { pullRequest?: GqlPrDetails | null } | null }; errors?: { type?: string; message?: string }[] } | null
  const found = body?.data?.repository?.pullRequest
  const details = found ? toDetails(found, url) : null
  if (details) return details
  const e = body?.errors?.[0]
  if (e?.type === "NOT_FOUND") throw new Error("This project's GitHub token can't see the pull request (or it doesn't exist).")
  throw new Error(e?.message ? `GitHub said: ${e.message}` : "GitHub returned no pull request.")
}

/** Answers per task, shared for PR_DETAILS_FRESH_MS (and while one is in flight), so open tabs ask GitHub once. */
export class PrDetailsSource {
  private readonly cache = new Map<string, { url: string; at: number; answer: Promise<PrDetailsAnswer> }>()
  private readonly now: () => number

  constructor(private readonly deps: PrDetailsDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  get(taskId: string): Promise<PrDetailsAnswer> {
    const row = this.deps.store.getTaskRow(taskId)
    if (!row) return Promise.resolve(this.fail("Task not found."))
    const url = row.pr_url
    if (!url) return Promise.resolve(this.fail("This task has no pull request."))
    const hit = this.cache.get(taskId)
    if (hit && hit.url === url && this.now() - hit.at < PR_DETAILS_FRESH_MS) return hit.answer
    const answer = this.ask(taskId, row.project_id, url)
    for (const [id, old] of this.cache) if (this.now() - old.at >= PR_DETAILS_FRESH_MS) this.cache.delete(id)
    this.cache.set(taskId, { url, at: this.now(), answer })
    return answer
  }

  private async ask(taskId: string, projectId: string, url: string): Promise<PrDetailsAnswer> {
    if (!this.deps.fetch) return this.fail("Box Yard doesn't ask GitHub in mock mode.")
    const token = this.deps.token(projectId)
    if (!token) return this.fail("This project has no GitHub token, so its PR's checks can't be read.")
    const paused = this.deps.pausedUntil?.(token) ?? 0
    if (this.now() < paused) return this.fail(`GitHub's rate limit is paused for this project's token until ${new Date(paused).toLocaleTimeString()}.`)
    try {
      const details = await fetchPrDetails(this.deps.fetch, token, url)
      this.deps.apply?.(taskId, url, { state: details.state, mergedAt: details.mergedAt, mergedBy: details.mergedBy, headSha: details.headSha })
      return { details, error: null, checkedAt: this.now() }
    } catch (err) {
      return this.fail(errorMessage(err))
    }
  }

  private fail(error: string): PrDetailsAnswer {
    return { details: null, error, checkedAt: null }
  }
}
