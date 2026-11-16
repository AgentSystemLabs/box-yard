import { describe, expect, it } from "vitest"
import { CASES, CATEGORIES, type Case } from "../scripts/evals/captain-routing/fixtures.js"
import { grade, type RunRecord } from "../scripts/evals/captain-routing/grade.js"
import { judgeInput } from "../scripts/evals/captain-routing/judge.js"
import { bootstrapCases, buildReport, failureType, groupOf, quantile, toMarkdown, wilson, type Run } from "../scripts/evals/captain-routing/report.js"
import { RETRO_SUGGESTIONS, SEED_TASKS } from "../scripts/evals/captain-routing/seed.js"

// The Captain routing eval (scripts/evals/captain-routing) runs a real Captain, so it isn't a test. These check what it
// stands on: the cases are well-formed and the grader passes and fails runs for the right reasons.

const caseById = (id: string) => CASES.find((c) => c.id === id)!

function run(c: Case, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId: c.id,
    effort: "low",
    rep: 1,
    message: c.message ?? null,
    tools: [],
    replies: [],
    finalText: "",
    created: [],
    sends: [],
    notesBefore: {},
    notesAfter: {},
    suggestions: {},
    ok: true,
    error: null,
    latencyMs: 5000,
    costUsd: 0.05,
    modelCalls: 2,
    tokens: { input: 0, output: 500, cacheRead: 40000, cacheWrite: 3000 },
    transcript: [],
    ...patch,
  }
}

const failed = (c: Case, r: RunRecord) =>
  grade(c, r)
    .checks.filter((x) => !x.pass)
    .map((x) => x.name)

describe("the routing eval's cases", () => {
  it("has at least 40 well-formed cases covering every category", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
    for (const cat of CATEGORIES) expect(CASES.some((c) => c.category === cat), cat).toBe(true)
    const aliases = new Set(SEED_TASKS.map((t) => t.alias))
    const keys = new Set(RETRO_SUGGESTIONS.map((s) => s.key))
    for (const c of CASES) {
      expect(CATEGORIES).toContain(c.category)
      expect(Boolean(c.message) !== Boolean(c.setup?.retro), `${c.id}: a message or a retro`).toBe(true)
      for (const a of [...(c.expect.sendTo ?? []), ...(c.expect.mayMessage ?? []), ...(c.expect.noMergeTo ?? [])]) expect(aliases, `${c.id}: ${a}`).toContain(a)
      for (const k of Object.keys(c.expect.suggestions ?? {})) expect(keys, `${c.id}: ${k}`).toContain(k)
      const e = c.expect
      const patterns = [...(e.prompt?.all ?? []), ...(e.prompt?.none ?? []), ...(e.message?.all ?? []), ...(e.message?.none ?? []), ...(e.reply?.all ?? []), ...(e.reply?.any ?? []), ...(e.reply?.none ?? []), ...(e.noteAdded ? [e.noteAdded] : [])]
      for (const p of patterns) expect(() => new RegExp(p, "i"), `${c.id}: /${p}/`).not.toThrow()
      for (const p of Object.values(e.options ?? {})) if (typeof p === "string") expect(() => new RegExp(p, "i")).not.toThrow()
      // A rubric needs something to read: a task's prompt, or (judgeOn "message") a message.
      if (e.judge?.length) expect(e.judgeOn === "message" ? e.sendTo?.length : e.created, c.id).toBeTruthy()
    }
  })
})

describe("the routing eval's grader", () => {
  it("passes a new task that keeps the request and fails one with options nobody asked for", () => {
    const c = caseById("create-back-in-stock")
    const created = [{ id: "t1", title: "Back-in-stock emails", prompt: "When a product is restocked, email everyone who signed up for an alert." }]
    const plain = { name: "mcp__boxyard__create_task", input: { title: "Back-in-stock emails", prompt: created[0]!.prompt } }
    expect(failed(c, run(c, { created, tools: [plain] }))).toEqual([])
    const pinned = { ...plain, input: { ...plain.input, effort: "low" } }
    expect(failed(c, run(c, { created, tools: [pinned] }))).toEqual(["options"])
    // Two tasks for one request is a routing error, and so is none.
    expect(failed(c, run(c, { created: [...created, { ...created[0]!, id: "t2" }], tools: [plain, plain] }))).toContain("created")
    expect(failed(c, run(c))).toContain("created")
  })

  it("routes a follow-up to the right task, reading all its messages together", () => {
    const c = caseById("reuse-csv-columns")
    const send = (message: string) => ({ tool: "send_to_task", ref: "task_csv", alias: "csv" as const, message })
    expect(failed(c, run(c, { sends: [send("Add the customer's email as a column, and ISO 8601 dates.")] }))).toEqual([])
    // The change, then a steer: the details only have to reach the task.
    expect(failed(c, run(c, { sends: [send("Add the customer's email column and ISO 8601 dates."), send("Check PR #41 is still open first.")] }))).toEqual([])
    expect(failed(c, run(c, { sends: [send("Add the customer's email column.")] }))).toEqual(["message"])
    // A new task instead of the one with the open PR, or a message to another task.
    expect(failed(c, run(c, { created: [{ id: "t1", title: "CSV columns", prompt: "email, ISO 8601" }] }))).toEqual(expect.arrayContaining(["created", "messaged"]))
    expect(failed(c, run(c, { sends: [{ ...send("email, ISO 8601"), alias: "dark" }] }))).toContain("messaged")
  })

  it("doesn't count a follow-up to a task the Captain just created as routing", () => {
    const c = caseById("create-footer-year")
    const created = [{ id: "t1", title: "Footer year", prompt: "The footer says © 2025: show the current year." }]
    const r = run(c, { created, sends: [{ tool: "send_to_task", ref: "t1", alias: null, message: "Also check the tests.", toNew: true }] })
    expect(failed(c, r)).toEqual([])
  })

  it("fails a second merge of a PR whose merge is under way, but not a 'don't merge'", () => {
    const c = caseById("merge-all-ready")
    const send = (alias: "csv" | "tax", message: string) => ({ tool: "send_to_task", ref: alias, alias, message })
    expect(failed(c, run(c, { sends: [send("csv", "Merge PR #41.")], replies: ["Merging #41; #38 is already merging."] }))).toEqual([])
    expect(failed(c, run(c, { sends: [send("csv", "Merge PR #41."), send("tax", "Merge PR #38.")] }))).toEqual(expect.arrayContaining(["no merge to tax", "messaged"]))
    const dark = caseById("merge-dont-merge-dark")
    const r = run(dark, { sends: [{ tool: "send_to_task", ref: "dark", alias: "dark", message: "Add an aria-label to the toggle. Don't merge: Sam wants to look first." }] })
    expect(failed(dark, r)).toEqual([])
  })

  it("wants every retro suggestion resolved by the Captain, then (no update)", () => {
    const c = caseById("notes-retro")
    const tools = [
      { name: "mcp__boxyard__list_notes", input: {} },
      { name: "mcp__boxyard__resolve_suggestion", input: {} },
    ]
    const done = { status: "accepted", resolvedBy: "captain", reason: null }
    const rejected = { ...done, status: "rejected" }
    const good = { db: done, log: rejected, dup: rejected, conv: rejected }
    expect(failed(c, run(c, { message: null, tools, suggestions: good, finalText: "(no update)" }))).toEqual([])
    // Left for Box Yard to reject at the end of the retro.
    const left = { ...good, conv: { status: "rejected", resolvedBy: "boxyard", reason: "Not resolved in its notes retro." } }
    expect(failed(c, run(c, { message: null, tools, suggestions: left, finalText: "(no update)" }))).toEqual(["suggestions"])
    expect(failed(c, run(c, { message: null, tools, suggestions: good, finalText: "Done: accepted one note.", replies: ["Done: accepted one note."] }))).toEqual(["no update"])
  })

  it("takes a request to clarify as asking, with or without a question mark, as long as nothing starts", () => {
    const c = caseById("ambig-fix-it")
    expect(failed(c, run(c, { replies: ["Which task do you mean?"] }))).toEqual([])
    expect(failed(c, run(c, { replies: ["I can't tell what \"it\" is. Tell me which task you mean and I'll start it."] }))).toEqual([])
    expect(failed(c, run(c, { replies: ["Done: I fixed the flaky tests."] }))).toEqual(["asks"])
    const guessed = { tools: [{ name: "mcp__boxyard__send_to_task", input: {} }], sends: [{ tool: "send_to_task", ref: "flaky", alias: "flaky" as const, message: "Fix it." }], replies: ["Is that the one?"] }
    expect(failed(c, run(c, guessed))).toEqual(expect.arrayContaining(["messaged", "no send_to_task"]))
  })

  it("takes any plain 'that's another project' as handing other-project work off", () => {
    const c = caseById("xproj-marketing")
    const reply = (text: string) => failed(c, run(c, { replies: [text], finalText: text }))
    expect(reply("The marketing site isn't part of this project. Send it to the project that holds the marketing site.")).toEqual([])
    expect(reply("The marketing site is another project: ask the Coordinator.")).toEqual([])
    expect(reply("I couldn't find a pricing page on the marketing site.")).toEqual(["reply"])
  })

  it("reads a number and its unit however the prompt writes them", () => {
    const c = caseById("pq-rate-limit")
    const judge = { pass: true, items: [], verbatim: false, model: "m", costUsd: 0 }
    const prompt = (window: string) => `Rate-limit POST /api/login: at most 5 attempts per IP per ${window}, then 429 with Retry-After. In-memory, no Redis.`
    for (const w of ["15 minutes", "15-minute window", "15min"]) expect(failed(c, run(c, { created: [{ id: "t1", title: "Rate limit", prompt: prompt(w) }], judge })), w).toEqual([])
    expect(failed(c, run(c, { created: [{ id: "t1", title: "Rate limit", prompt: prompt("hour") }], judge }))).toEqual(["prompt"])
  })

  it("counts a failed turn and a missing judge verdict as failures", () => {
    const c = caseById("pq-coupon-bug")
    const created = [{ id: "t1", title: "SPRING10", prompt: "SPRING10 stays below the $50 minimum. Reproduce it with a failing test first; keep the fix in src/cart/." }]
    expect(grade(c, run(c, { created })).passDeterministic).toBe(true)
    expect(failed(c, run(c, { created }))).toEqual(["judge"])
    const judge = { pass: true, items: [], verbatim: false, model: "m", costUsd: 0 }
    expect(failed(c, run(c, { created, judge }))).toEqual([])
    expect(failed(c, run(c, { created, judge, ok: false, error: "Timed out" }))).toEqual(["turn"])
  })
})

describe("the routing eval's report and judge", () => {
  it("computes intervals and quantiles", () => {
    const [lo, hi] = wilson(45, 49)
    expect(lo).toBeCloseTo(0.808, 2)
    expect(hi).toBeCloseTo(0.968, 2)
    expect(wilson(0, 0)).toEqual([0, 1])
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([], 0.5)).toBeNull()
    const ids = ["a", "b", "c", "d"]
    const [a, b] = bootstrapCases(ids, (s) => s.filter((x) => x === "a").length / s.length)
    expect(a).toBeLessThanOrEqual(0.25)
    expect(b).toBeGreaterThanOrEqual(0.25)
    // Seeded: the same interval every time.
    expect(bootstrapCases(ids, (s) => s.filter((x) => x === "a").length / s.length)).toEqual([a, b])
  })

  it("names failure types by check and category", () => {
    expect(failureType("no create_task", "cross-project")).toBe("Did another project's work")
    expect(failureType("no create_task", "code-question")).toMatch(/^Wrong routing/)
    expect(failureType("no merge to tax", "merge-guard")).toBe("Second merge of a PR already merging")
    expect(failureType("options", "runner-options")).toBe("Unrequested or wrong task options")
  })

  it("renders tables and gives the judge the request, the hand-off and the rubric", () => {
    expect(toMarkdown([{ table: { head: ["a", "b"], rows: [["1", "x|y"]], align: ["l", "r"] } }])).toBe("| a | b |\n| --- | ---: |\n| 1 | x\\|y |")
    // A chart is HTML only: the markdown leaves it out without a gap.
    expect(toMarkdown([{ p: "one" }, { html: "<svg></svg>" }, { p: "two" }])).toBe("one\n\ntwo")
    const input = judgeInput("Fix SPRING10.", "# Task\n\nFix it.", ["Keeps SPRING10.", "Adds nothing."])
    expect(input).toContain("Fix SPRING10.")
    expect(input).toContain("# Task")
    expect(input).toMatch(/1\. Keeps SPRING10\.\n2\. Adds nothing\./)
  })

  it("reports a labelled run (a prompt variant) as its own group, compared against --reference", () => {
    const [a, b] = CASES
    const r = (c: Case, label: string | undefined, pass: boolean): Run => ({ ...run(c, label ? { label } : {}), grade: { pass, passDeterministic: pass, checks: [] } })
    expect(groupOf({ effort: "low" })).toBe("low")
    expect(groupOf({ effort: "low", label: "pruned-low" })).toBe("pruned-low")
    const runs = [r(a!, undefined, true), r(b!, undefined, true), r(a!, "pruned-low", true), r(b!, "pruned-low", false)]
    const { blocks, stats } = buildReport(runs, [], "low")
    expect(stats.map((s) => [s.level, s.passed, s.runs])).toEqual([
      ["pruned-low", 1, 2],
      ["low", 2, 2],
    ])
    const paired = blocks.find((x) => "table" in x && x.table.head[0] === "Levels") as { table: { rows: string[][] } }
    expect(paired.table.rows).toEqual([["pruned-low − low", "-50.0 pts", expect.any(String), "1", "0"]])
  })
})
