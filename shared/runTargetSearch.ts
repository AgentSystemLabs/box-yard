// The click-opened pickers' search (Where tasks run, Harness): plain words, not a token. Each word may name any
// level of a choice, so "fable high" finds Claude Code's Fable at High effort in one go, "box l" a large Upstash box,
// and "codex sol" a Codex model. The typed "@" / "!" lists keep their own token filter (filterRunTargets).
import { matchText } from "./pickerRank.js"
import { filterRunTargets, type RunTarget } from "./runTargets.js"

const BOUNDARY = /[\s\-_/.:#%()[\]·]/

/**
 * How well `word` (lowercase) hits `text`: 4 it is the text's first word, 3.5 a later whole word, 3 the text starts
 * with it, 2 a later word does, 1 it is inside a word (two letters or more: one letter is in nearly everything),
 * 0.5 a fuzzy subsequence (only with `fuzzy`), 0 no hit.
 * A whole first word counts the same as the whole text, so "fable" doesn't jump from Fable 5.1 to the alias `fable`
 * on its last letter: equal hits stay in the list's own order.
 */
export function wordTier(text: string, word: string, fuzzy = false): number {
  const t = text.toLowerCase()
  if (!t || !word) return 0
  let best = 0
  for (let i = t.indexOf(word); i >= 0 && best < 4; i = t.indexOf(word, i + 1)) {
    const starts = i === 0 || BOUNDARY.test(t[i - 1]!)
    const end = i + word.length
    const ends = end === t.length || BOUNDARY.test(t[end]!)
    best = Math.max(best, i === 0 ? (ends ? 4 : 3) : starts ? (ends ? 3.5 : 2) : word.length > 1 ? 1 : 0)
  }
  if (!best && fuzzy && matchText(t, word)?.tier === "fuzzy") return 0.5
  return best
}

/** What a level is called on its own: under a parent, only its own part of the token and its own name. */
function levelTexts(t: RunTarget, parent: RunTarget | undefined): string[] {
  if (!parent) return [t.token, t.label, ...(t.aliases ?? [])]
  return [t.token.slice(parent.token.length + 1), t.menuLabel ?? t.label, ...(t.model && !t.effort ? [t.model] : [])]
}

/**
 * The choices `query`'s words name, best first. Every word must hit some level of a choice (a harness, its model, the
 * effort), and at least one must hit the choice's own level, so "claude" finds the harness and not each model whose
 * id starts with it. A word counts for the level it hits best; the shallowest on a tie. Equal scores keep the list's
 * order (the catalog's: latest models first). When the words leave several models, each shows once, at its best
 * effort; one model shows every effort that fits. Inside an open level (`parent`), only what's under it.
 * An empty query is the level as it is browsed.
 */
export function searchRunTargets(all: RunTarget[], query: string, parent?: RunTarget): RunTarget[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return filterRunTargets(all, parent?.token ?? "")
  const byToken = new Map(all.map((t) => [t.token, t]))
  const texts = new Map<RunTarget, string[]>()
  const textsOf = (t: RunTarget) => {
    let found = texts.get(t)
    if (!found) texts.set(t, (found = levelTexts(t, t.under ? byToken.get(t.under) : undefined)))
    return found
  }
  const pathOf = (t: RunTarget) => {
    const path = [t]
    for (let at = t.under ? byToken.get(t.under) : undefined; at; at = at.under ? byToken.get(at.under) : undefined) path.unshift(at)
    return path
  }
  const rank = (fuzzy: boolean) => {
    const hits: { t: RunTarget; score: number; at: number }[] = []
    all.forEach((t, at) => {
      const path = pathOf(t)
      if (parent && (t === parent || !path.includes(parent))) return
      let score = 0
      const own: string[] = []
      for (const word of words) {
        let best = 0
        let level = -1
        path.forEach((step, i) => {
          const tier = Math.max(0, ...textsOf(step).map((text) => wordTier(text, word, fuzzy)))
          if (tier > best) {
            best = tier
            level = i
          }
        })
        if (!best) return
        score += best
        if (level === path.length - 1) own.push(word)
      }
      if (!own.length) return
      // A name typed in full ("opus 4") goes before the longer names that start the same (Opus 4.8).
      if (own.length > 1 && (t.menuLabel ?? t.label).toLowerCase() === own.join(" ")) score += 1
      hits.push({ t, score, at })
    })
    return hits.sort((a, b) => b.score - a.score || a.at - b.at).map((h) => h.t)
  }
  const strict = rank(false)
  const ranked = strict.length ? strict : rank(true)
  // Efforts (a level under a level): several models each show their best one, so the list is a row a model.
  const deep = (t: RunTarget) => Boolean(t.under && byToken.get(t.under)?.under)
  if (new Set(ranked.filter(deep).map((t) => t.under)).size < 2) return ranked
  const seen = new Set<string>()
  return ranked.filter((t) => !deep(t) || (!seen.has(t.under!) && Boolean(seen.add(t.under!))))
}
