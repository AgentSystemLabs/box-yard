// The pull request a task reviews (Task.reviewPrUrl): set when the task is created, from the create call's
// `reviews_pr`, else read from its title and prompt. It is never the task's own PR (Task.prUrl): Box Yard shows it and
// follows its state, and nothing else. Pure, so it is unit tested and the web app can use it too.

/** The canonical URL of a github.com pull request. */
export const githubPrUrl = (owner: string, name: string, number: number) => `https://github.com/${owner}/${name}/pull/${number}`

/** "owner/name/number", lower case, for comparing two PR URLs (shared/prTasks.ts prKey reads the same shape). */
export function reviewPrKey(url: string | null | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url ?? "")
  return m ? `${m[1]}/${m[2]}/${Number(m[3])}`.toLowerCase() : null
}

/** Whether two URLs name the same pull request. False when either isn't one. */
export function samePr(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = reviewPrKey(a)
  return ka !== null && ka === reviewPrKey(b)
}

const SLUG = /^([\w.-]+)\/([\w.-]+)$/

/**
 * One explicit reference to a pull request, as a Captain or the Coordinator writes it: a github.com PR URL,
 * `owner/repo#90`, or (for the project's repo, `repoSlug`) `#90`, `90`, `PR #90` or `pull request #90`. Its canonical
 * URL, or null when it isn't one.
 */
export function parsePrRef(ref: string, repoSlug: string | null): string | null {
  const s = ref.trim()
  const url = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(s)
  if (url) return githubPrUrl(url[1]!, url[2]!, Number(url[3]))
  const full = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s)
  if (full) return githubPrUrl(full[1]!, full[2]!, Number(full[3]))
  const own = /^(?:(?:PR|pull request)\s*)?#?(\d+)$/i.exec(s)
  const slug = repoSlug ? SLUG.exec(repoSlug) : null
  if (own && slug && Number(own[1]) > 0) return githubPrUrl(slug[1]!, slug[2]!, Number(own[1]))
  return null
}

interface Found {
  url: string
  index: number
}

/** Every PR reference in a text, in order: PR URLs and `owner/repo#N` anywhere, `PR #N` for the project's repo. */
function prRefs(text: string, repoSlug: string | null): Found[] {
  const found: Found[] = []
  for (const m of text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi)) {
    found.push({ url: githubPrUrl(m[1]!, m[2]!, Number(m[3])), index: m.index! })
  }
  // owner/repo#N, not inside a URL (github.com/owner/repo/…#N has a slash before the #).
  for (const m of text.matchAll(/(?<![\w./-])([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d+)\b/g)) {
    found.push({ url: githubPrUrl(m[1]!, m[2]!, Number(m[3])), index: m.index! })
  }
  const slug = repoSlug ? SLUG.exec(repoSlug) : null
  if (slug) {
    for (const m of text.matchAll(/\b(?:PR|pull request)\s*#(\d+)\b/gi)) {
      if (Number(m[1]) > 0) found.push({ url: githubPrUrl(slug[1]!, slug[2]!, Number(m[1])), index: m.index! })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

/** The words that make a task a review: review, reviewing, re-review, audit. Not "reviewed" or "reviewer". */
const REVIEW_WORD = /\b(?:re-?)?review(?:s|ing)?\b|\baudit(?:s|ing)?\b/i
/** The same, ending just before a reference on the same line: "review PR #90", "Please review https://…/pull/90". */
const REVIEW_BEFORE = /\b(?:re-?)?review(?:s|ing)?\b[^.\n]{0,24}$|\baudit(?:s|ing)?\b[^.\n]{0,24}$/i

/**
 * The pull request a new task reviews, read from its title and prompt, or null. Only a review counts, so a task that
 * fixes, rebases or merges a PR (whose branch it may push to) is never taken for one:
 * - a title that says review ("Review PR #90 (…) and leave a verdict comment") names it, or else the one PR its prompt
 *   names;
 * - otherwise a prompt that asks for one ("please review https://github.com/acme/site/pull/90").
 * `repoSlug` is the project's GitHub repo (owner/name), for "PR #90".
 */
export function detectReviewedPr(title: string, prompt: string, repoSlug: string | null): string | null {
  if (REVIEW_WORD.test(title)) {
    const inTitle = prRefs(title, repoSlug)[0]
    if (inTitle) return inTitle.url
    const inPrompt = [...new Set(prRefs(prompt, repoSlug).map((r) => r.url))]
    if (inPrompt.length === 1) return inPrompt[0]!
  }
  for (const ref of prRefs(prompt, repoSlug)) {
    const line = prompt.slice(Math.max(0, ref.index - 60), ref.index)
    if (REVIEW_BEFORE.test(line)) return ref.url
  }
  return null
}
