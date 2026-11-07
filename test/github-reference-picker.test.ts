import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { buildHarnessTargets, buildProjectTargets, buildRunTargets, tagsIn } from "../shared/runTargets.js"
import { GithubReferences, GITHUB_REFERENCES_FRESH_MS } from "../server/githubReferences.js"
import { githubMentionAt, insertGithubReference } from "../web/src/lib/githubReferences.js"

const row = (number = 12, extra: object = {}) => ({ number, title: "Retry webhooks", state: "open", repository_url: "https://api.github.com/repos/acme/site", ...extra })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function setup() {
  let token = "site-token"
  let now = 0
  const repos: Record<string, string | null> = { site: "https://github.com/acme/site", other: "acme/other", empty: null }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row()]))
  const source = new GithubReferences({ project: (id) => id in repos ? { repo: repos[id]! } : null, token: () => token, fetch: fetcher, now: () => now })
  return { source, fetcher, repos, token: (value: string) => token = value, tick: () => now += GITHUB_REFERENCES_FRESH_MS + 1 }
}

describe("project GitHub references", () => {
  it("lists real recent issues and PRs of any state, with canonical links", async () => {
    const { source, fetcher } = setup()
    fetcher.mockResolvedValue(json([row(), row(13, { state: "closed", pull_request: { merged_at: "2026-01-01" } })]))
    expect(await source.get("site", "")).toEqual({ repo: "acme/site", problem: null, items: [
      { number: 12, title: "Retry webhooks", kind: "issue", state: "open", url: "https://github.com/acme/site/issues/12" },
      { number: 13, title: "Retry webhooks", kind: "pull", state: "merged", url: "https://github.com/acme/site/pull/13" },
    ] })
    expect(String(fetcher.mock.calls[0]![0])).toContain("/repos/acme/site/issues?state=all")
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer site-token" }, redirect: "error" })
  })

  it("looks up an exact number directly, including a closed PR, and treats missing numbers as empty", async () => {
    const { source, fetcher } = setup()
    fetcher.mockResolvedValueOnce(json(row(120, { state: "closed", pull_request: {} })))
    expect((await source.get("site", "120")).items[0]).toMatchObject({ number: 120, kind: "pull", state: "closed" })
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.github.com/repos/acme/site/issues/120")
    fetcher.mockResolvedValueOnce(json({}, 404))
    expect((await source.get("site", "999")).items).toEqual([])
  })

  it("quotes title terms, fixes repo scope, and rejects upstream results from another repo", async () => {
    const { source, fetcher } = setup()
    fetcher.mockImplementation(async (url) => String(url).includes("/search/")
      ? json({ items: [row(), row(4, { repository_url: "https://api.github.com/repos/acme/other" })] })
      : json([]))
    expect((await source.get("site", 'retry repo:acme/other "OR"')).items).toHaveLength(1)
    const url = new URL(String(fetcher.mock.calls.find(([url]) => String(url).includes("/search/"))![0]))
    expect(url.searchParams.get("q")).toBe('repo:acme/site in:title "retry" "repo:acme/other" "or"')
    expect(url.searchParams.get("per_page")).toBe("20")
  })

  it("matches partial title words from a shared recent index and finds older full-title results", async () => {
    const { source, fetcher } = setup()
    fetcher.mockImplementation(async (url) => String(url).includes("/search/")
      ? json({ items: String(url).includes("webhooks") ? [row(1, { title: "Older webhooks work" }), row()] : [] })
      : json(Array.from({ length: 30 }, (_, i) => row(100 + i, { title: i === 29 ? "Retry webhooks" : "Other work" }))))
    // Bare # stays short, while partial matching reaches beyond the first 20 rows.
    expect((await source.get("site", "")).items).toHaveLength(20)
    expect((await source.get("site", "retr webh")).items.map((item) => item.number)).toEqual([129])
    expect((await source.get("site", "webhooks")).items.map((item) => item.number)).toEqual([129, 1, 12])
    expect(fetcher.mock.calls.filter(([url]) => !String(url).includes("/search/"))).toHaveLength(1)
  })

  it("deduplicates pending requests, caches briefly and separates projects, repos and credentials", async () => {
    const { source, fetcher, token, repos, tick } = setup()
    let release!: (r: Response) => void
    fetcher.mockReturnValueOnce(new Promise((r) => release = r))
    const a = source.get("site", ""), b = source.get("site", "")
    release(json([row()]))
    await Promise.all([a, b])
    await source.get("site", "")
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockImplementation(async () => json([]))
    token("new-token")
    await source.get("site", "")
    repos.site = "acme/renamed"
    await source.get("site", "")
    await source.get("other", "")
    tick()
    await source.get("site", "")
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it("handles no repo/auth, malformed filters and unknown projects without an upstream call", async () => {
    const { source, fetcher, token } = setup()
    expect((await source.get("empty", "")).problem).toContain("no GitHub repository")
    await expect(source.get("missing", "")).rejects.toThrow("No such project")
    await expect(source.get("site", "a".repeat(121))).rejects.toThrow("120")
    await expect(source.get("site", "a\nb")).rejects.toThrow("one line")
    token("")
    expect((await source.get("site", "")).problem).toContain("No GitHub token")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("sanitizes failures, permits retry and handles auth/rate-limit/bad responses", async () => {
    const { source, fetcher } = setup()
    for (const status of [401, 403, 429, 500]) {
      fetcher.mockResolvedValueOnce(json({ message: "secret upstream content" }, status))
      const result = await source.get("site", "")
      expect(result.problem).toBeTruthy()
      expect(JSON.stringify(result)).not.toContain("secret")
    }
    fetcher.mockRejectedValueOnce(new Error("secret-token"))
    expect((await source.get("site", "")).problem).toBe("Couldn't reach GitHub. Try again.")
    fetcher.mockResolvedValueOnce(json({ unexpected: true }))
    expect((await source.get("site", "")).problem).toContain("unexpected response")
    fetcher.mockResolvedValueOnce(json([]))
    expect(await source.get("site", "")).toMatchObject({ items: [], problem: null })
  })
})

describe("GitHub reference text", () => {
  it("finds numbers, Unicode titles and multiple title words while preserving headings and mid-word hashes", () => {
    for (const q of ["", "12", "retry webhooks", "café"]) expect(githubMentionAt(`see #${q}`, 5 + q.length)).toMatchObject({ start: 4, query: q })
    for (const text of ["# Heading", "## Heading", "C#", "acme/site#12", "https://example.com/#thing"]) expect(githubMentionAt(text, text.length)).toBeNull()
    expect(githubMentionAt("#test", -1)).toBeNull()
    expect(githubMentionAt("#old then #new", 14)).toMatchObject({ start: 10, query: "new" })
  })

  it("replaces the whole typed range, keeps following text and includes useful context for another recipient", () => {
    const text = "See #retr please"
    const next = insertGithubReference(text, githubMentionAt(text, 9)!, { number: 12, title: "Retry webhooks", kind: "pull", state: "open", url: "https://github.com/acme/site/pull/12" }, "acme/site")
    expect(next.value).toBe("See [PR acme/site#12: Retry webhooks](https://github.com/acme/site/pull/12) please")
    expect(next.value.slice(next.caret)).toBe("please")
  })

  it("keeps title punctuation literal inside one Markdown link", () => {
    const next = insertGithubReference("#", { start: 0, end: 1 }, { number: 12, title: "Use [webhooks] & *backoff*", kind: "pull", state: "open", url: "https://github.com/acme/site/pull/12" }, "acme/site")
    const html = renderToStaticMarkup(createElement(ReactMarkdown, null, next.value))
    expect(html).toContain('href="https://github.com/acme/site/pull/12"')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain("Use [webhooks] &amp; *backoff*")
    expect(html).not.toContain("<em>")
  })

  it("keeps shortcut-like title text literal without reopening lookup or adding routing picks", () => {
    const title = "Fix #123 with @box !codex %site"
    const next = insertGithubReference("#", { start: 0, end: 1 }, { number: 12, title, kind: "issue", state: "open", url: "https://github.com/acme/site/issues/12" }, "acme/site")
    expect(githubMentionAt(next.value, next.caret)).toBeNull()
    expect(tagsIn(next.value, {
      runsOn: buildRunTargets({ problems: { local: null, box: null, docker: null, gpu: null }, machines: [], localLabel: null }),
      agent: buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } }),
      project: buildProjectTargets([{ id: "prj_site", name: "Site" }]),
    })).toEqual([])
    expect(renderToStaticMarkup(createElement(ReactMarkdown, null, next.value))).toContain(title)
  })
})
