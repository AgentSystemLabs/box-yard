import { withOwner } from "../shared/owner.js"
import { BadRequestError, type Store } from "./store.js"

export type DirectMessageTarget = { taskId: string } | { projectId: string }

/** Human HTTP entry points only: task sends also carry agents, hooks and automatic retries. */
export class DirectMessageDigests {
  constructor(
    private readonly store: Store,
    private readonly statusOnly: (projectId: string) => boolean,
    private readonly owner: () => string,
  ) {}

  /** Persist one latest snippet and a count per target, without nudging or queuing a Coordinator turn. */
  record(target: DirectMessageTarget, content: string) {
    const taskId = "taskId" in target ? target.taskId : null
    const projectId = "projectId" in target ? target.projectId : this.store.getTaskRow(target.taskId)?.project_id
    if (!projectId || !this.store.getProject(projectId)) throw new BadRequestError("No such direct-message target")
    // Sealed content never enters the digest queue, even if the owner later loosens the identity.
    const chars = this.statusOnly(projectId) ? null : Array.from(content.trim().replace(/\s+/gu, " "))
    const snippet = chars ? (chars.length > 200 ? chars.slice(0, 199).join("") + "…" : chars.join("")) : null
    this.store.db.prepare(`
      INSERT INTO coordinator_direct_messages (target_key, project_id, task_id, snippet, message_count, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(target_key) DO UPDATE SET project_id = excluded.project_id, snippet = excluded.snippet,
        message_count = message_count + 1, updated_at = excluded.updated_at
    `).run(taskId ? `task:${taskId}` : `captain:${projectId}`, projectId, taskId, snippet, Date.now())
  }

  /** Read privacy and names now, not when queued. Only the next natural turn consumes these FYIs. */
  take(): string[] {
    return this.store.db.transaction(() => {
      const rows = this.store.db.prepare(`
        SELECT d.snippet, d.message_count, d.task_id, COALESCE(t.project_id, d.project_id) AS project_id,
          t.title, p.name AS project_name
        FROM coordinator_direct_messages d
        LEFT JOIN tasks t ON t.id = d.task_id
        JOIN projects p ON p.id = COALESCE(t.project_id, d.project_id)
        ORDER BY d.updated_at ASC, d.rowid ASC
      `).all() as { snippet: string | null; message_count: number; task_id: string | null; project_id: string; title: string | null; project_name: string }[]
      const updates = rows.map((r) => {
        const target = r.task_id ? `"${r.title}" (${r.task_id})` : `the ${r.project_name} Captain`
        const count = r.message_count > 1 ? ` (${r.message_count} messages; latest)` : ""
        const snippet = !this.statusOnly(r.project_id) && r.snippet ? `: ${r.snippet}` : ""
        // Apply withOwner only to generated text, never to the owner's words or project/task names.
        const who = withOwner(snippet ? "Cody told" : "Cody messaged", this.owner())
        return `${who} ${target}${count}${snippet} ${withOwner("(FYI: direct message, no action needed; the recipient handles it.)", this.owner())}`
      })
      this.store.db.prepare("DELETE FROM coordinator_direct_messages").run()
      return updates
    })()
  }
}
