import { randomUUID } from "node:crypto"
import { q } from "./providers/types.js"

export interface BranchEvidence {
  branches: string[]
  merged: string[]
  documents: string[]
}

type Style = { prefix: string; ticket: "none" | "number" | "key" | "issue"; position: "start" | "end"; separator: string; casing: "lower" | "upper" | "camel" | "pascal"; key: string }
const DEFAULT: Style = { prefix: "", ticket: "none", position: "start", separator: "-", casing: "lower", key: "" }
const TYPES = /^(feature|feat|fix|bug|bugfix|hotfix|task|chore|docs|test|refactor|cleanup|build|ci|perf|ui|design)\//i
// Generated tool/asset refs aren't a repository's human naming convention.
const TOOL = /^(boxyard|claude|cursor|codex|dependabot|renovate)(?:[\/-]|$)/i
const IGNORED = /^(main|master|develop|development|dev|staging|production|HEAD|original|v\d+|.*-epic|pr-assets|pr-images.*|revert-.*|release[\/-].*)$/i

function shape(name: string): Style | null {
  if (TOOL.test(name) || IGNORED.test(name) || name.startsWith("refs/")) return null
  const prefix = name.match(TYPES)?.[0] ?? ""
  let rest = name.slice(prefix.length)
  if (rest.includes("/")) return null
  const style = { ...DEFAULT, prefix }
  const key = rest.match(/^([A-Za-z][A-Za-z0-9]*-)(\d+)([-_])/)
  const number = rest.match(/^(?:(issue[-_]))?(\d+)([-_])/i)
  const end = rest.match(/([-_])(\d+)$/)
  if (number) {
    style.ticket = number[1] ? "issue" : "number"
    style.key = number[1] ?? ""
    style.separator = number[3]!
    rest = rest.slice(number[0].length)
  } else if (key) {
    style.ticket = "key"
    style.key = key[1]!
    style.separator = key[3]!
    rest = rest.slice(key[0].length)
  } else if (end) {
    style.ticket = "number"
    style.position = "end"
    style.separator = end[1]!
    rest = rest.slice(0, -end[0].length)
  }
  if (!/[a-z]/i.test(rest)) return null
  if (rest.includes("_")) style.separator = "_"
  if (rest === rest.toUpperCase()) style.casing = "upper"
  else if (!/[-_]/.test(rest) && /[a-z][A-Z]/.test(rest)) style.casing = /^[A-Z]/.test(rest) ? "pascal" : "camel"
  return style
}

function kind(title: string) {
  title = title.replace(/^(?:[A-Z][A-Z0-9]+-\d+|#\d+|(?:issue|ticket|story)\s*[:#]?\s*\d+)\s*[:\s-]*/i, "")
  if (/^(fix|bug|hotfix|repair|resolve)\b/i.test(title)) return "fix"
  if (/^(docs?|document)\b/i.test(title)) return "docs"
  if (/^(test|tests|testing)\b/i.test(title)) return "test"
  if (/^(refactor|cleanup|clean up)\b/i.test(title)) return "refactor"
  if (/^(chore|build|ci|perf)\b/i.test(title)) return title.split(/\W/)[0]!.toLowerCase()
  return "feature"
}
function family(prefix: string) {
  const p = prefix.toLowerCase().replace(/\/$/, "")
  return /^(fix|bug|bugfix|hotfix)$/.test(p) ? "fix" : /^(feature|feat|task)$/.test(p) ? "feature" : p === "cleanup" ? "refactor" : p
}

/** Require repeated, dominant evidence; a single stray branch never sets a convention. */
function dominant(styles: Style[]): Style | null {
  const votes = new Map<string, { style: Style; count: number }>()
  for (const style of styles) {
    const key = JSON.stringify(style)
    const entry = votes.get(key) ?? { style, count: 0 }
    entry.count++
    votes.set(key, entry)
  }
  const ranked = [...votes.values()].sort((a, b) => b.count - a.count)
  const top = ranked[0]
  return top && top.count >= 2 && top.count / styles.length >= 0.6 ? top.style : null
}

/** Read branch-specific prose/examples only; unrelated ticket references in docs aren't conventions. */
function documented(documents: string[], title: string): Style | null {
  const styles: Style[] = []
  let casing: Style["casing"] | undefined
  let separator: string | undefined
  for (const document of documents) {
    let section = false
    for (const line of document.split(/\r?\n/)) {
      if (/^#{1,6}\s/.test(line)) section = /branch/i.test(line)
      else if (/^\s*branch(?:es|ing| names?| naming)?\s*:/i.test(line)) section = true
      if (!section && !/\bbranch(?:es|ing)?\b|git\s+(?:checkout\s+-b|switch\s+-c)/i.test(line)) continue
      if (/snake.case/i.test(line)) separator = "_"
      if (/kebab.case/i.test(line)) separator = "-"
      if (/camelCase/.test(line)) casing = "camel"
      if (/PascalCase/.test(line)) casing = "pascal"
      if (/upper.case/i.test(line)) casing = "upper"
      if (/lower.case/i.test(line)) casing = "lower"
      // Templates are interpreted as data, never shell commands or instructions to execute.
      const templated = line.replace(/<[^>]+>|\{[^}]+\}/g, (token) => /type|kind/i.test(token) ? kind(title) : /ticket|issue|story|number|\bid\b/i.test(token) ? "123" : "descriptive-slug")
      const samples = templated.match(/(?:[A-Za-z][A-Za-z0-9_-]*\/)?(?:[A-Za-z]+-\d+[-_]|\d+[-_]|issue-\d+-)?[A-Za-z][\w-]*[-_][\w-]+/g) ?? []
      for (const sample of samples) {
        const style = shape(sample)
        if (style && (style.prefix || style.ticket !== "none")) styles.push(style)
      }
      if (!samples.some((s) => shape(s)?.prefix)) {
        for (const prefix of line.match(/\b(?:feature|feat|fix|bug|bugfix|hotfix|task|chore|docs|test|refactor)\//gi) ?? []) {
          styles.push({ ...DEFAULT, prefix })
        }
      }
    }
  }
  const matching = styles.filter((s) => family(s.prefix) === kind(title))
  const selected = matching[0] ?? (styles.length === 1 ? styles[0] : undefined)
  return selected || casing || separator ? { ...(selected ?? DEFAULT), ...(casing ? { casing } : {}), ...(separator ? { separator } : {}) } : null
}

function convention(evidence: BranchEvidence, title: string): Style {
  const docs = documented(evidence.documents, title)
  if (docs) return docs
  // Recent merged heads win over stale remote branches. Deduplicate PRs from the same head.
  for (const names of [evidence.merged, [...evidence.merged, ...evidence.branches]]) {
    const styles = [...new Set(names)].map(shape).filter((s): s is Style => s !== null)
    const matching = styles.filter((s) => family(s.prefix) === kind(title))
    const selected = dominant(matching) ?? dominant(styles.filter((s) => !s.prefix))
    if (selected) return selected
  }
  return DEFAULT
}

function ticketOf(text: string, style: Style) {
  const key = text.match(/\b([A-Z][A-Z0-9]+)-(\d+)\b/) ?? (style.ticket === "key" ? text.match(new RegExp(`\\b(${style.key.slice(0, -1)})-(\\d+)\\b`, "i")) : null)
  if (key) return { key: key[1]!, number: key[2]! }
  const number = text.match(/(?:\b(?:issue|ticket|story)[\s_-]*[:#]?\s*|(?<![\w/])#|github\.com\/[^\s/]+\/[^\s/]+\/issues\/)(\d+)\b/i)
  return number ? { key: "", number: number[1]! } : null
}

export function branchName(input: { title: string; prompt?: string; evidence?: BranchEvidence; occupied?: Iterable<string>; suffix?: () => string }): string {
  const evidence = input.evidence ?? { branches: [], merged: [], documents: [] }
  const style = convention(evidence, input.title)
  const ticket = ticketOf(`${input.title}\n${input.prompt ?? ""}`, style)
  let title = input.title
  if (ticket) title = title.replace(new RegExp(`(?:\\b${ticket.key ? ticket.key + "-" : "(?:issue|ticket|story)[\\s_-]*[:#]?\\s*"}|#)${ticket.number}\\b`, "ig"), "")
  if (style.prefix) title = title.trimStart().replace(/^(feature|feat|fix|bug|bugfix|hotfix|task|chore|docs?|test|refactor|cleanup)\b[:\s-]*/i, "")
  const words = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+/gi)?.map((w) => w.toLowerCase()) ?? ["task"]
  let slug = words.join(style.separator).slice(0, 70).replace(/[-_]$/, "")
  if (style.casing === "upper") slug = slug.toUpperCase()
  if (style.casing === "camel" || style.casing === "pascal") slug = words.map((w, i) => i || style.casing === "pascal" ? w[0]!.toUpperCase() + w.slice(1) : w).join("").slice(0, 70)
  let id = ""
  if (ticket && style.ticket !== "none") {
    const key = ticket.key ? (style.key === style.key.toLowerCase() ? ticket.key.toLowerCase() : ticket.key.toUpperCase()) + "-" : style.key
    id = style.ticket === "key" ? `${key}${ticket.number}` : style.ticket === "issue" ? `${style.key}${ticket.number}` : ticket.number
  } else if (ticket) id = ticket.key ? `${ticket.key}-${ticket.number}` : ticket.number
  // Never add tool branding, including when it appeared in repo docs.
  let name = `${style.prefix}${id && style.position === "start" ? id + style.separator : ""}${slug}${id && style.position === "end" ? style.separator + id : ""}`
  const occupied = [...(input.occupied ?? []), ...evidence.branches, ...evidence.merged]
  // A branch called "fix" prevents Git creating any "fix/..." ref; a suffix on the leaf can't solve that.
  if (occupied.some((b) => name.startsWith(b + "/"))) name = name.replaceAll("/", "-")
  const collides = (candidate: string) => occupied.some((b) => b === candidate || b.startsWith(candidate + "/") || candidate.startsWith(b + "/"))
  let candidate = name
  while (collides(candidate)) {
    const suffix = (input.suffix ?? (() => randomUUID().slice(0, 4)))()
    candidate = `${name}${style.separator}${style.casing === "upper" ? suffix.toUpperCase() : suffix}`
  }
  return candidate
}

export const BRANCH_EVIDENCE_MARK = "boxyard-branch-evidence="

/** Runs on any provider, against the fresh clone's remote refs. All subprocess arguments are data. */
export function branchEvidenceScript(node: string, work: string, base: string, repo: string | null, github: boolean): string {
  const script = `
    const { spawnSync } = require('node:child_process');
    const run = (bin, args, required = false) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN || '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } }); if (required && r.status !== 0) throw new Error('Could not inspect remote branch refs'); return r.status === 0 ? r.stdout : ''; };
    const git = (args, required = false) => run('git', ['-C', ${JSON.stringify(work)}, ...args], required);
    const branches = git(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'], true).trim().split('\\n').filter(Boolean);
    const base = ${JSON.stringify(base)};
    const files = git(['ls-tree', '-r', '--name-only', base, '--', 'CONTRIBUTING.md', 'CONTRIBUTING', 'AGENTS.md', 'CLAUDE.md', '.github']).trim().split('\\n').filter(p => /^(CONTRIBUTING(?:\\.md)?|AGENTS\\.md|CLAUDE\\.md|\\.github\\/.*\\.md)$/i.test(p)).sort((a, b) => Number(a.startsWith('.github/')) - Number(b.startsWith('.github/'))).slice(0, 20);
    const documents = files.map(p => git(['show', base + ':' + p]).slice(0, 16000));
    let merged = [];
    if (${JSON.stringify(Boolean(repo) && github)}) { try { merged = JSON.parse(run('gh', ['pr', 'list', '--repo', ${JSON.stringify(repo ?? "")}, '--state', 'merged', '--limit', '50', '--json', 'headRefName'])).map(p => p.headRefName).filter(n => typeof n === 'string'); } catch {} }
    console.log(${JSON.stringify(BRANCH_EVIDENCE_MARK)} + JSON.stringify({ branches, merged, documents }));
  `
  return `${q(node)} -e ${q(script)}`
}

export function parseBranchEvidence(stdout: string): BranchEvidence {
  try {
    const line = stdout.split("\n").find((l) => l.startsWith(BRANCH_EVIDENCE_MARK))
    const value = JSON.parse(line?.slice(BRANCH_EVIDENCE_MARK.length) ?? "{}")
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []
    return { branches: strings(value.branches), merged: strings(value.merged), documents: strings(value.documents) }
  } catch {
    return { branches: [], merged: [], documents: [] }
  }
}
