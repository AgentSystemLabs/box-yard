import type { Project, Task } from "../../../shared/types"
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
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return all.filter((d) => words.every((w) => `${d.label} ${d.detail} ${d.id}`.toLocaleLowerCase().includes(w)))
    .sort((a, b) => Number(b.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) - Number(a.label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())))
}
