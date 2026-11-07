import type { MergeRequest, PushState } from "../shared/types.js"
import { PR_TASK_ROLES, prKey, type PrTask, type PrTaskRole, type PrTasksAnswer } from "../shared/prTasks.js"
import { githubSlug, type Store } from "./store.js"

/**
 * Which tasks worked on a pull request, from what Box Yard already records (no GitHub call):
 * - by its URL: a task's current PR (tasks.pr_url), every PR a task reported ("Opened/Updated pull request" events,
 *   so a task that moved on to another PR still counts), and Merge PR requests;
 * - by its head branch (what the tasks that reported it said): any task of a project on the same repo whose branch,
 *   or the branch its turn-end push found checked out, is that one, e.g. a follow-up that pushed fixes to it.
 * The PR and merge events are found through the task_messages_pr_events partial index, so this doesn't read
 * transcripts.
 */

export const PR_EVENTS = `SELECT task_id, created_at, json_extract(meta_json, '$.kind') AS kind, json_extract(meta_json, '$.url') AS url,
    json_extract(meta_json, '$.prUrl') AS pr_url, json_extract(meta_json, '$.branch') AS branch
  FROM task_messages WHERE role = 'event' AND json_extract(meta_json, '$.kind') IN ('pr', 'merge_requested') ORDER BY created_at ASC`

interface EventRow {
  task_id: string
  created_at: number
  kind: string
  url: unknown
  pr_url: unknown
  branch: unknown
}

interface TaskLinkRow {
  id: string
  project_id: string
  branch: string | null
  pr_url: string | null
  model: string | null
  merge_request_json: string | null
  push_state_json: string | null
  created_at: number
  updated_at: number
}

const parse = <T>(json: string | null): T | null => {
  try {
    return json ? (JSON.parse(json) as T) : null
  } catch {
    return null
  }
}

export function prTasks(store: Store, owner: string, repo: string, number: number): PrTasksAnswer {
  const url = `https://github.com/${owner}/${repo}/pull/${number}`
  const key = prKey(url)
  const found = new Map<string, { reports: number[]; merge: number | null; branch: boolean }>()
  const link = (id: string) => found.get(id) ?? found.set(id, { reports: [], merge: null, branch: false }).get(id)!
  // What the reporters said the PR's head branch is.
  const heads: { branch: string; at: number; current: boolean }[] = []
  const sawHead = (branch: unknown, at: number, current: boolean) => {
    if (typeof branch === "string" && branch) heads.push({ branch, at, current })
  }

  for (const e of store.db.prepare(PR_EVENTS).all() as EventRow[]) {
    if (e.kind === "pr" && typeof e.url === "string" && prKey(e.url) === key) {
      link(e.task_id).reports.push(e.created_at)
      sawHead(e.branch, e.created_at, false)
    } else if (e.kind === "merge_requested" && typeof e.pr_url === "string" && prKey(e.pr_url) === key) {
      const l = link(e.task_id)
      l.merge = Math.min(l.merge ?? e.created_at, e.created_at)
    }
  }

  const rows = store.db
    .prepare("SELECT id, project_id, branch, pr_url, model, merge_request_json, push_state_json, created_at, updated_at FROM tasks")
    .all() as TaskLinkRow[]
  for (const r of rows) {
    if (prKey(r.pr_url) === key) {
      const l = link(r.id)
      // Linked without a report (an older server, an import): it counts from when it started.
      if (!l.reports.length) l.reports.push(r.created_at)
      sawHead(r.branch, r.updated_at, true)
    }
    const merge = parse<MergeRequest>(r.merge_request_json)
    if (merge && prKey(merge.prUrl) === key) {
      const l = link(r.id)
      l.merge = Math.min(l.merge ?? merge.requestedAt, merge.requestedAt)
    }
  }

  // The branch of a task whose current PR this is beats an older report's; then the latest wins.
  const branch = heads.sort((a, b) => Number(b.current) - Number(a.current) || b.at - a.at)[0]?.branch ?? null
  // Tasks on the head branch, only in projects on the PR's repo, and never its base branch.
  const slug = `${owner}/${repo}`.toLowerCase()
  const sameRepo = store.listProjects().filter((p) => githubSlug(p.repo)?.toLowerCase() === slug)
  if (branch && !sameRepo.some((p) => p.baseBranch === branch)) {
    const projects = new Set(sameRepo.map((p) => p.id))
    for (const r of rows) {
      if (!projects.has(r.project_id)) continue
      if (r.branch === branch || parse<PushState>(r.push_state_json)?.branch === branch) link(r.id).branch = true
    }
  }

  const byId = new Map(rows.map((r) => [r.id, r]))
  const firstReport = (id: string) => Math.min(...found.get(id)!.reports)
  const reporters = [...found.keys()].filter((id) => byId.has(id) && found.get(id)!.reports.length)
  const opener = reporters.sort((a, b) => firstReport(a) - firstReport(b) || a.localeCompare(b))[0] ?? null
  const lastModel = store.db.prepare("SELECT model FROM claude_usage WHERE task_id = ? AND model IS NOT NULL AND model != '' ORDER BY started_at DESC LIMIT 1")

  const tasks: PrTask[] = []
  for (const [taskId, l] of found) {
    const row = byId.get(taskId)
    if (!row) continue
    const has = new Set<PrTaskRole>()
    if (l.reports.length) has.add(taskId === opener ? "opened" : "pushed")
    else if (l.branch) has.add("branch")
    if (l.merge !== null) has.add("merge")
    const since = Math.min(...l.reports, l.merge ?? Infinity, l.branch && !l.reports.length ? row.created_at : Infinity)
    const model = (lastModel.get(taskId) as { model: string } | undefined)?.model ?? row.model ?? null
    tasks.push({ taskId, roles: PR_TASK_ROLES.filter((r) => has.has(r)), model, since })
  }
  tasks.sort((a, b) => Number(b.taskId === opener) - Number(a.taskId === opener) || a.since - b.since || a.taskId.localeCompare(b.taskId))
  return { url, branch, tasks }
}
