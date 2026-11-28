import { githubSlug, type Store, type TaskRow } from "./store.js"
import type { PrState, PushState, TaskStatus } from "../shared/types.js"
import { errorMessage } from "./util/retry.js"
import { samePr } from "../shared/reviewPr.js"

/**
 * Live pull request state. Every task with a PR that isn't merged or closed yet, in any status, is polled
 * about once a minute with one batched GraphQL query per token (up to PR_BATCH PRs each), so a
 * PR merged by someone else (Cody, the PR Merger schedule) moves its task from pr_ready to done.
 * Before the Coordinator or a Captain is told a PR's state (list_inbox, get_task, list_tasks), any state
 * older than PR_REPORT_FRESH_MS is asked again (ensureFresh), so a missed poll never reaches Cody as
 * "waiting on you".
 *
 * Rate limits: GitHub's GraphQL budget is 5,000 points an hour per token, and a query like this
 * costs 1 point however many PRs it asks about (up to 100 nodes). At one round a minute that is
 * 60 points an hour for up to 50 open PRs, about 1% of the budget. Batches run one at a time
 * (no concurrent requests, per GitHub's secondary limits). Each token backs off on its own: errors
 * back off exponentially up to 15 minutes, and polling pauses until the reset when fewer than
 * RATE_FLOOR points are left (agents push and open PRs with the same token). One project's broken or
 * rate-limited token never holds back another project's PRs.
 *
 * Finding PRs (discover): an agent may open its PR without create_pull_request (`gh pr create`, which the runner
 * also reads, the API, a browser), and Cody may open one by hand. So tasks with a branch and no PR are looked up by
 * branch on GitHub: their own task when a turn ends, and every PR_DISCOVER_MS the ones active in the last
 * PR_DISCOVER_MAX_AGE_MS. That is one more batched query per token (PR_BATCH branches each, about 1 point), sharing
 * the same token health, so a paused or backing-off token isn't asked.
 *
 * Reviewed PRs (Task.reviewPrUrl, shared/reviewPr.ts): the PR a review task reviews is asked about in the same batched
 * queries, for its state and head branch only. It never moves the task's status and never reaches onChange (hooks,
 * Done when its PR merges); a lookup by branch never takes it, or any PR on its head branch, as the task's own.
 */

export const PR_POLL_MS = 60_000
export const PR_MAX_BACKOFF_MS = 15 * 60_000
export const PR_BATCH = 50
export const RATE_FLOOR = 200
/** How long a turn waits for GitHub before it starts with Box Yard's last known PR state instead. */
export const PR_LIVE_TIMEOUT_MS = 4_000
/** A PR state Box Yard checked this recently is used as is when a turn starts. */
export const PR_LIVE_FRESH_MS = 30_000
/** A PR state older than this is asked from GitHub again before an MCP tool reports it. */
export const PR_REPORT_FRESH_MS = 2 * 60_000
/** How long an MCP tool waits for that answer before it reports the last known state, marked unverified. */
export const PR_REPORT_TIMEOUT_MS = 5_000
/** How often the poll also looks up PRs by branch for tasks Box Yard knows no PR for (discover). */
export const PR_DISCOVER_MS = 5 * 60_000
/** A scheduled lookup asks only about tasks active this recently; a turn's end always asks about its own task. */
export const PR_DISCOVER_MAX_AGE_MS = 14 * 24 * 60 * 60_000
/** At most this many tasks a scheduled lookup, newest first. */
export const PR_DISCOVER_MAX_TASKS = 200
/** GitHub's clock and this server's may differ: a PR opened this long before its task still counts as the task's. */
export const PR_DISCOVER_SLACK_MS = 60_000

export interface PrInfo {
  state: PrState
  mergedAt: number | null
  mergedBy: string | null
  /** The head commit and label names, for hooks (left as they were when GitHub didn't say). */
  headSha?: string | null
  labels?: string[]
  /** The head branch's name, when GitHub said (a reviewed PR's is kept, so Box Yard never pushes there). */
  headRef?: string | null
}

export interface PrChange {
  taskId: string
  prev: PrState | null
  info: PrInfo
  /** The task's new status when the PR moved it (pr_ready → done or idle). */
  status: TaskStatus | null
}

/** A PR GitHub has on the branch of a task Box Yard knew no PR for (discover). It is saved on the task already. */
export interface FoundPr {
  taskId: string
  url: string
  /** The PR's head branch. */
  branch: string
  info: PrInfo
}

/** A PR on a branch, as a lookup by branch found it. */
export interface BranchPr {
  url: string
  headRefName: string
  createdAt: number
  info: PrInfo
}

/** The branch a task's last turn-end push found its workspace on, or null. */
function pushedBranch(row: Pick<TaskRow, "push_state_json">): string | null {
  try {
    const branch = row.push_state_json ? (JSON.parse(row.push_state_json) as PushState).branch : null
    return typeof branch === "string" && branch ? branch : null
  } catch {
    return null
  }
}

/**
 * The branches a PR-less task may have a PR on: the one its workspace was on at its last turn end, and its own. Never
 * the head branch of the PR it reviews: a reviewer that checked that branch out doesn't own its PR.
 */
export function taskBranches(row: Pick<TaskRow, "branch" | "push_state_json" | "review_pr_head">, baseBranch: string): string[] {
  const reviewed = row.review_pr_head || null
  return [...new Set([pushedBranch(row), row.branch])].filter((b): b is string => Boolean(b) && b !== baseBranch && b !== "HEAD" && b !== reviewed)
}

/**
 * The task's PR among those on its branches, or null. A branch name can come back (a deleted branch, a name someone
 * else used too), so a PR counts only when it was opened after the task started or the task's workspace was on its
 * branch at its last turn end; a merged one also has to have merged after the task started. An open PR beats a merged
 * one, and the newest wins.
 */
export function pickBranchPr(row: Pick<TaskRow, "created_at" | "push_state_json">, prs: BranchPr[]): BranchPr | null {
  const since = row.created_at - PR_DISCOVER_SLACK_MS
  const worked = pushedBranch(row)
  const ours = (pr: BranchPr) => pr.createdAt >= since || pr.headRefName === worked
  const newest = (list: BranchPr[]) => list.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  return (
    newest(prs.filter((pr) => (pr.info.state === "open" || pr.info.state === "draft") && ours(pr))) ??
    newest(prs.filter((pr) => pr.info.state === "merged" && ours(pr) && (pr.info.mergedAt ?? 0) >= since))
  )
}

/** A task's PR as a turn starts (PrTracker.live), for the PR line in the turn's prompt. */
export interface LivePr {
  url: string
  number: number | null
  state: PrState | null
  mergedAt: number | null
  mergedBy: string | null
  headSha: string | null
  /** When GitHub last answered about it (this server's life only), or null. */
  checkedAt: number | null
  /**
   * `github`: asked just now. `fresh`: checked within PR_LIVE_FRESH_MS, or merged (final). `fallback`: GitHub didn't
   * answer in time (or can't be asked: no token, rate limit), so it's Box Yard's last known state.
   */
  source: "github" | "fresh" | "fallback"
}

/** What Box Yard knows about how current a task's PR state is (this server's life only). */
export interface PrCheck {
  /** When GitHub last answered about the PR, or null. */
  checkedAt: number | null
  /** Why the last try didn't get an answer (no token, the token can't see the repo, rate limit, ...), or null. */
  error: string | null
}

/** One token's health: it backs off and pauses on its own, so it never holds back another token's PRs. */
export interface TokenHealth {
  /** Rounds in a row that hit an error; the wait before the next scheduled try doubles with each. */
  failures: number
  /** No scheduled round asks with this token before then (error backoff). On-demand checks still do. */
  retryAt: number
  /** Nothing asks with this token before then (rate limit, or the budget ran low). */
  pausedUntil: number
}

export interface PrTrackerDeps {
  store: Store
  /** The GitHub token for a project's PRs, or null to leave them alone (mock mode, no token). */
  token: (projectId: string) => string | null
  fetch?: typeof fetch
  now?: () => number
  intervalMs?: number
  /** After a task's PR state changed (and maybe its status); the task is already saved. */
  onChange?: (change: PrChange) => void
  /** A lookup by branch found a PR for a task that had none, and saved it on the task (its state follows, as a change). */
  onFound?: (found: FoundPr) => void
  /** The PR a task reviews changed state (or GitHub first said its head branch); saved already. Nothing else follows. */
  onReview?: (taskId: string) => void
  /** How often the poll also looks up PRs by branch (discover); default PR_DISCOVER_MS. */
  discoverMs?: number
  /**
   * Whether a merge moves this resting task to done (Done when its PR merges: Settings, its project's, its own opt-out,
   * and nothing queued for it). Default on, as when it wasn't a setting.
   */
  autoDone?: (row: TaskRow) => boolean
  log?: (message: string) => void
}

/** The statuses a merged PR moves to done when Settings' autoDoneOnMerge is on: the task's turn is over and nothing waits on Cody. */
export const AUTO_DONE_FROM: readonly TaskStatus[] = ["pr_ready", "idle"]

/** What a PR now in `state` does to a task's status: null leaves it alone. */
export function restingStatus(row: Pick<TaskRow, "status" | "current_turn_id">, state: PrState, autoDone: boolean): TaskStatus | null {
  if (row.current_turn_id) return null
  if (state === "merged") {
    if (autoDone) return AUTO_DONE_FROM.includes(row.status) ? "done" : null
    return row.status === "pr_ready" ? "idle" : null
  }
  if (state === "closed" && row.status === "pr_ready") return "idle"
  return null
}

/** owner, repo name and number of a github.com pull request URL. */
export function parsePrUrl(url: string | null | undefined): { owner: string; name: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url ?? "")
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null
}

export const prNumber = (url: string | null | undefined) => parsePrUrl(url)?.number ?? null

/** The wait before a token that failed `failures` times in a row is tried again on schedule. */
export const backoffMs = (intervalMs: number, failures: number) => Math.min(intervalMs * 2 ** Math.min(failures, 10), PR_MAX_BACKOFF_MS)

/** GitHub said to stop asking with a token until `until` (HTTP 403/429, or a RATE_LIMITED error). */
export class RateLimited extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit; paused until ${new Date(until).toISOString()}`)
  }
}

export interface GqlError {
  type?: string
  message?: string
  path?: (string | number)[]
}

/** A GraphQL answer: its data (fields that failed are null, with an entry in `errors`) and the token's budget after it. */
export interface GqlAnswer<T> {
  data: T
  errors: GqlError[]
  /** `rateLimit { cost remaining resetAt }` when the query asked for it: points this query cost, points left, when they reset. */
  rate: { cost: number | null; remaining: number | null; resetAt: number | null }
}

/**
 * One GraphQL request to GitHub. Throws RateLimited when GitHub says to stop (with when to ask again), and an Error
 * for any other failure (HTTP error, no data). A query that names `rateLimit` gets the token's budget back in `rate`.
 */
export async function githubGraphql<T>(
  fetchFn: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, string | number>,
  now: () => number = Date.now,
): Promise<GqlAnswer<T>> {
  const res = await fetchFn("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "box-yard" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"))
    const reset = Number(res.headers.get("x-ratelimit-reset"))
    if (retryAfter > 0) throw new RateLimited(now() + retryAfter * 1000)
    if (res.headers.get("x-ratelimit-remaining") === "0" && reset > 0) throw new RateLimited(reset * 1000)
    // A secondary limit without a hint: GitHub asks for at least a minute.
    throw new RateLimited(now() + 60_000)
  }
  if (!res.ok) throw new Error(`GitHub GraphQL returned HTTP ${res.status}`)
  const body = (await res.json()) as { data?: T & { rateLimit?: { cost?: number; remaining?: number; resetAt?: string } }; errors?: GqlError[] }
  const limit = body.data?.rateLimit
  const resetAt = limit?.resetAt ? Date.parse(limit.resetAt) : NaN
  if (body.errors?.some((e) => e.type === "RATE_LIMITED")) throw new RateLimited(Number.isFinite(resetAt) ? resetAt : now() + 60_000)
  if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub GraphQL returned no data")
  return {
    data: body.data,
    errors: body.errors ?? [],
    rate: {
      cost: typeof limit?.cost === "number" ? limit.cost : null,
      remaining: typeof limit?.remaining === "number" ? limit.remaining : null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
    },
  }
}

/** GitHub's answer about one PR of a batch: its state, or why there is none. */
interface PrAnswer {
  info: PrInfo | null
  error: string | null
}

interface GqlPr {
  headRefName?: string
  state?: "OPEN" | "CLOSED" | "MERGED"
  isDraft?: boolean
  mergedAt?: string | null
  mergedBy?: { login?: string } | null
  headRefOid?: string | null
  labels?: { nodes?: ({ name?: string } | null)[] | null } | null
}

/** A PR a lookup by branch returns. */
interface GqlBranchPr extends GqlPr {
  url?: string
  createdAt?: string
  headRefName?: string
  headRepository?: { nameWithOwner?: string } | null
}

interface GqlBranchRepo {
  nameWithOwner?: string
  pullRequests?: { nodes?: (GqlBranchPr | null)[] | null } | null
  /** The repo a fork came from: a fork's PRs usually go there. */
  parent?: { pullRequests?: { nodes?: (GqlBranchPr | null)[] | null } | null } | null
}

/** One PR to ask GitHub about: a task's own (key: its id) or the one it reviews (key: reviewKey). */
interface PrAsk {
  key: string
  row: TaskRow
  url: string
  save: (info: PrInfo) => void
}

/** The key of a task's reviewed PR in PrTracker's checks, apart from its own PR's (the task's id). */
const reviewKey = (taskId: string) => `review:${taskId}`

/** One branch of one repo to look up, and the tasks that may have their PR on it. */
interface BranchLookup {
  owner: string
  name: string
  branch: string
  rows: TaskRow[]
}

const toInfo = (pr: GqlPr): PrInfo | null => {
  const state: PrState | null =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : null
  if (!state) return null
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN
  const labels = Array.isArray(pr.labels?.nodes) ? pr.labels.nodes.map((l) => l?.name).filter((n): n is string => typeof n === "string") : undefined
  return {
    state,
    mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
    mergedBy: pr.mergedBy?.login ?? null,
    ...(typeof pr.headRefOid === "string" ? { headSha: pr.headRefOid } : {}),
    ...(labels ? { labels } : {}),
    ...(typeof pr.headRefName === "string" && pr.headRefName ? { headRef: pr.headRefName } : {}),
  }
}

export class PrTracker {
  private readonly store: Store
  private readonly deps: PrTrackerDeps
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly discoverMs: number
  /** When the scheduled lookup by branch last ran (discover). */
  private discoveredAt = -Infinity
  private timer: NodeJS.Timeout | null = null
  private soonTimer: NodeJS.Timeout | null = null
  private soon = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  /** GraphQL requests sent so far. */
  requests = 0
  /** Per token (in memory only, like the token itself). */
  private readonly health = new Map<string, TokenHealth>()
  /** When GitHub last answered about each task's PR, and why the last try didn't. */
  private readonly checks = new Map<string, PrCheck>()
  /** Tasks whose current PR error was logged already, so a PR the token can't see logs once, not every minute. */
  private readonly logged = new Map<string, string>()

  constructor(deps: PrTrackerDeps) {
    this.deps = deps
    this.store = deps.store
    this.fetch = deps.fetch ?? ((...args) => fetch(...args))
    this.now = deps.now ?? (() => Date.now())
    this.intervalMs = deps.intervalMs ?? PR_POLL_MS
    this.discoverMs = deps.discoverMs ?? PR_DISCOVER_MS
  }

  /** Backfill right away (existing tasks), then poll every interval. */
  start() {
    this.stopped = false
    this.arm(0)
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.soonTimer) clearTimeout(this.soonTimer)
    this.timer = this.soonTimer = null
  }

  /** A token's health (a fresh record for a token not used yet). */
  tokenHealth(token: string): TokenHealth {
    let h = this.health.get(token)
    if (!h) this.health.set(token, (h = { failures: 0, retryAt: 0, pausedUntil: 0 }))
    return h
  }

  /** What Box Yard knows about how current a task's PR state is. */
  prCheck(taskId: string): PrCheck {
    return this.checks.get(taskId) ?? { checkedAt: null, error: null }
  }

  /**
   * The computer woke from sleep (or the network came back): forget error backoffs, which a sleeping laptop's failed
   * requests piled up, and poll now. Rate limit pauses stay, since GitHub set them.
   */
  wake() {
    for (const h of this.health.values()) {
      h.failures = 0
      h.retryAt = 0
    }
    this.arm(0)
  }

  private arm(delay: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      // Every interval: a token that is backing off or paused is skipped inside the round, the others are asked.
      void this.pollAll()
        .then(() => this.discoverDue())
        .finally(() => this.arm(this.intervalMs))
    }, delay)
    this.timer.unref?.()
  }

  /** The scheduled lookup by branch, when PR_DISCOVER_MS passed since the last (and at start, for PRs opened meanwhile). */
  private async discoverDue() {
    if (this.stopped || this.now() - this.discoveredAt < this.discoverMs) return
    this.discoveredAt = this.now()
    await this.discover().catch(() => 0)
  }

  /**
   * Look up PRs by branch for tasks Box Yard knows no PR for: these tasks, or every one active within
   * PR_DISCOVER_MAX_AGE_MS (newest PR_DISCOVER_MAX_TASKS). A PR found is saved on its task (onFound, then its state
   * as any change). Returns how many it found. A scheduled round (no ids) skips a token that is backing off.
   */
  discover(taskIds?: string[]): Promise<number> {
    const scheduled = !taskIds
    return this.exclusive(() =>
      this.lookup(
        this.store.listPrlessBranchRows(taskIds ? { ids: taskIds } : { since: this.now() - PR_DISCOVER_MAX_AGE_MS, limit: PR_DISCOVER_MAX_TASKS }),
        scheduled,
      ),
    )
  }

  /**
   * A turn of a task with no PR ended: look up its branch, so a PR its agent opened some other way (or Cody opened)
   * shows. Waits at most timeoutMs and never throws.
   */
  async discoverTask(taskId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.stopped) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.timeoutMs ?? PR_LIVE_TIMEOUT_MS)))
    await Promise.race([this.discover([taskId]).catch(() => 0), timeout])
    clearTimeout(timer)
  }

  /**
   * One round over every PR that may still change, tasks' own and the ones they review, in the same batches. Merged
   * and closed PRs are never asked about again.
   */
  pollAll(): Promise<void> {
    return this.exclusive(() => this.ask([...this.ownAsks(this.store.listOpenPrRows()), ...this.reviewAsks(this.reviewRows())], true))
  }

  /** Reviews whose PR may still change: of tasks not done, or active within PR_DISCOVER_MAX_AGE_MS. */
  private reviewRows(ids?: string[]): TaskRow[] {
    return this.store.listOpenReviewPrRows({ ids, since: this.now() - PR_DISCOVER_MAX_AGE_MS })
  }

  private ownAsks(rows: TaskRow[]): PrAsk[] {
    return rows.map((row) => ({ key: row.id, row, url: row.pr_url ?? "", save: (info) => this.apply(row.id, row.pr_url!, info) }))
  }

  private reviewAsks(rows: TaskRow[]): PrAsk[] {
    return rows.map((row) => ({ key: reviewKey(row.id), row, url: row.review_pr_url ?? "", save: (info) => this.applyReview(row.id, row.review_pr_url!, info) }))
  }

  /** What Box Yard knows about how current the state of the PR a task reviews is. */
  reviewCheck(taskId: string): PrCheck {
    return this.checks.get(reviewKey(taskId)) ?? { checkedAt: null, error: null }
  }

  /**
   * Before a PR state is reported (list_inbox, get_task, list_tasks): ask GitHub about every PR of these tasks (all
   * tasks when null) that may still change and wasn't answered within maxAgeMs, in one batched query per token. Waits
   * at most timeoutMs and never throws; a PR it couldn't confirm keeps its last known state, and prCheck() says why.
   */
  async ensureFresh(taskIds: string[] | null, opts: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const maxAge = opts.maxAgeMs ?? PR_REPORT_FRESH_MS
    const stale = () =>
      this.store.listOpenPrRows(taskIds ?? undefined).filter((r) => {
        const at = this.checks.get(r.id)?.checkedAt
        return at == null || this.now() - at >= maxAge
      })
    if (this.stopped || !stale().length) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.timeoutMs ?? PR_REPORT_TIMEOUT_MS)))
    // Picked again once its turn comes: the round before it may have answered some of them already.
    await Promise.race([this.exclusive(() => this.poll(stale(), false)).catch(() => {}), timeout])
    clearTimeout(timer)
  }

  /**
   * Check a task's PR, and the one it reviews, shortly (an agent just opened or pushed to it; a review task was just
   * created). Calls within the delay share one request.
   */
  refresh(taskId: string, delayMs = 2_000) {
    if (this.stopped) return
    this.soon.add(taskId)
    if (this.soonTimer) return
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      const ids = [...this.soon]
      this.soon.clear()
      void this.exclusive(() => this.ask([...this.ownAsks(this.store.listOpenPrRows(ids)), ...this.reviewAsks(this.reviewRows(ids))], false))
    }, delayMs)
    this.soonTimer.unref?.()
  }

  /**
   * Ask GitHub about one task's PR now and save the answer (used when a turn ends). Unlike the poll, this also
   * re-checks a closed PR, since the agent may have reopened it. Null when it can't tell.
   */
  async check(taskId: string): Promise<PrState | null> {
    const row = this.store.getTaskRow(taskId)
    if (!row?.pr_url) return null
    if (row.pr_state === "merged") return "merged"
    await this.exclusive(() => this.poll([row], false))
    const after = this.store.getTaskRow(taskId)
    return after?.pr_url === row.pr_url ? (after.pr_state ?? null) : null
  }

  /**
   * A task's PR as a turn starts: a state Box Yard checked moments ago (or a merged one, which is final) as is,
   * else asked from GitHub with a short timeout, else the last known state. Never throws and never waits longer
   * than timeoutMs, so a slow or unreachable GitHub doesn't hold the turn up. Null when the task has no PR.
   */
  async live(taskId: string, opts: { timeoutMs?: number; freshMs?: number } = {}): Promise<LivePr | null> {
    const row = this.store.getTaskRow(taskId)
    if (!row?.pr_url) return null
    const checked = this.checks.get(taskId)?.checkedAt ?? null
    const fresh = row.pr_state === "merged" || (checked !== null && this.now() - checked < (opts.freshMs ?? PR_LIVE_FRESH_MS))
    let source: LivePr["source"] = fresh ? "fresh" : "fallback"
    if (!fresh) {
      const asked = this.now()
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.timeoutMs ?? PR_LIVE_TIMEOUT_MS)))
      await Promise.race([this.check(taskId).catch(() => null), timeout])
      clearTimeout(timer)
      if ((this.checks.get(taskId)?.checkedAt ?? 0) >= asked) source = "github"
    }
    const now = this.store.getTaskRow(taskId)
    if (!now?.pr_url) return null
    return {
      url: now.pr_url,
      number: prNumber(now.pr_url),
      state: now.pr_state,
      mergedAt: now.pr_merged_at,
      mergedBy: now.pr_merged_by,
      headSha: now.pr_head_sha,
      checkedAt: this.checks.get(taskId)?.checkedAt ?? null,
      source,
    }
  }

  /** Requests run one after another, never in parallel. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * A try about a task's PR got no answer: keep the last known state and say why. `log`: for an answer about this PR
   * alone (a token that can't see its repo), once per reason; a whole request that failed is logged per token instead.
   */
  private missed(item: Pick<PrAsk, "key" | "row" | "url">, error: string, log = false) {
    const prev = this.checks.get(item.key)
    this.checks.set(item.key, { checkedAt: prev?.checkedAt ?? null, error })
    if (!log || this.logged.get(item.key) === error) return
    this.logged.set(item.key, error)
    this.deps.log?.(`[box-yard] Can't check PR ${item.url} (task ${item.row.id}${item.key === item.row.id ? "" : ", which reviews it"}): ${error}`)
  }

  /** Ask about these tasks' own PRs (see ask). */
  private poll(rows: TaskRow[], scheduled: boolean) {
    return this.ask(this.ownAsks(rows), scheduled)
  }

  /**
   * Ask about these rows, one batched query per token. A scheduled round skips a token that is backing off after
   * errors; any round skips one that is rate limited. Either way the other tokens are still asked.
   */
  private async ask(items: PrAsk[], scheduled: boolean) {
    if (this.stopped || !items.length) return
    const byToken = new Map<string, PrAsk[]>()
    for (const item of items) {
      if (!parsePrUrl(item.url)) {
        this.missed(item, "not a github.com pull request URL", true)
        continue
      }
      const token = this.deps.token(item.row.project_id)
      if (!token) {
        this.missed(item, "no GitHub token for this project")
        continue
      }
      byToken.set(token, [...(byToken.get(token) ?? []), item])
    }
    for (const [token, list] of byToken) {
      const h = this.tokenHealth(token)
      if (this.now() < h.pausedUntil) {
        for (const item of list) this.missed(item, `GitHub rate limit; paused until ${new Date(h.pausedUntil).toISOString()}`)
        continue
      }
      if (scheduled && this.now() < h.retryAt) continue
      for (let i = 0; i < list.length; i += PR_BATCH) {
        const batch = list.slice(i, i + PR_BATCH)
        try {
          const answers = await this.query(token, h, batch.map((item) => item.url))
          batch.forEach((item, j) => {
            const { info, error } = answers[j] ?? { info: null, error: null }
            if (!info) return this.missed(item, error ?? "GitHub returned no pull request", true)
            this.checks.set(item.key, { checkedAt: this.now(), error: null })
            this.logged.delete(item.key)
            item.save(info)
          })
          this.worked(h)
        } catch (err) {
          for (const item of batch) this.missed(item, errorMessage(err))
          this.failed(h, err)
          // This token's other batches wait for its next try; other tokens go on.
          for (const item of list.slice(i + PR_BATCH)) this.missed(item, errorMessage(err))
          break
        }
      }
    }
  }

  /** A request with this token got an answer: its backoff is over. */
  private worked(h: TokenHealth) {
    if (h.failures) this.deps.log?.("[box-yard] PR status checks are working again.")
    h.failures = 0
    h.retryAt = 0
  }

  /** A request with this token failed: pause it until GitHub's reset (rate limit), or back off. */
  private failed(h: TokenHealth, err: unknown) {
    if (err instanceof RateLimited) {
      if (h.pausedUntil < err.until) this.deps.log?.(`[box-yard] PR status checks paused for one token: ${errorMessage(err)}`)
      h.pausedUntil = Math.max(h.pausedUntil, err.until)
    } else {
      if (h.failures === 0) this.deps.log?.(`[box-yard] PR status check failed, backing off: ${errorMessage(err)}`)
      h.failures++
      h.retryAt = this.now() + backoffMs(this.intervalMs, h.failures)
    }
  }

  /**
   * Look up these PR-less tasks' branches, one batched query per token (tasks on the same repo and branch share one
   * lookup), and save each task's PR (pickBranchPr). Tasks of projects with no GitHub repo or token are left alone.
   */
  private async lookup(rows: TaskRow[], scheduled: boolean): Promise<number> {
    if (this.stopped || !rows.length) return 0
    const byToken = new Map<string, Map<string, BranchLookup>>()
    const projects = new Map<string, ReturnType<Store["getProject"]>>()
    for (const row of rows) {
      if (!projects.has(row.project_id)) projects.set(row.project_id, this.store.getProject(row.project_id))
      const project = projects.get(row.project_id)
      const slug = githubSlug(project?.repo ?? null)
      if (!project || !slug) continue
      const token = this.deps.token(row.project_id)
      if (!token) continue
      const [owner, name] = slug.split("/") as [string, string]
      const lookups = byToken.get(token) ?? new Map<string, BranchLookup>()
      byToken.set(token, lookups)
      for (const branch of taskBranches(row, project.baseBranch)) {
        const key = `${slug.toLowerCase()}#${branch}`
        const l = lookups.get(key) ?? { owner, name, branch, rows: [] }
        l.rows.push(row)
        lookups.set(key, l)
      }
    }
    let found = 0
    for (const [token, lookups] of byToken) {
      const h = this.tokenHealth(token)
      if (this.now() < h.pausedUntil || (scheduled && this.now() < h.retryAt)) continue
      const list = [...lookups.values()]
      for (let i = 0; i < list.length && !this.stopped; i += PR_BATCH) {
        const batch = list.slice(i, i + PR_BATCH)
        let answers: BranchPr[][]
        try {
          answers = await this.queryBranches(token, h, batch)
          this.worked(h)
        } catch (err) {
          this.failed(h, err)
          break
        }
        const byRow = new Map<string, { row: TaskRow; prs: BranchPr[] }>()
        batch.forEach((l, j) => {
          for (const row of l.rows) {
            const entry = byRow.get(row.id) ?? { row, prs: [] }
            entry.prs.push(...(answers[j] ?? []))
            byRow.set(row.id, entry)
          }
        })
        for (const { row, prs } of byRow.values()) {
          // The PR it reviews is never its own, even on a branch it checked out.
          const pr = pickBranchPr(row, prs.filter((p) => !samePr(p.url, row.review_pr_url)))
          if (pr && this.found(row.id, pr)) found++
        }
      }
    }
    return found
  }

  /** One GraphQL request for a batch of branches; entry i is the PRs on branch i whose head is that repo's own branch. */
  private async queryBranches(token: string, h: TokenHealth, lookups: BranchLookup[]): Promise<BranchPr[][]> {
    const variables: Record<string, string | number> = {}
    const defs: string[] = []
    const fields: string[] = []
    lookups.forEach((l, i) => {
      Object.assign(variables, { [`o${i}`]: l.owner, [`n${i}`]: l.name, [`b${i}`]: l.branch })
      defs.push(`$o${i}: String!, $n${i}: String!, $b${i}: String!`)
      const prs = `pullRequests(headRefName: $b${i}, states: [OPEN, MERGED], first: 5, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...pr } }`
      fields.push(`d${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner ${prs} parent { ${prs} } }`)
    })
    const query = `query(${defs.join(", ")}) { rateLimit { remaining resetAt } ${fields.join(" ")} }
fragment pr on PullRequest { url state isDraft createdAt mergedAt mergedBy { login } headRefName headRefOid headRepository { nameWithOwner } }`

    this.requests++
    const { data, rate } = await githubGraphql<Record<string, GqlBranchRepo | null>>(this.fetch, token, query, variables, this.now)
    if (rate.remaining !== null && rate.remaining < RATE_FLOOR && rate.resetAt !== null) h.pausedUntil = rate.resetAt
    // A repo the token can't see comes back null (with an error for it): no PR found there.
    return lookups.map((l, i) => {
      const repo = data[`d${i}`]
      // The head has to be this repo's branch: a PR from someone else's fork with a branch of the same name isn't the task's.
      const heads = new Set([`${l.owner}/${l.name}`, repo?.nameWithOwner ?? ""].filter(Boolean).map((s) => s.toLowerCase()))
      const nodes = [...(repo?.pullRequests?.nodes ?? []), ...(repo?.parent?.pullRequests?.nodes ?? [])]
      return nodes.flatMap((n): BranchPr[] => {
        if (!n?.url || !parsePrUrl(n.url) || n.headRefName !== l.branch || !heads.has(n.headRepository?.nameWithOwner?.toLowerCase() ?? "")) return []
        const info = toInfo(n)
        const createdAt = Date.parse(n.createdAt ?? "")
        return info && Number.isFinite(createdAt) ? [{ url: n.url, headRefName: n.headRefName, createdAt, info }] : []
      })
    })
  }

  /**
   * Save a PR found on a task's branch: it opens on the task (a resting idle task is ready for review now), then its
   * state applies as any change does, so a merged one moves the task as a merge seen live would. False when the task
   * got a PR meanwhile.
   */
  private found(taskId: string, pr: BranchPr): boolean {
    const row = this.store.getTaskRow(taskId)
    if (!row || row.pr_url || row.status === "done" || samePr(pr.url, row.review_pr_url)) return false
    const ready = !row.current_turn_id && row.status === "idle"
    this.store.updateTask(
      row.id,
      { prUrl: pr.url, branch: pr.headRefName, prState: "open", prMergedAt: null, prMergedBy: null, prLabels: [], prHeadSha: pr.info.headSha ?? null, ...(ready ? { status: "pr_ready" as const } : {}) },
      { quiet: true },
    )
    this.checks.set(row.id, { checkedAt: this.now(), error: null })
    this.deps.onFound?.({ taskId: row.id, url: pr.url, branch: pr.headRefName, info: pr.info })
    this.apply(row.id, pr.url, pr.info)
    return true
  }

  /** One GraphQL request for a batch of PRs; entry i is PR i's state, or why GitHub didn't return it. */
  private async query(token: string, h: TokenHealth, urls: string[]): Promise<PrAnswer[]> {
    const variables: Record<string, string | number> = {}
    const defs: string[] = []
    const fields: string[] = []
    urls.forEach((url, i) => {
      const pr = parsePrUrl(url)!
      Object.assign(variables, { [`o${i}`]: pr.owner, [`n${i}`]: pr.name, [`p${i}`]: pr.number })
      defs.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`)
      fields.push(`p${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { ...pr } }`)
    })
    const query = `query(${defs.join(", ")}) { rateLimit { remaining resetAt } ${fields.join(" ")} }
fragment pr on PullRequest { state isDraft mergedAt mergedBy { login } headRefName headRefOid labels(first: 30) { nodes { name } } }`

    this.requests++
    const { data, errors, rate } = await githubGraphql<Record<string, { pullRequest?: GqlPr | null } | null>>(this.fetch, token, query, variables, this.now)
    // Leave headroom for agents using the same token.
    if (rate.remaining !== null && rate.remaining < RATE_FLOOR && rate.resetAt !== null) h.pausedUntil = rate.resetAt
    // A missing repo or PR (or one the token can't see: GitHub says NOT_FOUND for those too) comes back as null next
    // to an error for that field; the others still count.
    return urls.map((_, i) => {
      const pr = data[`p${i}`]?.pullRequest
      const info = pr ? toInfo(pr) : null
      if (info) return { info, error: null }
      const e = errors.find((x) => x.path?.[0] === `p${i}`)
      const error = e
        ? `${e.type === "NOT_FOUND" ? "this project's GitHub token can't see it (or it doesn't exist)" : "GitHub said no"}: ${e.type ? `${e.type} ` : ""}${e.message ?? ""}`.trim()
        : null
      return { info: null, error }
    })
  }

  /**
   * Save a PR's state. A merged PR moves a resting task (pr_ready or idle, its turn over) to done, or with
   * Settings' autoDoneOnMerge off a pr_ready one to idle; a closed one drops a pr_ready task back to idle.
   * Any other status (working, needs input, waiting, failed, ...) is left alone. Merges seen live notify Cody;
   * the first check of an old PR (the startup backfill) doesn't.
   */
  apply(taskId: string, prUrl: string, info: PrInfo) {
    const row = this.store.getTaskRow(taskId)
    if (!row || row.pr_url !== prUrl) return // the agent opened a different PR in the meantime
    const labels = info.labels ? JSON.stringify(info.labels) : row.pr_labels_json
    const headSha = info.headSha ?? row.pr_head_sha
    const same = row.pr_state === info.state && row.pr_merged_at === info.mergedAt && row.pr_merged_by === info.mergedBy
    if (same && headSha === row.pr_head_sha && labels === row.pr_labels_json) return
    if (same) {
      // Only the head commit or labels moved: save them for hooks, nothing else changed.
      this.store.updateTask(row.id, { prHeadSha: headSha, ...(info.labels ? { prLabels: info.labels } : {}) }, { quiet: true, touch: false })
      return
    }
    const status = restingStatus(row, info.state, info.state === "merged" ? (this.deps.autoDone?.(row) ?? true) : true)
    const task = this.store.updateTask(
      row.id,
      { prState: info.state, prMergedAt: info.mergedAt, prMergedBy: info.mergedBy, prHeadSha: headSha, ...(info.labels ? { prLabels: info.labels } : {}), ...(status ? { status } : {}) },
      // Only a status change counts as activity; a backfilled PR state on an old task shouldn't make it "recent".
      { quiet: true, touch: Boolean(status) },
    )
    const live = row.pr_state === "open" || row.pr_state === "draft"
    if (status === "done" && live) {
      this.store.addNotification(task, `PR #${prNumber(prUrl) ?? "?"} merged${info.mergedBy ? ` by ${info.mergedBy}` : ""}`)
    }
    this.deps.onChange?.({ taskId: row.id, prev: row.pr_state, info, status })
  }

  /**
   * Save the state (and head branch) of the PR a task reviews. Only that: it never moves the task's status, notifies,
   * or reaches onChange (hooks, Done when its PR merges), since it isn't the task's PR.
   */
  applyReview(taskId: string, prUrl: string, info: PrInfo) {
    const row = this.store.getTaskRow(taskId)
    if (!row || row.review_pr_url !== prUrl) return // it was set to another PR meanwhile
    const head = info.headRef ?? row.review_pr_head ?? null
    if (row.review_pr_state === info.state && (row.review_pr_head ?? null) === head) return
    this.store.updateTask(row.id, { reviewPrState: info.state, reviewPrHead: head }, { quiet: true, touch: false })
    this.deps.onReview?.(row.id)
  }
}
