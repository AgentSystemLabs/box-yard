import type { GithubReference } from "../../../shared/githubReferences"

/** Title terms may include spaces. A space immediately after # remains a Markdown heading. */
export function githubMentionAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (caret < 0) return null
  const match = /(^|[\s(["'])#([^\n#]*)$/.exec(text.slice(0, caret))
  if (!match || /^\s/.test(match[2]!) || match[2]!.length > 120) return null
  const start = match.index + match[1]!.length
  let end = caret
  while (end < text.length && /[\p{L}\p{N}_.-]/u.test(text[end]!)) end++
  return { start, end, query: match[2]!.trim().toLowerCase() }
}

/** Full URL plus kind, repository, number and title survives routing/forwarding to any recipient. */
export function insertGithubReference(text: string, mention: { start: number; end: number }, ref: GithubReference, repo: string): { value: string; caret: number } {
  const after = text.slice(mention.end)
  const title = ref.title.replace(/[\r\n]+/g, " ").replace(/[\\[\]`*_<>]/g, "\\$&")
  const insert = `[${ref.kind === "pull" ? "PR" : "Issue"} ${repo}#${ref.number}: ${title}](${ref.url})${after.startsWith(" ") ? "" : " "}`
  return { value: text.slice(0, mention.start) + insert + after, caret: mention.start + insert.length + (after.startsWith(" ") ? 1 : 0) }
}
