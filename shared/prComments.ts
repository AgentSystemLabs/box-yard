// New comments on a task's open pull request since its owner last opened the PR from Box Yard (server/prComments.ts).
//
// What counts as one new comment, written after the last view (every one when the PR was never opened from Box Yard):
//   - a comment in the PR's conversation,
//   - a review submitted with a summary of its own,
//   - a comment on the code in a review thread that isn't resolved.
// Comments by the PR's author and by the account of the project's GitHub token (the agents write with it) don't count,
// and neither do comments in resolved threads. Only open and draft PRs are counted.

/** Settings › New PR comments, in minutes: how often the background round asks GitHub. 0 is off. */
export const PR_COMMENT_MINUTES = { default: 5, off: 0, options: [0, 1, 2, 5, 10, 15, 30, 60] } as const

/** A Settings option in words: "Off", "Every minute", "Every 5 minutes (default)", "Every hour". */
export function prCommentMinutesLabel(minutes: number): string {
  if (!minutes) return "Off"
  const every = minutes === 1 ? "Every minute" : minutes === 60 ? "Every hour" : `Every ${minutes} minutes`
  return minutes === PR_COMMENT_MINUTES.default ? `${every} (default)` : every
}

/** The most a badge says: "99+" past it. */
export const PR_COMMENT_BADGE_MAX = 99

/**
 * "owner/repo#12", lower case, for a github.com pull request URL (its files, a comment anchor or its "/issues/12" form
 * included): the one name a PR's views are saved under, however the link to it was written.
 */
export function prViewKey(url: string | null | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i.exec(url ?? "")
  return m ? `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase() : null
}

/** One thing someone wrote on a PR that counts (see above). */
export interface PrRemark {
  /** When it was written (a review: submitted). */
  at: number
  /** Its author's GitHub login, or null for a deleted account. */
  author: string | null
}

/** How many of `remarks` were written after `since` (null: never viewed, so all of them) by someone not in `exclude`. */
export function countNewComments(remarks: readonly PrRemark[], since: number | null, exclude: readonly (string | null | undefined)[]): number {
  const ours = new Set(exclude.filter((login): login is string => Boolean(login)).map((login) => login.toLowerCase()))
  const after = since ?? 0
  return remarks.filter((r) => r.at > after && !(r.author && ours.has(r.author.toLowerCase()))).length
}

/** The badge's number: "5", or "99+". */
export const prCommentsText = (count: number) => (count > PR_COMMENT_BADGE_MAX ? `${PR_COMMENT_BADGE_MAX}+` : String(count))

/**
 * The badge's title and accessible name: "5 new comments since you last opened this PR" (what counts: see above).
 * `viewed`: whether the PR was ever opened from Box Yard, when known.
 */
export function prCommentsLabel(count: number, viewed?: boolean): string {
  const n = prCommentsText(count)
  if (viewed === false) return `${n} ${count === 1 ? "comment" : "comments"} to read: you haven't opened this PR from Box Yard yet`
  return `${n} new ${count === 1 ? "comment" : "comments"} since you last opened this PR`
}

/** What the count leaves out, for the tooltip's second line. */
export const PR_COMMENTS_RULE = "Not counted: the PR author's and the project's GitHub account's own comments, and resolved threads."
