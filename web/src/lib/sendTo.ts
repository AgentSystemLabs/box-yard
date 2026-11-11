import type { Project, Task } from "../../../shared/types"
import { searchWords, wordTier } from "../../../shared/runTargetSearch"
import { projectChatHref, taskCardHref } from "./navigation"

export type SendDestination = {
  key: string
  kind: "coordinator" | "captain" | "task"
  id: string
  label: string
  detail: string
  href: string
}

/** A standalone > at the caret, outside inline/fenced code. Picking removes only this query. */
export function sendToMention(text: string, caret: number) {
  if (caret < 0) return null
  const before = text.slice(0, caret)
  if ((before.match(/^\s*```/gm)?.length ?? 0) % 2) return null
  const line = before.slice(before.lastIndexOf("\n") + 1)
  if ((line.match(/`/g)?.length ?? 0) % 2) return null
  const match = /(?:^|\s)>([^>\n]{0,100})$/.exec(before)
  if (!match) return null
  const start = before.length - match[1]!.length - 1
  return { start, end: caret, query: match[1]!.trim() }
}

export function sendDestinations(projects: Project[], tasks: Task[], query: string): SendDestination[] {
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const all: SendDestination[] = [
    { key: "coordinator", kind: "coordinator", id: "coordinator", label: "Coordinator", detail: "All projects", href: "/" },
    ...projects.map((p): SendDestination => ({ key: `captain:${p.id}`, kind: "captain", id: p.id, label: `${p.name} Captain`, detail: p.repo ?? "Project chat", href: projectChatHref(p.id) })),
    ...tasks.filter((t) => names.has(t.projectId)).map((t): SendDestination => ({ key: `task:${t.id}`, kind: "task", id: t.id, label: t.title, detail: `${names.get(t.projectId)} · ${t.status}${t.status === "done" ? " · Sending reopens this task" : ""}`, href: taskCardHref(t.id) })),
  ]
  return rankDestinations(all, query)
}

/**
 * The destinations `query`'s words name, best first. Every word must be in a destination's name, its detail or its ID.
 * A hit in the name counts double, and a whole word more than a word's start or its inside (wordTier), so "fix up"
 * puts "Fix uploads" before a task of the Uploads project. Equal hits keep the list's order; no words is the whole list.
 */
function rankDestinations(all: SendDestination[], query: string): SendDestination[] {
  const words = searchWords(query)
  if (!words.length) return all
  const hits: { d: SendDestination; score: number; at: number }[] = []
  all.forEach((d, at) => {
    let score = 0
    for (const word of words) {
      const hit = Math.max(wordTier(d.label, word) * 2, wordTier(d.detail, word), wordTier(d.id, word))
        || (`${d.label} ${d.detail} ${d.id}`.toLowerCase().includes(word) ? 0.25 : 0)
      if (!hit) return
      score += hit
    }
    hits.push({ d, score, at })
  })
  return hits.sort((a, b) => b.score - a.score || a.at - b.at).map((h) => h.d)
}
