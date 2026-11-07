// Which tasks count as running, how many, in what order, and since when (lib/time.ts says how long: "12m"). Pure, so
// it is unit tested. (The header's running-tasks badge that used the rest gave way to the Coordinator chat's
// project bar.)
import type { Task, TaskStatus } from "../../../shared/types"

/**
 * Tasks with an agent turn running or about to run. needs_input doesn't count: its turn has ended and it waits on
 * the owner (the Inbox has those). waiting doesn't either: it's held on another agent, not running.
 */
export const RUNNING_STATUSES: readonly TaskStatus[] = ["working", "starting", "queued"]

export const isRunning = (t: Pick<Task, "status">) => RUNNING_STATUSES.includes(t.status)

export const runningCount = (tasks: readonly Pick<Task, "status">[] | undefined) => (tasks ? tasks.filter(isRunning).length : 0)

/** Since when it has run: its turn's start, else (queued, or a turn still being set up) when its status last changed. */
export const runningSince = (t: Pick<Task, "turnStartedAt" | "updatedAt">) => t.turnStartedAt ?? t.updatedAt

/**
 * The dropdown's order: oldest task first. Created-at never changes, so a status change (queued → working) never
 * moves a row: a re-sort only adds the tasks that started and drops the ones that stopped.
 */
export const compareRunning = (a: Pick<Task, "createdAt" | "id">, b: Pick<Task, "createdAt" | "id">) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
