import type { Store, TaskRow } from "./store.js"
import { RateLimited, backoffMs, githubGraphql, parsePrUrl, type TokenHealth } from "./prs.js"
import { errorMessage } from "./util/retry.js"
import { countNewComments, prViewKey, type PrRemark } from "../shared/prComments.js"

/**
 * New comments on open pull requests since their owner last opened each PR from Box Yard (shared/prComments.ts says
 * what counts). A background round asks GitHub every Settings › New PR comments minutes (5 by default, 0 = off) and
 * saves each task's count, which reaches the UI as an ordinary task update over the event stream: the browser never
 * asks GitHub and never waits for this.
 *
 * A round is two steps per token, one request at a time:
 *   1. A probe: one query for up to PROBE_BATCH PRs that reads each PR's `updatedAt` only. GraphQL has no ETags, so
 *      this is its conditional request: 1 point however many PRs.
 *   2. The comments themselves, DETAIL_BATCH PRs a query, only for the PRs whose `updatedAt` moved since the last
 *      answer, plus those whose count isn't 0 (resolving a thread lowers the count without moving `updatedAt`).
 *
 * Rate limits. GitHub gives a token 5,000 GraphQL points an hour and prices a query at (connections it may have to
 * read) / 100, at least 1. Reading a PR's comments is 53 of those (conversation, reviews, threads, then each of
 * up to 50 threads' comments), so a full batch of 20 PRs is about 11 points and the probe is 1. At the default of
 * 5 minutes, 100 open PRs cost 12 points an hour to probe, plus about half a point for each PR that changed that
 * round: a busy day is well under 100 points an hour, 2% of the budget, and even every one of the 100 PRs
 * changing every round is 53 × 12 = 636, 13%. Each token stops for the hour when fewer than COMMENTS_RATE_FLOOR
 * points are left (well before PrTracker's own floor, so the PR states keep coming), honours a pause PrTracker or
 * GitHub set, and backs off exponentially after errors. Merged and closed PRs are never asked about.
 *
 * The task page refreshes its own PR sooner: its PR sheet asks GitHub when the task opens and once a minute while it
 * stays open (server/prDetails.ts, at most every 20 s however many tabs), and that same query carries the comments
 * (PR_ACTIVITY_FIELDS, still 1 point), which `ingest` saves like a round's answer.
 */

/** PRs per probe query (step 1): 1 point. */
export const PR_COMMENTS_PROBE_BATCH = 100
/** PRs per comments query (step 2): about 11 points. */
export const PR_COMMENTS_DETAIL_BATCH = 20
/** Comment rounds stop for a token with fewer points left than this, until its budget resets. */
export const COMMENTS_RATE_FLOOR = 1000
/** The first round after the server starts waits this long, so the PR states are read first. */
export const PR_COMMENTS_START_DELAY_MS = 5_000

/** What's read of one PR to count its comments; shared with the PR sheet's query (server/prDetails.ts). */
export const PR_ACTIVITY_FIELDS = `updatedAt author { login }
  comments(last: 100) { nodes { createdAt author { login } } }
  reviews(last: 50) { nodes { state submittedAt body author { login } } }
  reviewThreads(last: 50) { nodes { isResolved comments(last: 10) { nodes { createdAt author { login } } } } }`

type GqlAuthor = { login?: string } | null
type GqlNodes<T> = { nodes?: (T | null)[] | null } | null

export interface GqlPrActivity {
  state?: string
  updatedAt?: string | null
  author?: GqlAuthor
  comments?: GqlNodes<{ createdAt?: string; author?: GqlAuthor }>
  reviews?: GqlNodes<{ state?: string; submittedAt?: string | null; body?: string | null; author?: GqlAuthor }>
  reviewThreads?: GqlNodes<{ isResolved?: boolean; comments?: GqlNodes<{ createdAt?: string; author?: GqlAuthor }> }>
}

/** A PR's comments as GitHub answered: what counts (shared/prComments.ts), before anyone's view of it is applied. */
export interface PrActivity {
  /** GitHub's `updatedAt`, as it wrote it: the next probe compares against it. */
  updatedAt: string | null
  /** The PR author's login: their own comments don't count. */
  author: string | null
  remarks: PrRemark[]
}

const nodes = <T>(list: GqlNodes<T> | undefined): T[] => (list?.nodes ?? []).filter((n): n is T => n !== null && n !== undefined)

/** GitHub's answer about one PR as what counts: conversation comments, reviews with a summary, comments in unresolved threads. */
export function toActivity(pr: GqlPrActivity): PrActivity {
  const remarks: PrRemark[] = []
  const add = (when: string | null | undefined, author: GqlAuthor | undefined) => {
    const at = when ? Date.parse(when) : NaN
    if (Number.isFinite(at)) remarks.push({ at, author: author?.login ?? null })
  }
  for (const c of nodes(pr.comments)) add(c.createdAt, c.author)
  // A review still being written (PENDING) is its author's alone; one without a summary is only its inline comments.
  for (const r of nodes(pr.reviews)) if (r.state !== "PENDING" && r.body?.trim()) add(r.submittedAt, r.author)
  for (const t of nodes(pr.reviewThreads)) if (!t.isResolved) for (const c of nodes(t.comments)) add(c.createdAt, c.author)
  return { updatedAt: pr.updatedAt ?? null, author: pr.author?.login ?? null, remarks }
}

/** A PR's count, and the view it was counted from. */
export interface PrCommentCount {
  count: number
  viewedAt: number | null
}

export interface PrCommentsDeps {
  store: Store
  /** Null in mock mode: nothing asks GitHub. */
  fetch: typeof fetch | null
  /** The GitHub token for a project's PRs, or null to leave them alone. */
  token: (projectId: string) => string | null
  /** PrTracker's health for a token: its rate-limit pause holds here too, and a stop GitHub orders here holds there. */
  health?: (token: string) => TokenHealth
  /** Milliseconds between rounds (Settings › New PR comments); 0 turns the count off. */
  intervalMs: () => number
  /** A task's count changed and is saved: tell the UI. */
  onCount?: (taskId: string) => void
  now?: () => number
  startDelayMs?: number
  log?: (message: string) => void
}

interface Target {
  key: string
  owner: string
  name: string
  number: number
}

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/** `$o0: String!, ...` and one aliased `p0: repository { pullRequest { <fields> } }` per PR, like PrTracker's batch. */
function batchQuery(prs: Target[], head: string, fields: string) {
  const variables: Record<string, string | number> = {}
  const defs: string[] = []
  const parts: string[] = []
  prs.forEach((pr, i) => {
    Object.assign(variables, { [`o${i}`]: pr.owner, [`n${i}`]: pr.name, [`p${i}`]: pr.number })
    defs.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`)
    parts.push(`p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { ${fields} } }`)
  })
  return { query: `query(${defs.join(", ")}) { rateLimit { cost remaining resetAt } ${head} ${parts.join(" ")} }`, variables }
}

type BatchData = Record<string, { pullRequest?: GqlPrActivity | null } | null> & { viewer?: { login?: string } | null }

export class PrCommentTracker {
  private readonly store: Store
  private readonly deps: PrCommentsDeps
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  /** The interval the timer runs on now (0: off), to tell a changed setting from any other save. */
  private armed = 0
  private chain: Promise<unknown> = Promise.resolve()
  /** GraphQL requests sent, and the points GitHub said they cost. */
  requests = 0
  points = 0
  /** Per PR (prViewKey): GitHub's `updatedAt` at the last answer and the count saved from it. In memory only. */
  private readonly seen = new Map<string, { updatedAt: string | null; count: number }>()
  /** Per token: its own error backoff and low-budget pause (PrTracker keeps polling states below this floor). */
  private readonly health = new Map<string, TokenHealth>()

  constructor(deps: PrCommentsDeps) {
    this.deps = deps
    this.store = deps.store
    this.now = deps.now ?? (() => Date.now())
  }

  /** Start the rounds (unless the setting is off); the first one shortly after, then every interval. */
  start() {
    this.stopped = false
    this.armed = this.deps.intervalMs()
    if (this.armed) this.arm(this.deps.startDelayMs ?? PR_COMMENTS_START_DELAY_MS)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Settings were saved. A new interval takes over from now; turning the count on asks right away; turning it off
   * stops the rounds and forgets every count, so no row shows a number nothing keeps current.
   */
  reschedule() {
    const next = this.deps.intervalMs()
    if (next === this.armed) return
    const was = this.armed
    this.armed = next
    if (!next) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.seen.clear()
      for (const id of this.store.clearPrNewComments()) this.deps.onCount?.(id)
      return
    }
    if (!this.stopped) this.arm(was ? next : 0)
  }

  /** The computer woke from sleep: forget the error backoffs its failed requests piled up, and ask soon. */
  wake() {
    for (const h of this.health.values()) {
      h.failures = 0
      h.retryAt = 0
    }
    if (this.armed) this.arm(this.deps.startDelayMs ?? PR_COMMENTS_START_DELAY_MS)
  }

  private arm(delay: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pollAll()
        .catch(() => {})
        .finally(() => this.armed && this.arm(this.armed))
    }, delay)
    this.timer.unref?.()
  }

  /** One round over every open PR. */
  pollAll(): Promise<void> {
    return this.exclusive(() => this.round(this.store.listOpenPrRows(), true))
  }

  /** A token's own health here (a fresh record for a token not used yet). */
  tokenHealth(token: string): TokenHealth {
    let h = this.health.get(token)
    if (!h) this.health.set(token, (h = { failures: 0, retryAt: 0, pausedUntil: 0 }))
    return h
  }

  /**
   * A PR link was clicked in Box Yard: remember when, and zero its count on every task that has it without asking
   * GitHub (everything written so far counts as read). Later answers count from this view on. Null when `url` isn't a
   * github.com pull request.
   */
  viewed(url: string): number | null {
    const key = prViewKey(url)
    if (!key) return null
    const rows = this.store.listOpenPrRows().filter((r) => prViewKey(r.pr_url) === key)
    // "#12" in text links to /issues/12, which is the PR when a task has it; any other issue isn't a PR to track.
    if (!rows.length && !/\/pull\/\d+/i.test(url)) return null
    const at = this.now()
    this.store.recordPrView(key, at)
    const seen = this.seen.get(key)
    if (seen) seen.count = 0
    for (const row of rows) if (row.pr_new_comments) this.save(row, 0)
    return at
  }

  /**
   * GitHub answered about one PR (a round here, or the task page's PR sheet): count what was written since its last
   * view, as of now (a view recorded while the request was out counts), and save it on every task that has the PR.
   * Null while the count is off.
   */
  ingest(prUrl: string, activity: PrActivity, viewer: string | null, rows: TaskRow[] = this.store.listOpenPrRows()): PrCommentCount | null {
    const key = prViewKey(prUrl)
    if (!key || !this.deps.intervalMs()) return null
    const viewedAt = this.store.prViewedAt(key)
    const count = countNewComments(activity.remarks, viewedAt, [activity.author, viewer])
    this.seen.set(key, { updatedAt: activity.updatedAt, count })
    for (const row of rows) if (prViewKey(row.pr_url) === key && (row.pr_new_comments ?? null) !== count) this.save(row, count)
    return { count, viewedAt }
  }

  private save(row: TaskRow, count: number) {
    // Not activity: a count never makes an old task "recent".
    this.store.updateTask(row.id, { prNewComments: count }, { quiet: true, touch: false })
    this.deps.onCount?.(row.id)
  }

  /** Requests run one after another, never in parallel. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  /** Until when nothing asks with this token: its own low-budget pause, or PrTracker's (GitHub's rate limit). */
  private pausedUntil(token: string) {
    return Math.max(this.tokenHealth(token).pausedUntil, this.deps.health?.(token).pausedUntil ?? 0)
  }

  private async round(rows: TaskRow[], scheduled: boolean) {
    const fetchFn = this.deps.fetch
    const intervalMs = this.deps.intervalMs()
    if (this.stopped || !fetchFn || !intervalMs || !rows.length) return
    // Each PR once per token, however many tasks have it.
    const byToken = new Map<string, Map<string, Target>>()
    for (const row of rows) {
      const pr = parsePrUrl(row.pr_url)
      const key = prViewKey(row.pr_url)
      const token = pr && key ? this.deps.token(row.project_id) : null
      if (!pr || !key || !token) continue
      let prs = byToken.get(token)
      if (!prs) byToken.set(token, (prs = new Map()))
      if (!prs.has(key)) prs.set(key, { key, ...pr })
    }
    for (const [token, prs] of byToken) {
      const h = this.tokenHealth(token)
      if (this.now() < this.pausedUntil(token) || (scheduled && this.now() < h.retryAt)) continue
      try {
        // Step 1: which PRs moved.
        const changed: Target[] = []
        for (const batch of chunks([...prs.values()], PR_COMMENTS_PROBE_BATCH)) {
          if (this.now() < this.pausedUntil(token)) break
          const { data } = await this.ask<BatchData>(fetchFn, token, batchQuery(batch, "", "state updatedAt"))
          batch.forEach((pr, i) => {
            const found = data[`p${i}`]?.pullRequest
            // Not found, or the token can't see it: PrTracker says why. Merged or closed just now: nothing to count.
            if (!found || found.state === "MERGED" || found.state === "CLOSED") return
            const last = this.seen.get(pr.key)
            if (!last || last.count > 0 || last.updatedAt !== (found.updatedAt ?? null)) changed.push(pr)
          })
        }
        // Step 2: their comments.
        for (const batch of chunks(changed, PR_COMMENTS_DETAIL_BATCH)) {
          if (this.now() < this.pausedUntil(token)) break
          const { data } = await this.ask<BatchData>(fetchFn, token, batchQuery(batch, "viewer { login }", PR_ACTIVITY_FIELDS))
          const open = this.store.listOpenPrRows()
          batch.forEach((pr, i) => {
            const found = data[`p${i}`]?.pullRequest
            if (found) this.ingest(`https://github.com/${pr.owner}/${pr.name}/pull/${pr.number}`, toActivity(found), data.viewer?.login ?? null, open)
          })
        }
        if (h.failures) this.deps.log?.("[box-yard] PR comment checks are working again.")
        h.failures = 0
        h.retryAt = 0
      } catch (err) {
        if (err instanceof RateLimited) {
          if (h.pausedUntil < err.until) this.deps.log?.(`[box-yard] PR comment checks paused for one token: ${errorMessage(err)}`)
          h.pausedUntil = Math.max(h.pausedUntil, err.until)
          // GitHub's own stop holds for every request with this token, PrTracker's too.
          const shared = this.deps.health?.(token)
          if (shared) shared.pausedUntil = Math.max(shared.pausedUntil, err.until)
        } else {
          if (h.failures === 0) this.deps.log?.(`[box-yard] PR comment check failed, backing off: ${errorMessage(err)}`)
          h.failures++
          h.retryAt = this.now() + backoffMs(intervalMs, h.failures)
        }
      }
    }
  }

  /** One request; afterwards the token rests until its budget resets when it has run low. */
  private async ask<T>(fetchFn: typeof fetch, token: string, q: { query: string; variables: Record<string, string | number> }) {
    this.requests++
    const answer = await githubGraphql<T>(fetchFn, token, q.query, q.variables, this.now)
    this.points += answer.rate.cost ?? 0
    const { remaining, resetAt } = answer.rate
    if (remaining !== null && remaining < COMMENTS_RATE_FLOOR && resetAt !== null) {
      const h = this.tokenHealth(token)
      if (h.pausedUntil < resetAt) this.deps.log?.(`[box-yard] PR comment checks paused for one token until ${new Date(resetAt).toISOString()}: ${remaining} GitHub points left this hour.`)
      h.pausedUntil = Math.max(h.pausedUntil, resetAt)
    }
    return answer
  }
}
