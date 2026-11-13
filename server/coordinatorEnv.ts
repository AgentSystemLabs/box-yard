// The Coordinator's own env vars (Settings › Coordinator › Env vars), like a project's: names come out, values only ever
// go in. The strongest Claude credential among them is the Coordinator's Claude login (turnCredentials.ts
// coordinatorClaudeLogin), over the rotation's and Settings › Credentials'; the others reach its `claude` runs as they
// are. They're saved in a kv entry of their own, as Settings › Credentials' are, so nothing that returns settings can
// include them, and read on every run, so a saved change applies from the next one without a restart.
import { z } from "zod"
import { BadRequestError, type Store } from "./store.js"
import { CLAUDE_CREDENTIAL_VARS } from "../shared/identities.js"
import type { CoordinatorEnvInfo } from "../shared/types.js"

const KV = "coordinator_env"

/** An env var name the Coordinator may have: like a project's, but never Box Yard's own BOXYARD_* (its runs never get those). */
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Env var names must be like MY_VAR")
  .max(200)
  .refine((k) => !k.toUpperCase().startsWith("BOXYARD_"), "BOXYARD_* vars are Box Yard's own: the Coordinator never gets them")

/** Set or replace some, remove others. A name in both is replaced: removing goes first. */
export const coordinatorEnvPatch = z
  .object({
    env: z.record(envName, z.string().trim().min(1, "Give each env var a value, or remove it").max(50_000)).optional(),
    removeEnv: z.array(z.string().max(200)).max(500).optional(),
  })
  .strict()

/** The Coordinator's env vars, saved in Box Yard's database. Values never leave the server: info() names the keys only. */
export class CoordinatorEnv {
  private cache: Record<string, string> | null = null

  constructor(private readonly store: Pick<Store, "getKv" | "setKv">) {}

  /** Its env vars, for its runs (server-side only). A copy: the caller may change it. */
  values(): Record<string, string> {
    if (!this.cache) {
      const parsed: Record<string, string> = {}
      try {
        const raw = JSON.parse(this.store.getKv(KV) ?? "{}")
        if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v) parsed[k] = v
      } catch {}
      this.cache = parsed
    }
    return { ...this.cache }
  }

  /** What the browser and the API see: the names, and which one is its Claude login. */
  info(): CoordinatorEnvInfo {
    const env = this.values()
    return { keys: Object.keys(env).sort(), claudeLogin: CLAUDE_CREDENTIAL_VARS.find((k) => env[k]) ?? null }
  }

  update(patch: unknown): CoordinatorEnvInfo {
    const parsed = coordinatorEnvPatch.safeParse(patch)
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => i.message).join("; "))
    const env = this.values()
    for (const k of parsed.data.removeEnv ?? []) delete env[k]
    Object.assign(env, parsed.data.env ?? {})
    this.store.setKv(KV, Object.keys(env).length ? JSON.stringify(env) : null)
    this.cache = null
    return this.info()
  }

  /** Every value, so transcripts and errors redact them (app.ts secretValues), as they do Settings › Credentials'. */
  secrets(): string[] {
    return Object.values(this.values())
  }
}
