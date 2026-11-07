// Shared ranking for Composer prefix pickers (@, !, # / %, and later GitHub # results). Exact > prefix >
// word start > substring > fuzzy subsequence, with field weights so a token/id beats a detail line.
// Keep this free of React and of run-target shape so any list (harness models, projects, issue hits) can reuse it.

export type MatchTier = "exact" | "prefix" | "word" | "substring" | "fuzzy"

/** Each tier has its own band, so no length or position penalty can drop a match into the tier below. */
const TIER_BASE: Record<MatchTier, number> = { exact: 1000, prefix: 800, word: 600, substring: 400, fuzzy: 200 }
const BAND = 40

const BOUNDARY = /[\s\-_/.:#%()[\]]/

/** Which tier `q` (lowercase, non-empty) hits in `text`, with a 0..1 penalty inside the tier. */
export function matchText(text: string, q: string, allowFuzzy = true): { tier: MatchTier; penalty: number } | null {
  return matchLower(text.toLowerCase(), q, allowFuzzy)
}

function matchLower(t: string, q: string, allowFuzzy: boolean): { tier: MatchTier; penalty: number } | null {
  if (!t || !q) return null
  if (t === q) return { tier: "exact", penalty: 0 }
  if (t.startsWith(q)) return { tier: "prefix", penalty: Math.min(1, (t.length - q.length) / 40) }
  const idx = t.indexOf(q)
  if (idx >= 0) {
    for (let i = idx; i > 0; i = t.indexOf(q, i + 1)) if (BOUNDARY.test(t[i - 1]!)) return { tier: "word", penalty: Math.min(1, i / 80) }
    return { tier: "substring", penalty: Math.min(1, idx / 80) }
  }
  if (!allowFuzzy) return null
  const f = fuzzy(t, q)
  return f === null ? null : { tier: "fuzzy", penalty: f }
}

/** Subsequence match ("dpsk" → "deepseek") starting at a word; rewards runs and word starts, rejects scattered hits. */
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
  const m = matchLower(text.toLowerCase(), q, allowFuzzy)
  return m && TIER_BASE[m.tier] + BAND * (1 - m.penalty)
}

/** How strongly each searchable field counts. Token/id first; labels next; details least. */
export const PICKER_FIELD_WEIGHT = { token: 1, label: 0.9, alias: 0.75, detail: 0.5 } as const

export type PickerFieldKind = keyof typeof PICKER_FIELD_WEIGHT

/** One searchable string of an option, already lowercased when possible. */
export interface PickerField {
  text: string
  kind: PickerFieldKind
  /** Fuzzy hits are off for short numeric ids (GitHub #123) so an exact number stays on top. */
  fuzzy?: boolean
}

/**
 * Best score of `query` across `fields`, or null when nothing matches. Empty query scores 0 (keep order).
 * Pass `allowFuzzy` false only when a caller needs strict substring matching; picker lists default to fuzzy.
 */
export function scorePickerFields(fields: readonly PickerField[], query: string, allowFuzzy = true): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  let best: number | null = null
  for (const field of fields) {
    const text = field.text.trim()
    if (!text) continue
    const fuzzy = allowFuzzy && field.fuzzy !== false
    const raw = scoreText(text, q, fuzzy)
    if (raw === null) continue
    const score = raw * PICKER_FIELD_WEIGHT[field.kind]
    if (best === null || score > best) best = score
  }
  return best
}

/**
 * Rank `items` by how well they match `query` (best first). Ties keep the input order.
 * `fieldsOf` returns the searchable strings for one item. An empty query returns every item in order.
 * Items that score null are dropped. Use this for run targets, project rows, and GitHub issue/PR hits.
 */
export function rankPickerOptions<T>(items: readonly T[], query: string, fieldsOf: (item: T) => readonly PickerField[], allowFuzzy = true): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const scored: { item: T; score: number; at: number }[] = []
  items.forEach((item, at) => {
    const score = scorePickerFields(fieldsOf(item), q, allowFuzzy)
    if (score !== null) scored.push({ item, score, at })
  })
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.item)
}
