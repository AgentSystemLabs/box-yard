import type { Project, Task } from "../../../shared/types"
import { plainText, splitNotice } from "./captainTranscript"
import { dayKey } from "./calendarDay"
import type { NoticeLike } from "./publishedNotices"
import { githubRef, githubRepo, splitGithubRefs } from "./linkify"

export interface ChatDay {
  key: string
  at: number
  messageId: string
}

/** All days, including the ones useTail hasn't rendered. Call with the messages that have visible rows. */
export function chatDays(messages: readonly Pick<NoticeLike, "id" | "createdAt">[]): ChatDay[] {
  const days = new Map<string, ChatDay>()
  for (const m of messages) {
    const key = dayKey(m.createdAt)
    if (!days.has(key)) days.set(key, { key, at: m.createdAt, messageId: m.id })
  }
  return [...days.values()]
}

type MilestoneTask = Pick<Task, "id" | "title" | "createdAt" | "prState" | "prMergedAt" | "projectId" | "prUrl">
type SummaryProject = Pick<Project, "id" | "repo">
export interface DaySummary {
  text: string
  repo: string | null
  /** A message in this chat, never a message from another task's transcript. */
  sourceMessageId?: string
}

/** Source identity wins over the chat's scope. An explicit PR can recover a deleted project's repo. */
export function daySummaryRepo(projectId: string | undefined, task: Pick<MilestoneTask, "projectId" | "prUrl"> | undefined, prUrl: string | undefined, projects: readonly SummaryProject[]): string | null {
  const repo = githubRepo(projects.find((p) => p.id === (task?.projectId ?? projectId))?.repo)
  if (repo) return repo
  const explicit = githubRef(prUrl ?? "")
  const pr = explicit?.kind === "pull" ? explicit : githubRef(task?.prUrl ?? "")
  return pr?.kind === "pull" ? `${pr.owner}/${pr.repo}` : null
}

/** Keep the milestone short, but retain PR/issue references from its notice and avoid repeating title links. */
function summary(text: string, repo: string | null, detail = ""): DaySummary {
  const identity = (url: string) => {
    const ref = githubRef(url)!
    return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()
  }
  const seen = new Set(splitGithubRefs(text, repo).flatMap((s) => s.url && s.kind !== "commit" ? [identity(s.url)] : []))
  for (const s of splitGithubRefs(detail, repo)) {
    if (!s.url || s.kind === "commit" || seen.has(identity(s.url))) continue
    seen.add(identity(s.url))
    text += ` · ${s.url}`
  }
  return { text: plainText(text), repo }
}

/** Recorded milestones only: never infer a finish date from a task's mutable updatedAt or a merge request. */
export function daySummaries(messages: readonly (NoticeLike & { taskId?: string; projectId?: string })[], tasks: readonly MilestoneTask[], projects: readonly SummaryProject[] = [], projectId?: string): Map<string, DaySummary[]> {
  const days = new Map<string, Map<string, { bullet: DaySummary; rank: number; sourceRank: number }>>()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const byTitle = new Map<string, MilestoneTask[]>()
  for (const t of tasks) byTitle.set(plainText(t.title), [...(byTitle.get(plainText(t.title)) ?? []), t])
  const add = (at: number, id: string, bullet: DaySummary, rank: number, sourceMessageId?: string) => {
    const key = dayKey(at)
    let entries = days.get(key)
    if (!entries) days.set(key, entries = new Map())
    // One bullet per task per day: a merge tells more than repeating its start and every finished turn.
    const previous = entries.get(id)
    if (!previous || previous.rank < rank) {
      entries.set(id, { bullet: { ...bullet, ...(sourceMessageId ? { sourceMessageId } : {}) }, rank, sourceRank: sourceMessageId ? rank : 0 })
    } else if (sourceMessageId && previous.sourceRank < rank) {
      // A task-record merge may outrank its notices. Keep the merge, with its best recorded source in this day.
      previous.bullet.sourceMessageId = sourceMessageId
      previous.sourceRank = rank
    }
  }
  for (const t of tasks) {
    const repo = daySummaryRepo(undefined, t, undefined, projects)
    add(t.createdAt, t.id, summary(`Started: ${t.title}`, repo), 1)
    if (t.prState === "merged" && t.prMergedAt != null) add(t.prMergedAt, t.id, summary(`PR merged: ${t.title}`, repo, t.prUrl ?? ""), 5)
  }
  for (const m of messages) {
    if (m.role === "event") {
      const task = byId.get(m.taskId ?? "")
      const repo = daySummaryRepo(m.projectId ?? projectId, task, undefined, projects)
      if (task && /^Turn \d+ finished(?:\.| ·)/.test(m.content)) add(m.createdAt, task.id, summary(`Worked on: ${task.title}`, repo), 2, m.id)
      if (task && m.meta?.kind === "auto_done") add(m.createdAt, task.id, summary(`Finished: ${task.title}`, repo), 4, m.id)
      continue
    }
    if (m.role !== "notice") continue
    const n = splitNotice(m.content, m.meta)
    if (!n.title) continue
    const sourceId = typeof m.meta?.taskId === "string" ? m.meta.taskId : undefined
    const sourceProject = m.projectId ?? projectId
    const candidates = (byTitle.get(n.title) ?? []).filter((t) => !sourceProject || t.projectId === sourceProject)
    const task = sourceId ? byId.get(sourceId) : candidates.length === 1 ? candidates[0] : undefined
    const id = sourceId ?? task?.id ?? n.title
    const prs = new Map(splitGithubRefs(m.content, null).flatMap((s) => {
      const ref = s.url && s.kind === "pull" ? githubRef(s.url) : null
      return ref ? [[`${ref.owner}/${ref.repo}`.toLowerCase(), s.url!] as const] : []
    }))
    const prUrl = prs.size === 1 ? prs.values().next().value : undefined
    const repo = daySummaryRepo(sourceProject, task, prUrl, projects)
    if (n.kind === "done") {
      add(m.createdAt, id, summary(`Finished: ${n.title}`, repo, n.event), 4, m.id)
    } else if (n.kind === "message" && /^finished its turn:/.test(n.event)) {
      add(m.createdAt, id, summary(`Worked on: ${n.title}`, repo, n.event), 2, m.id)
    } else if (n.kind === "pr") {
      add(m.createdAt, id, summary(`PR opened: ${n.title}`, repo, n.event), 3, m.id)
    }
  }
  return new Map([...days].map(([key, entries]) => [key, [...entries.values()].map((e) => e.bullet)]))
}
