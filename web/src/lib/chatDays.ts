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
export type DaySummaryKind = "pr_merged" | "pr_opened" | "finished" | "worked" | "started"
/** A day's milestones are listed in these groups, the most telling first. */
export const DAY_SUMMARY_GROUPS: readonly { kind: DaySummaryKind; label: string }[] = [
  { kind: "pr_merged", label: "PR merged" },
  { kind: "pr_opened", label: "PR opened" },
  { kind: "finished", label: "Finished" },
  { kind: "worked", label: "Worked on" },
  { kind: "started", label: "Started" },
]
export interface DaySummary {
  /** What happened to the task that day: its group in the list. */
  kind: DaySummaryKind
  /** The task's title, as plain text. */
  title: string
  repo: string | null
  /** The task, when the app knows which one it is. */
  taskId?: string
  /** The PRs and issues its title and its notice name, as GitHub URLs: one each. */
  refs: string[]
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

/** Keep the milestone short: the task's title, with the PR/issue references of its title and its notice set apart. */
function summary(kind: DaySummaryKind, title: string, repo: string | null, taskId: string | undefined, detail = ""): DaySummary {
  const plain = plainText(title)
  const refs = new Map<string, string>()
  for (const s of [...splitGithubRefs(plain, repo), ...splitGithubRefs(detail, repo)]) {
    if (!s.url || s.kind === "commit") continue
    const ref = githubRef(s.url)!
    const identity = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()
    // A pull request's own URL over an "#12" that GitHub would have to redirect.
    if (!refs.has(identity) || s.kind === "pull") refs.set(identity, s.url)
  }
  return { kind, title: plain, repo, ...(taskId ? { taskId } : {}), refs: [...refs.values()] }
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
    add(t.createdAt, t.id, summary("started", t.title, repo, t.id), 1)
    if (t.prState === "merged" && t.prMergedAt != null) add(t.prMergedAt, t.id, summary("pr_merged", t.title, repo, t.id, t.prUrl ?? ""), 5)
  }
  for (const m of messages) {
    if (m.role === "event") {
      const task = byId.get(m.taskId ?? "")
      const repo = daySummaryRepo(m.projectId ?? projectId, task, undefined, projects)
      if (task && /^Turn \d+ finished(?:\.| ·)/.test(m.content)) add(m.createdAt, task.id, summary("worked", task.title, repo, task.id), 2, m.id)
      if (task && m.meta?.kind === "auto_done") add(m.createdAt, task.id, summary("finished", task.title, repo, task.id), 4, m.id)
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
      add(m.createdAt, id, summary("finished", n.title, repo, task?.id, n.event), 4, m.id)
    } else if (n.kind === "message" && /^finished its turn:/.test(n.event)) {
      add(m.createdAt, id, summary("worked", n.title, repo, task?.id, n.event), 2, m.id)
    } else if (n.kind === "pr") {
      add(m.createdAt, id, summary("pr_opened", n.title, repo, task?.id, n.event), 3, m.id)
    }
  }
  return new Map([...days].map(([key, entries]) => [key, [...entries.values()].map((e) => e.bullet)]))
}
