// Deterministic grading for the Captain routing eval: one run's record (what run.ts saw the Captain do) against its
// case's expectations (fixtures.ts). Pure, so test/captain-routing-eval.test.ts can check it without a server.
import type { Case, Expect } from "./fixtures.js"
import type { Alias } from "./seed.js"

export interface ToolCall {
  name: string
  input: Record<string, unknown>
  /** The tool's result text (clipped), when the session transcript had it. */
  result?: string
  isError?: boolean
}

export interface CreatedTask {
  id: string
  title: string
  /** The prompt the agent got (create_tasks' common_prompt included). */
  prompt: string
}

export interface Send {
  tool: string
  /** The task ref the Captain passed. */
  ref: string
  /** The seeded task it names, or null (a new task, another project's, or nothing). */
  alias: Alias | null
  message: string
  isError?: boolean
  /** It names a task the Captain created this turn (following up on its own task isn't a routing choice). */
  toNew?: boolean
}

export interface RunRecord {
  caseId: string
  effort: string
  rep: number
  /** The message as sent, with {alias.*} filled in. */
  message: string | null
  tools: ToolCall[]
  /** The Captain's replies this turn, as stored for the owner's chat (a bare "(no update)" isn't stored). */
  replies: string[]
  /** Its last text block, as the model wrote it (the hidden marker and next steps included). */
  finalText: string
  created: CreatedTask[]
  sends: Send[]
  notesBefore: Record<string, string>
  notesAfter: Record<string, string>
  /** Notes retro case: each suggestion key's status and who resolved it. */
  suggestions: Record<string, { status: string; resolvedBy: string | null; reason: string | null }>
  /** The turn ended normally (no timeout, no error). */
  ok: boolean
  error: string | null
  /** Post → the turn's result line. */
  latencyMs: number | null
  /** Time inside wait_for_tasks (part of latencyMs). */
  waitMs?: number
  /** Time the model spent generating, summed over the turn's calls. */
  modelMs?: number
  costUsd: number
  modelCalls: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Session transcript, compact: for failure excerpts. */
  transcript: TranscriptLine[]
  judge?: JudgeVerdict | null
  /** When the case started (ISO). */
  at?: string
}

export type TranscriptLine = { k: "user"; text: string } | { k: "text"; text: string } | { k: "tool"; name: string; input: unknown } | { k: "result"; text: string; isError: boolean }

export interface JudgeVerdict {
  pass: boolean
  items: { item: string; pass: boolean; why: string }[]
  verbatim: boolean
  model: string
  costUsd: number
}

export interface Check {
  name: string
  pass: boolean
  detail: string
}

export interface Grade {
  pass: boolean
  /** Pass on the deterministic checks alone (the judge left out). */
  passDeterministic: boolean
  checks: Check[]
}

const BOXYARD_EDITOR = "boxyard"
const re = (p: string) => new RegExp(p, "i")
const DONT_MERGE = /(do not|don't|dont|not to|never|without|no) merg|leave (it |the pr )?(open|unmerged)|hold off (on )?merg|before (you )?merg|until .{0,40}(review|look)/i
const ASKS = /\?|\b(tell|let) me (know )?(which|what|who|where)\b|\bwhich (one|task|of these)\b.{0,80}\b(mean|meant|want)|\b(say|tell me) (which|what) you mean/i
const OPTION_KEYS =["runs_on", "agent", "model", "effort", "priority"] as const
type OptionKey = (typeof OPTION_KEYS)[number]
const DEFAULT_OPTIONS: Partial<Record<OptionKey, string | null>> = { runs_on: null, agent: null, model: null, effort: null }
const MESSAGING = new Set(["send_to_task", "reopen_task", "retry_task", "continue_task"])

const strip = (name: string) => name.replace(/^mcp__boxyard__/, "")
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v))

/** What the Captain asked for on each task it tried to create: one entry per create_task, one per create_tasks item. */
export function creationRequests(tools: ToolCall[]) {
  const out: { title: string; options: Partial<Record<OptionKey, string>>; via: "create_task" | "create_tasks"; isError: boolean }[] = []
  for (const t of tools) {
    const name = strip(t.name)
    const opts = (o: Record<string, unknown>) => Object.fromEntries(OPTION_KEYS.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, str(o[k])])) as Partial<Record<OptionKey, string>>
    if (name === "create_task") out.push({ title: str(t.input.title).trim(), options: opts(t.input), via: "create_task", isError: Boolean(t.isError) })
    if (name === "create_tasks" && Array.isArray(t.input.tasks)) {
      const shared = opts(t.input)
      for (const item of t.input.tasks as Record<string, unknown>[]) {
        const own = opts(item)
        // An item's runs_on or machine_label replaces the shared pair; its other options win one by one.
        out.push({ title: str(item.title).trim(), options: { ...shared, ...own }, via: "create_tasks", isError: Boolean(t.isError) })
      }
    }
  }
  return out
}

const count = (n: number, want: number | [number, number]) => (Array.isArray(want) ? n >= want[0] && n <= want[1] : n === want)
const show = (want: number | [number, number]) => (Array.isArray(want) ? `${want[0]}–${want[1]}` : String(want))

export function grade(c: Case, r: RunRecord): Grade {
  const e: Expect = c.expect
  const checks: Check[] = []
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail })
  const calls = r.tools.map((t) => ({ ...t, name: strip(t.name) }))
  const replyText = r.replies.join("\n\n")

  add("turn", r.ok, r.ok ? "ended normally" : `turn failed: ${r.error ?? "unknown"}`)

  const wantCreated = e.created ?? 0
  add("created", count(r.created.length, wantCreated), `${r.created.length} task(s) created, want ${show(wantCreated)}${r.created.length ? `: ${r.created.map((t) => `"${t.title}"`).join(", ")}` : ""}`)

  if (e.batch) {
    const singles = calls.filter((t) => t.name === "create_task").length
    const batches = calls.filter((t) => t.name === "create_tasks" && !t.isError).length
    add("batch", singles === 0 && batches === 1, `${batches} successful create_tasks call(s), ${singles} create_task call(s); want exactly 1 and 0`)
  }

  // Which seeded tasks it messaged (attempts count: a message to the wrong task is a routing error even if it failed).
  const routed = r.sends.filter((s) => !s.toNew)
  const messaged = new Set(routed.map((s) => s.alias ?? `other:${s.ref}`))
  const required = e.sendTo ?? []
  const allowed = new Set<string>([...required, ...(e.mayMessage ?? [])])
  const missing = required.filter((a) => !messaged.has(a))
  const stray = [...messaged].filter((a) => !allowed.has(a))
  const reached = e.sendToAny ? missing.length < required.length || required.length === 0 : missing.length === 0
  add(
    "messaged",
    reached && stray.length === 0,
    `messaged [${[...messaged].join(", ") || "none"}]; want ${required.length ? `${e.sendToAny ? "any of" : "all of"} [${required.join(", ")}]` : "none"}${e.mayMessage?.length ? `, may [${e.mayMessage.join(", ")}]` : ""}`,
  )

  for (const name of e.forbid ?? []) {
    const n = calls.filter((t) => t.name === name).length
    add(`no ${name}`, n === 0, n ? `called ${name} ${n}×` : `no ${name}`)
  }
  for (const group of e.require ?? []) {
    const hit = group.some((name) => calls.some((t) => t.name === name))
    add(`calls ${group.join("|")}`, hit, hit ? "called" : `never called ${group.join(" or ")}`)
  }

  if (r.created.length) {
    const want = { ...DEFAULT_OPTIONS, ...e.options }
    const requests = creationRequests(r.tools)
    const problems: string[] = []
    for (const t of r.created) {
      const asked = [...requests].reverse().find((q) => q.title === t.title.trim() && !q.isError) ?? [...requests].reverse().find((q) => q.title === t.title.trim())
      for (const key of OPTION_KEYS) {
        if (!(key in want)) continue
        const pattern = want[key]
        const got = asked?.options[key]
        if (pattern === null && got !== undefined) problems.push(`"${t.title}": ${key}=${got} passed but not asked for`)
        if (typeof pattern === "string" && !re(pattern).test(got ?? "")) problems.push(`"${t.title}": ${key}=${got ?? "(omitted)"}, want /${pattern}/`)
      }
    }
    add("options", problems.length === 0, problems.length ? problems.join("; ") : `options as wanted (${OPTION_KEYS.filter((k) => k in want).map((k) => `${k}: ${want[k] === null ? "omitted" : `/${want[k]}/`}`).join(", ")})`)
  }

  if (e.prompt && r.created.length) {
    const problems: string[] = []
    for (const t of r.created) {
      for (const p of e.prompt.all ?? []) if (!re(p).test(t.prompt)) problems.push(`"${t.title}" lacks /${p}/`)
      for (const p of e.prompt.none ?? []) if (re(p).test(t.prompt)) problems.push(`"${t.title}" has /${p}/`)
    }
    add("prompt", problems.length === 0, problems.length ? problems.join("; ") : "prompt keeps the key details")
  }

  if (e.message) {
    const sent = routed.filter((s) => s.message)
    const problems: string[] = []
    if (e.message.all?.length && !sent.length) problems.push("no message sent")
    // What each task was told this turn, all its messages together: a follow-up may come in two (the change, then a steer).
    const byTask = new Map<string, string[]>()
    for (const s of sent) byTask.set(s.alias ?? s.ref, [...(byTask.get(s.alias ?? s.ref) ?? []), s.message])
    for (const [to, texts] of byTask) {
      for (const p of e.message.all ?? []) if (!re(p).test(texts.join("\n\n"))) problems.push(`messages to ${to} lack /${p}/`)
      for (const p of e.message.none ?? []) if (texts.some((t) => re(p).test(t))) problems.push(`a message to ${to} has /${p}/`)
    }
    add("message", problems.length === 0, problems.length ? problems.join("; ") : sent.length ? "message keeps the key details" : "no message (none required)")
  }

  if (e.reply) {
    const problems: string[] = []
    for (const p of e.reply.all ?? []) if (!re(p).test(replyText)) problems.push(`reply lacks /${p}/`)
    if (e.reply.any?.length && !e.reply.any.some((p) => re(p).test(replyText))) problems.push(`reply has none of ${e.reply.any.map((p) => `/${p}/`).join(", ")}`)
    for (const p of e.reply.none ?? []) if (re(p).test(replyText)) problems.push(`reply has /${p}/`)
    add("reply", problems.length === 0, problems.length ? problems.join("; ") : "reply says what it should")
  }

  if (e.asks) {
    // A question, or a request to clarify put as one ("Tell me which task you mean").
    const asked = ASKS.test(replyText)
    add("asks", asked, asked ? "asks the owner" : "reply asks no question")
  }

  for (const alias of e.noMergeTo ?? []) {
    const bad = r.sends.filter((s) => s.alias === alias && /\bmerg/i.test(s.message) && !DONT_MERGE.test(s.message))
    add(`no merge to ${alias}`, bad.length === 0, bad.length ? `told ${alias} to merge: "${bad[0]!.message.slice(0, 160)}"` : `no merge instruction to ${alias}`)
  }

  const noteChanges = () => {
    const before = r.notesBefore
    const after = r.notesAfter
    const added = Object.entries(after).filter(([id, text]) => before[id] !== text).map(([, text]) => text)
    const removed = Object.keys(before).filter((id) => !(id in after))
    return { added, removed }
  }
  if (e.noteAdded) {
    const { added } = noteChanges()
    const hit = added.some((t) => re(e.noteAdded!).test(t))
    add("note added", hit, hit ? `note: "${added.find((t) => re(e.noteAdded!).test(t))!.slice(0, 160)}"` : `no new or changed note matches /${e.noteAdded}/${added.length ? ` (changed: ${added.map((t) => `"${t.slice(0, 80)}"`).join(", ")})` : ""}`)
  }
  if (e.notesUnchanged) {
    const { added, removed } = noteChanges()
    add("notes unchanged", !added.length && !removed.length, added.length || removed.length ? `${added.length} note(s) added or changed, ${removed.length} removed` : "notes unchanged")
  }

  if (e.suggestions) {
    const problems: string[] = []
    for (const [key, allowedStatuses] of Object.entries(e.suggestions)) {
      const s = r.suggestions[key]
      if (!s) problems.push(`${key}: missing`)
      else if (s.status === "pending" || s.resolvedBy === BOXYARD_EDITOR) problems.push(`${key}: left unresolved (${s.status} by ${s.resolvedBy ?? "nobody"})`)
      else if (!allowedStatuses.includes(s.status as "accepted")) problems.push(`${key}: ${s.status}, want ${allowedStatuses.join(" or ")}`)
    }
    add("suggestions", problems.length === 0, problems.length ? problems.join("; ") : "every suggestion resolved as it should be")
  }

  if (e.noUpdate) {
    const last = r.finalText.replace(/<!--[\s\S]*?-->/g, "").trim()
    const quiet = last === "(no update)" || (!r.replies.length && !last)
    add("no update", quiet, quiet ? "replied (no update)" : `ended with: "${last.slice(0, 160)}"`)
  }

  const passDeterministic = checks.every((x) => x.pass)
  if (e.judge?.length) {
    const v = r.judge
    if (!v) add("judge", false, "no judge verdict")
    else add("judge", v.pass, v.pass ? "judge: every rubric item kept" : `judge: ${v.items.filter((i) => !i.pass).map((i) => `${i.item} (${i.why})`).join("; ")}`)
  }
  return { pass: checks.every((x) => x.pass), passDeterministic, checks }
}

/** The text the judge reads for a case: the created tasks' prompts, or the messages sent. */
export function judgedText(c: Case, r: RunRecord): string | null {
  if (c.expect.judgeOn === "message") return r.sends.map((s) => s.message).filter(Boolean).join("\n\n---\n\n") || null
  return r.created.map((t) => `# ${t.title}\n\n${t.prompt}`).join("\n\n---\n\n") || null
}

/** Whether a task prompt quotes the owner's message word for word (whitespace and quote style aside). */
export function quotesVerbatim(message: string, prompt: string): boolean {
  const norm = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase()
  return norm(prompt).includes(norm(message))
}
