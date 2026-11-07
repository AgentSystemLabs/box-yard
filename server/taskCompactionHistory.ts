import { z } from "zod"
import { CompactionIndex, FULL_CHUNK_MAX } from "./compactionIndex.js"
import type { Store } from "./store.js"

const request = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("compaction_history"), args: z.object({ before: z.string().max(180).optional(), since: z.string().max(180).optional(), until: z.string().max(180).optional(), limit: z.number().int().min(1).max(20).optional() }).strict() }),
  z.object({ tool: z.literal("read_compaction"), args: z.object({ compaction: z.string().max(180), level: z.enum(["summary", "full"]).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(FULL_CHUNK_MAX).optional() }).strict() }),
])

/** The task identity is the event channel's authenticated row, never an agent-supplied task/project/path. */
export function taskCompactionHistory(store: Store, taskId: string, input: unknown) {
  const r = request.parse(input)
  const index = new CompactionIndex(store, `task:${taskId}`)
  return r.tool === "compaction_history" ? index.page(r.args) : index.read(r.args.compaction, r.args.level ?? "summary", r.args.offset, r.args.limit)
}
