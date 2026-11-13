// Marks on the run path (a Captain's turn, a task's launch, its turn end), for scripts/perf/captain-task-loop.ts to
// say where the time between "asked" and "answered" went. Off unless something listens: a mark is then one null check.

export interface PerfMark {
  at: number
  /** What it's about: a task id, or `captain:<projectId>`. */
  scope: string
  name: string
  /** A span's length; a point mark has none. */
  ms?: number
}

let sink: ((mark: PerfMark) => void) | null = null

/** Listen to every mark (one listener: the bench), or stop with null. */
export function onPerfMark(fn: ((mark: PerfMark) => void) | null) {
  sink = fn
}

export function perfMark(scope: string, name: string) {
  if (sink) sink({ at: Date.now(), scope, name })
}

/** Time `fn` as a span named `name`; it runs the same with no listener. */
export async function perfSpan<T>(scope: string, name: string, fn: () => Promise<T> | T): Promise<T> {
  if (!sink) return fn()
  const at = Date.now()
  try {
    return await fn()
  } finally {
    sink?.({ at, scope, name, ms: Date.now() - at })
  }
}
