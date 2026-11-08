import type { Runner } from "../shared/runner.js"
import type { GpuProvider } from "../shared/gpu.js"
import { BadRequestError } from "./store.js"
import type { Store, TaskRow } from "./store.js"
import { providerOf, type BoxProvider } from "./providers/types.js"

// Physical providers, not the UI's broad "gpu"/"box" runner categories. In particular AutoProvider's local
// folders are local, never Upstash. SSH is one type; this policy does not introduce per-machine isolation.
export const ENVIRONMENT_TYPES = ["upstash", "docker", "local", "ssh", "runpod", "vast", "daytona"] as const
export type EnvironmentType = typeof ENVIRONMENT_TYPES[number]
const environmentType = (value: unknown): EnvironmentType | null => ENVIRONMENT_TYPES.includes(value as EnvironmentType) ? value as EnvironmentType : null
export const environmentRunner = (type: EnvironmentType): Runner => type === "upstash" ? "box" : type === "runpod" || type === "vast" || type === "daytona" ? "gpu" : type
export const environmentGpu = (type: EnvironmentType): GpuProvider | null => environmentRunner(type) === "gpu" ? type as GpuProvider : null

/** Server-owned lineage and provider routing are the authority. Nothing here reads a worker file or event. */
export class TaskEnvironment {
  constructor(private readonly store: Store, private readonly provider: BoxProvider) {}

  private reject(detail: string): never {
    throw new BadRequestError(`Subtask environment restriction: ${detail}`)
  }

  physical(boxId: string): EnvironmentType {
    const actual = environmentType(providerOf(this.provider, boxId).name)
    const recorded = this.store.getBox(boxId)?.provider
    if (!actual || (recorded && recorded !== actual)) this.reject("cannot determine an authoritative physical provider for the placement.")
    return actual
  }

  private saved(row: TaskRow): EnvironmentType | null {
    if (row.environment_type == null) return null
    return environmentType(row.environment_type) ?? this.reject("unknown persisted environment type; placement is blocked.")
  }

  private remember(row: TaskRow, type: EnvironmentType): EnvironmentType {
    // Write once, outside updateTask/TaskPatch: APIs, manager tools and worker events cannot replace this value.
    this.store.db.prepare("UPDATE tasks SET environment_type = ? WHERE id = ? AND environment_type IS NULL").run(type, row.id)
    const saved = this.saved(this.store.getTaskRow(row.id)!)
    if (saved !== type) this.reject("persisted lineage conflicts with the original environment type.")
    return type
  }

  /** Legacy roots require the first recorded turn's physical provider, never today's runner/default. */
  private original(row: TaskRow): EnvironmentType {
    const saved = this.saved(row)
    if (saved) return saved
    const first = this.store.db.prepare("SELECT box_id FROM task_turns WHERE task_id = ? ORDER BY turn_index, started_at, rowid LIMIT 1").get(row.id) as { box_id: string | null } | undefined
    if (first) {
      if (!first.box_id) this.reject("the original turn has no authoritative placement; lineage cannot be determined.")
      // Generic pool ids can be routed differently after provider configuration changes. Retain the server's
      // provider record as corroboration; if it has been deleted, do not guess from a name or today's default.
      const box = this.store.getBox(first.box_id)
      if (!box && !/^(this-computer$|docker-|ssh-|runpod-|vastai-|daytona-)/.test(first.box_id)) this.reject("the original provider record is unavailable; lineage cannot be determined.")
      return this.remember(row, this.physical(first.box_id))
    }
    if (row.session_started || row.turn_count) this.reject("the original turn history is unavailable; lineage cannot be determined.")
    if (!row.box_id) this.reject("the parent has no authoritative physical placement yet.")
    return this.remember(row, this.physical(row.box_id))
  }

  /** Walk parent links, checking the complete lineage rather than trusting root_task_id or depth alone. */
  inherited(row: TaskRow): EnvironmentType | null {
    if (!row.parent_task_id) {
      if (row.root_task_id || row.subtask_depth) this.reject("incomplete parent lineage; placement is blocked.")
      return null
    }
    const chain: TaskRow[] = []
    const seen = new Set<string>()
    let current = row
    while (current.parent_task_id) {
      if (seen.has(current.id)) this.reject("cyclic parent lineage; placement is blocked.")
      seen.add(current.id)
      chain.push(current)
      const parent = this.store.getTaskRow(current.parent_task_id)
      if (!parent || parent.project_id !== row.project_id) this.reject("missing or cross-project parent lineage; placement is blocked.")
      current = parent
    }
    if (seen.has(current.id) || current.root_task_id || current.subtask_depth) this.reject("invalid root lineage; placement is blocked.")
    const type = this.original(current)
    for (const [i, child] of chain.reverse().entries()) {
      if (child.root_task_id !== current.id || child.subtask_depth !== i + 1) this.reject("inconsistent root or depth in parent lineage; placement is blocked.")
      if (this.saved(child) && this.saved(child) !== type) this.reject("persisted descendant environment conflicts with its original lineage.")
    }
    for (const child of chain) this.remember(child, type)
    return type
  }

  /** Creation needs a placed parent whose physical type agrees with the original, even after runner changes. */
  forChild(parent: TaskRow): EnvironmentType {
    const type = this.inherited(parent) ?? this.original(parent)
    if (!parent.box_id || this.physical(parent.box_id) !== type) this.reject(`the parent must be physically running in its original ${type} environment to spawn children.`)
    return type
  }

  runner(type: EnvironmentType, runner: Runner, gpu: GpuProvider): void {
    const target = runner === "box" ? environmentType(this.provider.name) : runner === "gpu" ? gpu : runner
    if (target !== type) this.reject(`descendants of ${type} tasks must remain in ${type}; requested ${target ?? "unknown"} placement is forbidden.`)
  }

  /** Always check actual dispatch, including reused boxes, "same", unsafe-move stays and restore destinations. */
  placement(row: TaskRow, boxId: string): void {
    const type = this.inherited(row)
    if (type && this.physical(boxId) !== type) this.reject(`descendants of ${type} tasks must remain in ${type}; physical target conflicts.`)
  }

  /** Capture new roots before their first launch. Ambiguous legacy roots may continue, but cannot spawn. */
  launching(row: TaskRow, boxId: string): void {
    this.placement(row, boxId)
    if (!row.parent_task_id && !this.saved(row)) {
      const prior = this.store.db.prepare("SELECT 1 FROM task_turns WHERE task_id = ? LIMIT 1").get(row.id)
      if (!prior && !row.session_started && !row.turn_count) this.remember(row, this.physical(boxId))
    }
  }
}
