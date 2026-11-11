// Ranking for the command palette (Cmd+K): prefixes, match tiers, field weights, boosts, groups and caps. Pure, so it is unit tested.
import type { TaskStatus } from "../../../shared/types"
import type { PaletteItem, PaletteKind } from "./palette"
import { titleHasWords } from "./subtaskSearch"

// ------------------------------------------------------------------ prefixes

/** What a prefix narrows the search to. */
export type PaletteScope = "command" | "pr" | "file" | "project" | "box"

export const PREFIXES: { prefix: string; scope: PaletteScope; label: string }[] = [
  { prefix: ">", scope: "command", label: "Commands" },
  { prefix: "#", scope: "pr", label: "PRs" },
  { prefix: "f:", scope: "file", label: "Files" },
  { prefix: "p:", scope: "project", label: "Projects" },
]

const SCOPE_KINDS: Record<PaletteScope, PaletteKind[]> = {
  command: ["action", "page"],
  pr: ["pr"],
  file: ["artifact"],
  project: ["project"],
  box: ["box"],
}

export interface ParsedQuery {
  scope: PaletteScope | null
  /** Lowercase, trimmed, single-spaced. */
  query: string
}

export const normalizeQuery = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")

/** Splits a leading prefix (`>`, `#`, `f:`, `p:`, `@`) off the raw input. */
export function parseQuery(raw: string): ParsedQuery & { rest: string } {
  const trimmed = raw.trimStart()
  for (const p of PREFIXES) {
    if (trimmed.slice(0, p.prefix.length).toLowerCase() === p.prefix) {
      const rest = trimmed.slice(p.prefix.length).trimStart()
      return { scope: p.scope, query: normalizeQuery(rest), rest }
    }
  }
  return { scope: null, query: normalizeQuery(raw), rest: raw }
}

// ------------------------------------------------------------------ matching

export type MatchTier = "exact" | "prefix" | "word" | "substring" | "fuzzy"

/** Each tier has its own band, so no length or position penalty can drop a match into the tier below. */
const TIER_BASE: Record<MatchTier, number> = { exact: 1000, prefix: 800, word: 600, substring: 400, fuzzy: 200 }
const BAND = 40

const BOUNDARY = /[\s\-_/.:#()[\]]/

/** Which tier `q` (lowercase, non-empty) hits in `text`, with a 0..1 penalty inside the tier. */
export function matchText(text: string, q: string, allowFuzzy = true): { tier: MatchTier; penalty: number } | null {
  return matchLower(text.toLowerCase(), q, allowFuzzy)
}

/** matchText for text that is already lowercase, like the palette index's. */
function matchLower(t: string, q: string, allowFuzzy: boolean): { tier: MatchTier; penalty: number } | null {
  if (!t || !q) return null
  if (t === q) return { tier: "exact", penalty: 0 }
  if (t.startsWith(q)) return { tier: "prefix", penalty: Math.min(1, (t.length - q.length) / 40) }
  const idx = t.indexOf(q)
  if (idx >= 0) {
    // Any occurrence at a word start beats a mid-word one.
    for (let i = idx; i > 0; i = t.indexOf(q, i + 1)) if (BOUNDARY.test(t[i - 1]!)) return { tier: "word", penalty: Math.min(1, i / 80) }
    return { tier: "substring", penalty: Math.min(1, idx / 80) }
  }
  if (!allowFuzzy) return null
  const f = fuzzy(t, q)
  return f === null ? null : { tier: "fuzzy", penalty: f }
}

/** Subsequence match ("cmdpal" → "command palette") starting at a word; rewards runs and word starts, rejects scattered hits. */
function fuzzy(t: string, q: string): number | null {
  if (q.length < 2) return null
  let from = 0
  while (from < t.length && (t[from] !== q[0] || (from > 0 && !BOUNDARY.test(t[from - 1]!)))) from++
  if (from >= t.length) return null
  let prev = -2
  let first = -1
  let bonus = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return null
    if (first < 0) first = i
    if (i === prev + 1) bonus += 2
    if (i === 0 || BOUNDARY.test(t[i - 1]!)) bonus += 3
    prev = i
    from = i + 1
  }
  const span = prev - first + 1
  if (span > q.length * 3 + 3) return null
  const quality = bonus / (q.length * 5) - (span - q.length) / (q.length * 3) - Math.min(1, first / 40) / 2
  return Math.min(1, Math.max(0, 1 - quality))
}

/** Score of `q` in `text`, or null: exact > prefix > word start > substring > fuzzy subsequence. */
export function scoreText(text: string, q: string, allowFuzzy = true): number | null {
  return scoreLower(text.toLowerCase(), q, allowFuzzy)
}

function scoreLower(t: string, q: string, allowFuzzy: boolean): number | null {
  const m = matchLower(t, q, allowFuzzy)
  return m && TIER_BASE[m.tier] + BAND * (1 - m.penalty)
}

/** A title (or a file name, or a PR number) counts in full; ids and repos less; project names, summaries and keywords least. */
export const FIELD_WEIGHT = { title: 1, alias: 0.75, detail: 0.5 } as const
/** A one-word query this short ("do", "id") isn't a state or section word yet. */
const KEYWORD_MIN = 3

/** One searchable string of an item, lowercased once, with its weight and whether a fuzzy hit counts. */
interface Field {
  text: string
  weight: number
  fuzzy: boolean
}

/** An item with its search text prepared, so a keystroke only compares strings. */
export interface IndexedItem {
  item: PaletteItem
  /** Title, names, aliases and details. */
  fields: Field[]
  /** Matched from a word start, and word by word in multi-word queries. */
  keywords: Field[]
}

function indexItem(item: PaletteItem): IndexedItem {
  const field = (weight: number, fuzzy: boolean) => (text: string) => ({ text: text.toLowerCase(), weight, fuzzy })
  // Empty strings never match, so they are left out.
  const filled = (f: Field) => f.text !== ""
  return {
    item,
    fields: [
      field(FIELD_WEIGHT.title, true)(item.title),
      ...(item.names ?? []).map(field(FIELD_WEIGHT.title, true)),
      ...(item.aliases ?? []).map(field(FIELD_WEIGHT.alias, true)),
      // Summaries are long: a scattered subsequence in one means nothing.
      ...(item.details ?? []).map(field(FIELD_WEIGHT.detail, false)),
    ].filter(filled),
    keywords: (item.keywords ?? []).map(field(FIELD_WEIGHT.detail, false)).filter(filled),
  }
}

// buildItems keeps an unchanged row's items, so their entries outlive the list they came in.
const entries = new WeakMap<PaletteItem, IndexedItem>()
const indexes = new WeakMap<readonly PaletteItem[], IndexedItem[]>()

/** The search index of a list from buildItems: built once (the open palette does it after it paints) and kept while the list lives. Don't mutate a list or its items once they're searched. */
export function paletteIndex(items: readonly PaletteItem[]): IndexedItem[] {
  let index = indexes.get(items)
  if (!index) indexes.set(items, (index = items.map(entryOf)))
  return index
}

function entryOf(item: PaletteItem): IndexedItem {
  let entry = entries.get(item)
  if (!entry) entries.set(item, (entry = indexItem(item)))
  return entry
}

/** The best weighted score of `q` in any of `fields`, or `best` when none beats it. */
function bestField(fields: Field[], q: string, best: number | null): number | null {
  for (const f of fields) {
    const s = scoreLower(f.text, q, f.fuzzy)
    if (s !== null && (best === null || s * f.weight > best)) best = s * f.weight
  }
  return best
}

/** How well an item's own text matches a lowercase, normalized query, before boosts. */
export function matchItem(item: PaletteItem, q: string): number | null {
  return matchIndexed(indexItem(item), q, q.split(" "))
}

/** matchItem on the index; `words` is `q` split on spaces, once per query instead of once per item. */
function matchIndexed({ fields, keywords }: IndexedItem, q: string, words: string[]): number | null {
  let best = bestField(fields, q, null)
  // Keywords count from a word start only, so "done" lists the done tasks but "on" doesn't match "done".
  if (q.length >= KEYWORD_MIN) {
    for (const f of keywords) {
      const m = matchLower(f.text, q, false)
      const s = m && m.tier !== "substring" ? (TIER_BASE[m.tier] + BAND * (1 - m.penalty)) * f.weight : null
      if (s !== null && (best === null || s > best)) best = s
    }
  }
  if (best !== null) return best
  // "box-yard failed": every word has to hit some field, keywords included.
  if (words.length < 2) return null
  let total = 0
  for (const w of words) {
    const wordBest = bestField(keywords, w, bestField(fields, w, null))
    if (wordBest === null) return null
    total += wordBest
  }
  return (total / words.length) * 0.7
}

/**
 * Whether an item could match `q`: each word is in one of its fields or, where fuzzy hits count, spread through one in
 * order. Every match passes, and so does every match of a longer query, so a keystroke that adds to the query only
 * has to look at the items the last one let through.
 */
function couldMatch({ item, fields, keywords }: IndexedItem, q: string, words: string[]): boolean {
  // ".jpeg" also lists "logo.jpg" (extensionOnlyScore).
  if (item.kind === "artifact" && EXTENSION_ONLY.test(q)) return true
  return words.every((w) => fields.some((f) => (f.fuzzy ? inOrder(f.text, w) : f.text.includes(w))) || keywords.some((f) => f.text.includes(w)))
}

/** Whether the characters of `q` appear in `t` in order. */
function inOrder(t: string, q: string): boolean {
  let from = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return false
    from = i + 1
  }
  return true
}

/** Per index: the last query ranked on it and the items that could still match it. */
const survivors = new WeakMap<IndexedItem[], { scope: PaletteScope | null; q: string; entries: IndexedItem[] }>()

// ------------------------------------------------------------------ files

/** Extensions that make a query clearly about a file. */
export const FILE_EXTENSIONS = new Set(
  "png jpg jpeg gif svg webp avif ico bmp html htm md markdown csv tsv json jsonl yaml yml xml webm mp4 mov m4v mp3 wav ogg txt log pdf zip tar gz ts tsx js jsx css py sh sql".split(" "),
)

const SAME_EXT: Record<string, string> = { jpeg: "jpg", htm: "html", markdown: "md", yml: "yaml" }
const canonicalExt = (ext: string) => SAME_EXT[ext] ?? ext
const extOf = (name: string) => /\.([a-z0-9]+)$/.exec(name.toLowerCase())?.[1] ?? null

/** The known file extension a query names, e.g. ".png" or "logo.png" → "png". */
export function queryExtension(q: string): string | null {
  const m = /(?:^|\S)\.([a-z0-9]{1,8})$/.exec(q.trim().toLowerCase())
  return m && FILE_EXTENSIONS.has(m[1]!) ? m[1]! : null
}

const fileNames = (item: PaletteItem) => item.names ?? []
const stem = (name: string) => name.toLowerCase().replace(/\.[a-z0-9]+$/, "")

/** True when the query names a file extension or (nearly) a file's whole name, so files should go first. */
export function targetsFile(q: string, items: PaletteItem[]): boolean {
  if (!q) return false
  if (queryExtension(q)) return true
  if (q.length < 3) return false
  return items.some(
    (i) =>
      i.kind === "artifact" &&
      fileNames(i).some((n) => {
        const name = n.toLowerCase()
        const s = stem(name)
        return name === q || s === q || (name.startsWith(q) && q.length >= Math.max(4, s.length * 0.8))
      }),
  )
}

const EXTENSION_ONLY = /^\.[a-z0-9]+$/

/** A bare ".png" lists every PNG; the extension is part of the name, but not at a word start. */
function extensionOnlyScore(item: PaletteItem, q: string): number | null {
  if (item.kind !== "artifact" || !EXTENSION_ONLY.test(q)) return null
  const want = canonicalExt(q.slice(1))
  return fileNames(item).some((n) => canonicalExt(extOf(n) ?? "") === want) ? TIER_BASE.word + BAND : null
}

// ------------------------------------------------------------------ boosts

/** Tasks win ties against everything else, files included. */
export const KIND_BOOST: Record<PaletteKind, number> = { task: 60, pr: 60, project: 30, page: 20, setting: 10, schedule: 10, action: 0, box: 0, artifact: 0 }
/** Enough to lift any file match over any task match. */
export const FILE_INTENT_BOOST = 600
const ACTIVE_BOOST: Partial<Record<TaskStatus, number>> = { needs_input: 20, pr_ready: 20, working: 12, starting: 12, queued: 8, waiting: 8, failed: 6 }
const RECENCY_BOOST = 20
const DAY = 86_400_000

/** Up to +20, halving every day since the task last changed. */
export const recencyBoost = (at: number | undefined, now: number) => (at ? RECENCY_BOOST * 0.5 ** (Math.max(0, now - at) / DAY) : 0)

export interface RankContext {
  now: number
  /** Command key → times it was run from the palette. */
  usage?: Record<string, number>
  fileIntent?: boolean
}

/** An item's full score for a query: match quality × field weight, plus kind, recency, status and usage boosts. */
export function scoreItem(item: PaletteItem, q: string, ctx: RankContext): number | null {
  return scoreIndexed(indexItem(item), q, q.split(" "), ctx)
}

function scoreIndexed(entry: IndexedItem, q: string, words: string[], ctx: RankContext): number | null {
  const { item } = entry
  const match = extensionOnlyScore(item, q) ?? matchIndexed(entry, q, words)
  if (match === null) return null
  let score = match + KIND_BOOST[item.kind]
  if (item.kind === "task" || item.kind === "pr") {
    score += recencyBoost(item.at, ctx.now) + (item.taskStatus ? (ACTIVE_BOOST[item.taskStatus] ?? 0) : 0)
  }
  if (isCommand(item)) score += Math.min(20, 2 * (ctx.usage?.[item.key] ?? 0))
  if (item.kind === "artifact" && ctx.fileIntent) score += FILE_INTENT_BOOST
  return score
}

// ------------------------------------------------------------------ groups

export type GroupKey = "waiting" | "working" | "recent" | "command" | "setting" | "task" | "subtask" | "pr" | "project" | "schedule" | "artifact" | "box"

export interface PaletteGroup {
  key: GroupKey
  label: string
  /** The rows to show: capped, unless the group is expanded. */
  items: PaletteItem[]
  /** Every match, so the "Show N more" row can say how many. */
  total: number
}

export const GROUP_LABEL: Record<GroupKey, string> = {
  // Box Yard's own label: the palette passes it through withOwner.
  waiting: "Waiting on Cody",
  working: "Working",
  recent: "Recently viewed",
  command: "Commands",
  setting: "Settings",
  task: "Tasks",
  subtask: "Sub-tasks",
  pr: "Pull requests",
  project: "Projects",
  schedule: "Schedules",
  artifact: "Files",
  box: "Boxes",
}

/** Rows a group shows before "Show N more". Sub-tasks get few: a tree of them can share every word of its parent's title. */
export const GROUP_CAP: Record<GroupKey, number> = { waiting: 5, working: 5, recent: 5, command: 4, setting: 3, task: 5, subtask: 3, pr: 5, project: 3, schedule: 3, artifact: 3, box: 3 }
/** With a prefix there is one group, so it gets more room. */
export const SCOPED_CAP = 20

/** Where groups go when their best scores tie. */
const GROUP_ORDER: GroupKey[] = ["task", "subtask", "pr", "project", "command", "setting", "schedule", "artifact", "box"]

const isCommand = (i: PaletteItem) => i.kind === "action" || i.kind === "page"
/** A sub-task (it has a parent) goes in the Sub-tasks group, so its tree can't crowd the top-level tasks out of Tasks. */
const groupOf = (i: PaletteItem): GroupKey => (isCommand(i) ? "command" : i.kind === "task" && i.parent ? "subtask" : (i.kind as GroupKey))

/** Deterministic order for equal scores: newest first, then by key, so lists don't shuffle as you type. */
export const tieBreak = (a: PaletteItem, b: PaletteItem) => (b.at ?? 0) - (a.at ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export interface RankOptions {
  now?: number
  /** Item keys, most recent first (recently viewed in this browser). */
  recent?: string[]
  /** Command key → times run. */
  usage?: Record<string, number>
  /** Groups showing all their rows. */
  expanded?: ReadonlySet<GroupKey>
}

function group(key: GroupKey, all: PaletteItem[], opts: RankOptions, cap = GROUP_CAP[key]): PaletteGroup {
  return { key, label: GROUP_LABEL[key], items: opts.expanded?.has(key) ? all : all.slice(0, cap), total: all.length }
}

/** The palette's groups for a parsed query, best first. */
export function rankPalette(items: PaletteItem[], { scope, query }: ParsedQuery, opts: RankOptions = {}): PaletteGroup[] {
  const now = opts.now ?? Date.now()
  const inScope = (i: PaletteItem) => (scope ? SCOPE_KINDS[scope].includes(i.kind) : i.kind !== "pr")
  // "#78" inside the PR scope means PR 78.
  const q = scope === "pr" ? query.replace(/^#/, "") : query

  if (!q) return scope ? [group(scopeGroup(scope), browseOrder(items.filter(inScope), scope, opts), opts, SCOPED_CAP)] : emptyQueryGroups(items, opts)

  const words = q.split(" ")
  const index = paletteIndex(items)
  const last = survivors.get(index)
  // Typing on narrows the last keystroke's survivors; any other change starts from the whole index.
  const from = last && last.scope === scope && q.startsWith(last.q) ? last.entries : index.filter((e) => inScope(e.item))
  const pool = from.filter((e) => couldMatch(e, q, words))
  survivors.set(index, { scope, q, entries: pool })

  // A file that targetsFile looks for always survives, so the survivors give the same answer as the whole pool.
  const ctx: RankContext = { now, usage: opts.usage, fileIntent: !scope && targetsFile(q, pool.map((e) => e.item)) }
  const scored: { item: PaletteItem; score: number }[] = []
  for (const entry of pool) {
    const score = scoreIndexed(entry, q, words, ctx)
    if (score !== null) scored.push({ item: entry.item, score })
  }
  scored.sort((a, b) => b.score - a.score || tieBreak(a.item, b.item))

  const groups = new Map<GroupKey, { items: PaletteItem[]; best: number }>()
  const subtasks: { item: PaletteItem; score: number }[] = []
  for (const s of scored) {
    const key = groupOf(s.item)
    if (key === "subtask") subtasks.push(s)
    const g = groups.get(key)
    if (g) g.items.push(s.item)
    else groups.set(key, { items: [s.item], best: s.score })
  }
  if (!scope) liftParents(groups, subtasks, items, words)
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => b.best - a.best || GROUP_ORDER.indexOf(ka) - GROUP_ORDER.indexOf(kb))
  // Sub-tasks always come right under the top-level tasks, however well they match.
  const at = (want: GroupKey) => ordered.findIndex(([key]) => key === want)
  if (at("subtask") >= 0 && at("task") >= 0) {
    const [entry] = ordered.splice(at("subtask"), 1)
    ordered.splice(at("task") + 1, 0, entry!)
  }
  return ordered.map(([key, g]) => group(key, g.items, opts, scope ? SCOPED_CAP : undefined))
}

/**
 * The top-level tasks of the sub-tasks whose titles hold every word of the query, when their own text doesn't match:
 * listed in Tasks under every direct match (best sub-task first), each saying how many of its sub-tasks match. So a
 * word from a sub-task also finds the task its tree hangs from.
 */
function liftParents(groups: Map<GroupKey, { items: PaletteItem[]; best: number }>, subtasks: { item: PaletteItem; score: number }[], items: readonly PaletteItem[], words: string[]) {
  const tasks = groups.get("task")
  const listed = new Set(tasks?.items.map((i) => i.key))
  const lifted = new Map<string, { item: PaletteItem; hits: number; best: number }>()
  for (const { item, score } of subtasks) {
    if (!item.rootKey || listed.has(item.rootKey) || !titleHasWords(item.title, words)) continue
    const known = lifted.get(item.rootKey)
    if (known) known.hits++
    else {
      const root = taskByKey(items).get(item.rootKey)
      if (root) lifted.set(item.rootKey, { item: root, hits: 1, best: score })
    }
  }
  if (!lifted.size) return
  const parents = [...lifted.values()].map((p) => ({ ...p.item, subtaskHits: p.hits }))
  if (tasks) tasks.items.push(...parents)
  else groups.set("task", { items: parents, best: [...lifted.values()][0]!.best })
}

const taskKeys = new WeakMap<readonly PaletteItem[], Map<string, PaletteItem>>()
/** A list's top-level task items by key, built once per list. */
function taskByKey(items: readonly PaletteItem[]): Map<string, PaletteItem> {
  let map = taskKeys.get(items)
  if (!map) taskKeys.set(items, (map = new Map(items.filter((i) => i.kind === "task" && !i.parent).map((i) => [i.key, i]))))
  return map
}

const scopeGroup = (scope: PaletteScope): GroupKey => (scope === "file" ? "artifact" : scope)

/** A prefix with nothing after it: the most-used commands, open PRs first, newest files and boxes, projects in the owner's order. */
function browseOrder(pool: PaletteItem[], scope: PaletteScope, opts: RankOptions): PaletteItem[] {
  if (scope === "command") return commandsByUse(pool, opts.usage)
  // Projects arrive in the saved sidebar order (buildItems keeps the list's order).
  if (scope === "project") return pool
  const open = (i: PaletteItem) => (scope === "pr" && (i.status === "merged" || i.status === "done") ? 1 : 0)
  return [...pool].sort((a, b) => open(a) - open(b) || tieBreak(a, b))
}

/** "New task…" first, then the most-used; unused ones keep their built-in order. */
function commandsByUse(items: PaletteItem[], usage: Record<string, number> = {}): PaletteItem[] {
  const commands = items.filter(isCommand)
  const order = new Map(commands.map((i, n) => [i.key, n]))
  const lead = (i: PaletteItem) => (i.command === "new-task" ? 0 : 1)
  return commands.sort((a, b) => lead(a) - lead(b) || (usage[b.key] ?? 0) - (usage[a.key] ?? 0) || order.get(a.key)! - order.get(b.key)!)
}

const WAITING: TaskStatus[] = ["needs_input", "pr_ready"]
const WORKING: TaskStatus[] = ["working", "starting"]

/** No query: tasks waiting on the owner, working tasks, recently viewed tasks and projects, then the most-used commands. No files. */
function emptyQueryGroups(items: PaletteItem[], opts: RankOptions): PaletteGroup[] {
  const tasks = items.filter((i) => i.kind === "task")
  const byStatus = (statuses: TaskStatus[]) => tasks.filter((i) => i.taskStatus && statuses.includes(i.taskStatus)).sort(tieBreak)
  const waiting = byStatus(WAITING)
  const working = byStatus(WORKING)
  const shown = new Set([...waiting, ...working].map((i) => i.key))
  // Only the few remembered keys, not a map of every item.
  const wanted = new Set(opts.recent)
  const byKey = new Map(items.filter((i) => wanted.has(i.key)).map((i) => [i.key, i]))
  const recent = (opts.recent ?? [])
    .map((k) => byKey.get(k))
    .filter((i): i is PaletteItem => Boolean(i) && (i!.kind === "task" || i!.kind === "project") && !shown.has(i!.key))

  const groups: PaletteGroup[] = []
  if (waiting.length) groups.push(group("waiting", waiting, opts))
  if (working.length) groups.push(group("working", working, opts))
  if (recent.length) groups.push(group("recent", recent, opts))
  groups.push(group("command", commandsByUse(items, opts.usage), opts, 5))
  return groups
}

// ------------------------------------------------------------------ rows

/** One keyboard stop in the list: an item, or a group's "Show N more". */
export type PaletteRow = { type: "item"; item: PaletteItem; group: GroupKey } | { type: "more"; group: GroupKey; total: number }

/** The flat, keyboard-ordered rows for the groups: each capped group ends in its "Show N more" row. */
export function paletteRows(groups: PaletteGroup[]): PaletteRow[] {
  const rows: PaletteRow[] = []
  for (const g of groups) {
    for (const item of g.items) rows.push({ type: "item", item, group: g.key })
    if (g.items.length < g.total) rows.push({ type: "more", group: g.key, total: g.total })
  }
  return rows
}

/** Command key → count, with one more use of `key`. */
export function bumpUsage(usage: Record<string, number>, key: string): Record<string, number> {
  return { ...usage, [key]: (usage[key] ?? 0) + 1 }
}

/** Command keys since renamed, by their former key: the Coordinator's page was named for the app's former home, and "Open settings" was a second row for the Settings page. */
const FORMER_KEYS: Readonly<Record<string, string>> = { "page:zen": "page:coordinator", "action:settings": "page:settings" }

/** Saved usage with a count under a former command key moved to the command's key now, so it still ranks. */
export function currentUsage(usage: Record<string, number>): Record<string, number> {
  let out = usage
  for (const [former, key] of Object.entries(FORMER_KEYS)) {
    const { [former]: count, ...rest } = out
    if (typeof count !== "number") continue
    out = { ...rest, [key]: (typeof rest[key] === "number" ? rest[key] : 0) + count }
  }
  return out
}
