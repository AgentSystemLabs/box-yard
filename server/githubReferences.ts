import { createHash } from "node:crypto"
import { BadRequestError, githubSlug, NotFoundError } from "./store.js"
import type { GithubReference, GithubReferenceAnswer } from "../shared/githubReferences.js"

export const GITHUB_REFERENCES_FRESH_MS = 30_000
const API = "https://api.github.com"

interface Deps {
  project: (id: string) => { repo: string | null } | null | undefined
  token: (id: string) => string | null
  fetch: typeof fetch | null
  now?: () => number
}

/** Bounded, identity-specific memory cache. The caller supplies a project id, never a repository or token. */
export class GithubReferences {
  private cache = new Map<string, { until: number; value: GithubReferenceAnswer }>()
  private pending = new Map<string, Promise<GithubReferenceAnswer>>()

  constructor(private d: Deps) {}

  async get(projectId: string, query: string): Promise<GithubReferenceAnswer> {
    const project = this.d.project(projectId)
    if (!project) throw new NotFoundError("No such project")
    if (query.length > 120 || /[\x00-\x1f]/.test(query)) throw new BadRequestError("Search must be at most 120 characters on one line")
    const repo = githubSlug(project.repo)
    const empty = (problem: string): GithubReferenceAnswer => ({ repo, items: [], problem })
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return empty("This project has no GitHub repository.")
    const token = this.d.token(projectId)
    if (!token) return empty("No GitHub token for this project. Check Settings › Identities or Credentials.")
    if (!this.d.fetch) return empty("GitHub lookup is unavailable in mock mode.")
    const q = query.trim().toLowerCase()
    const scope = JSON.stringify([projectId, repo, createHash("sha256").update(token).digest("hex")])
    const result = await this.lookup(scope, repo, token, q)
    return { ...result, items: result.items.slice(0, 20) }
  }

  private async lookup(scope: string, repo: string, token: string, q: string): Promise<GithubReferenceAnswer> {
    const key = JSON.stringify([scope, q])
    const now = this.d.now?.() ?? Date.now()
    const cached = this.cache.get(key)
    if (cached && cached.until > now) return cached.value
    const pending = this.pending.get(key)
    if (pending) return pending
    const work = this.read(scope, repo, token, q).then((value) => {
      if (!value.problem) {
        this.cache.delete(key)
        this.cache.set(key, { until: (this.d.now?.() ?? Date.now()) + GITHUB_REFERENCES_FRESH_MS, value })
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
      }
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }

  private async read(scope: string, repo: string, token: string, q: string): Promise<GithubReferenceAnswer> {
    const answer = (items: GithubReference[], problem: string | null = null): GithubReferenceAnswer => ({ repo, items, problem })
    const numeric = /^\d+$/.test(q)
    if (numeric && (!Number.isSafeInteger(Number(q)) || Number(q) < 1)) return answer([])
    // Quote each title term so typed search qualifiers cannot expand the project scope.
    const terms = q.replace(/["\\]/g, " ").split(/\s+/).filter(Boolean).map((word) => `"${word}"`).join(" ")
    const repoPath = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}/issues`
    const path = numeric ? `${repoPath}/${Number(q)}` : terms
      ? `/search/issues?${new URLSearchParams({ q: `repo:${repo} in:title ${terms}`, sort: "updated", order: "desc", per_page: "20" })}`
      : `${repoPath}?state=all&sort=updated&direction=desc&per_page=100`
    // GitHub search matches whole words. A shared recent-title index supplies substring matches while typing;
    // full-word search still finds older work, and exact numbers always use the direct repository endpoint.
    if (!numeric && terms) {
      const [recent, searched] = await Promise.all([
        this.lookup(scope, repo, token, ""),
        this.request(repo, token, path, false),
      ])
      const words = q.split(/\s+/).filter(Boolean)
      const local = recent.items.filter((item) => words.every((word) => item.title.toLowerCase().includes(word)))
      const items = [...new Map([...local, ...searched.items].map((item) => [item.number, item])).values()]
      return answer(items, searched.problem ?? (!items.length ? recent.problem : null))
    }
    return this.request(repo, token, path, numeric)
  }

  private async request(repo: string, token: string, path: string, numeric: boolean): Promise<GithubReferenceAnswer> {
    const answer = (items: GithubReference[], problem: string | null = null): GithubReferenceAnswer => ({ repo, items, problem })
    try {
      const res = await this.d.fetch!(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      })
      if (numeric && res.status === 404) return answer([])
      if (!res.ok) return answer([], res.status === 401 ? "GitHub rejected this project's token. Check Settings › Identities or Credentials."
        : res.status === 403 || res.status === 429 ? "GitHub refused the lookup or its rate limit was reached. Try again shortly."
        : `Couldn't read this project's GitHub issues and pull requests (${res.status}).`)
      const body = await res.json()
      const rows: unknown = numeric ? [body] : path.startsWith("/search/") ? body?.items : body
      if (!Array.isArray(rows)) return answer([], "GitHub returned an unexpected response. Try again.")
      const items = rows.flatMap((row): GithubReference[] => {
        if (!row || !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.title !== "string" || !["open", "closed"].includes(row.state)) return []
        // Search and redirects must never return references from another repository.
        if (typeof row.repository_url !== "string" || row.repository_url.toLowerCase() !== `${API}/repos/${repo}`.toLowerCase()) return []
        const kind = row.pull_request ? "pull" : "issue"
        return [{ number: row.number, title: row.title, kind, state: row.pull_request?.merged_at ? "merged" : row.state, url: `https://github.com/${repo}/${kind === "pull" ? "pull" : "issues"}/${row.number}` }]
      })
      return answer(items)
    } catch {
      // Never return upstream errors: they may contain request credentials or response content.
      return answer([], "Couldn't reach GitHub. Try again.")
    }
  }
}
