import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore, autocompactFlag, compactThreshold } from "../server/settings.js"
import { contextTokens, contextWindowOf, formatTokens, parseContextReport } from "../server/usage.js"
import {
  SUMMARY_PROMPT,
  cleanSummary,
  compactionStamp,
  finishCompaction,
  lastCompaction,
  listCompactions,
  summaryLooksValid,
  writeCompaction,
} from "../server/compactions.js"
import { CompactionIndex, compactionIndexPrompt } from "../server/compactionIndex.js"
import { tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))

describe("usage helpers", () => {
  it("counts the prompt side of the last call plus its output, not the turn total", () => {
    expect(contextTokens({ input_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4000, output_tokens: 500 })).toBe(84_510)
    expect(contextTokens({})).toBeNull()
    expect(contextTokens(undefined)).toBeNull()
  })
  it("reads the window from modelUsage", () => {
    expect(contextWindowOf({ "claude-opus-5-5": { contextWindow: 1_000_000 } })).toBe(1_000_000)
    expect(contextWindowOf({})).toBeNull()
  })
  it("parses the /context report", () => {
    expect(parseContextReport("## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 16.1k / 1m (2%)\n")).toEqual({ tokens: 16_100, window: 1_000_000 })
    expect(parseContextReport("Tokens: 84,000 / 200k")).toBeNull() // thousands separators aren't printed by the CLI; stay safe
    expect(parseContextReport("nothing here")).toBeNull()
  })
  it("formats tokens", () => {
    expect(formatTokens(84_000)).toBe("84k")
    expect(formatTokens(1_000_000)).toBe("1m")
    expect(formatTokens(512)).toBe("512")
  })
})

describe("settings", () => {
  it("defaults to opus 5.5 with high effort for both", () => {
    const s = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" }).info()
    expect(s.settings.orchestratorModel).toBe("claude-opus-5-5")
    expect(s.settings.orchestratorEffort).toBe("high")
    expect(s.settings.agentModel).toBe("claude-opus-5-5")
    expect(s.settings.agentEffort).toBe("high")
    expect(s.settings.agentRoutingConfig).toBe("")
    expect(s.sources.agentModel).toBe("default")
  })
  it("env vars override the defaults, and values saved in the UI win over env vars", () => {
    const store = memStore()
    const settings = new SettingsStore(store, { orchestratorModel: "env-orch", workerModel: "env-worker" })
    expect(settings.info().settings.orchestratorModel).toBe("env-orch")
    expect(settings.info().sources.agentModel).toBe("env")
    settings.update({ agentModel: "ui-model", agentEffort: "orchestrator" })
    const info = settings.info()
    expect(info.settings.agentModel).toBe("ui-model")
    expect(info.settings.agentEffort).toBe("orchestrator")
    expect(info.sources.agentModel).toBe("ui")
    expect(info.settings.orchestratorModel).toBe("env-orch")
    // survives a new store object over the same database
    expect(new SettingsStore(store, { orchestratorModel: "", workerModel: "" }).get().agentModel).toBe("ui-model")
    settings.reset()
    expect(settings.info().settings.agentModel).toBe("env-worker")
  })
  it("saves routing YAML as a free-text setting", () => {
    const settings = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" })
    const info = settings.update({ agentRoutingConfig: "fallback:\n  model: claude-sonnet-5-5\n  effort: medium\n" })
    expect(info.settings.agentRoutingConfig).toContain("fallback")
    expect(info.sources.agentRoutingConfig).toBe("ui")
  })
  it("defaults the Coordinator's and Captains' auto-compact to 250k tokens, and keeps a saved threshold", () => {
    const store = memStore()
    const fresh = new SettingsStore(store, { orchestratorModel: "", workerModel: "" }).info()
    expect(fresh.settings.orchestratorAutoCompact).toEqual({ enabled: true, unit: "tokens", value: 250_000 })
    expect(fresh.sources.orchestratorAutoCompact).toBe("default")
    expect(compactThreshold(fresh.settings.orchestratorAutoCompact, 1_000_000)).toBe(250_000)
    // A threshold saved in Settings before the default changed still wins; saving another field keeps it.
    store.setKv("settings", JSON.stringify({ orchestratorAutoCompact: { enabled: true, unit: "percent", value: 80 } }))
    const settings = new SettingsStore(store, { orchestratorModel: "", workerModel: "" })
    settings.update({ captainModel: "claude-sonnet-5-5" })
    expect(settings.info().settings.orchestratorAutoCompact).toEqual({ enabled: true, unit: "percent", value: 80 })
    expect(settings.info().sources.orchestratorAutoCompact).toBe("ui")
  })
  it("rejects bad values", () => {
    const settings = new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "" })
    expect(() => settings.update({ agentEffort: "turbo" })).toThrow()
    expect(() => settings.update({ orchestratorModel: "has space" })).toThrow()
    expect(() => settings.update({ orchestratorAutoCompact: { enabled: true, unit: "percent", value: 99 } })).toThrow(/10 and 95/)
    expect(() => settings.update({ agentAutoCompact: { enabled: true, unit: "tokens", value: 5000 } })).toThrow(/between/)
    expect(() => settings.update({ nope: 1 })).toThrow()
  })
  it("turns thresholds into tokens", () => {
    expect(compactThreshold({ enabled: false, unit: "percent", value: 80 }, 1_000_000)).toBeNull()
    expect(compactThreshold({ enabled: true, unit: "percent", value: 50 }, 200_000)).toBe(100_000)
    expect(compactThreshold({ enabled: true, unit: "tokens", value: 150_000 }, 1_000_000)).toBe(150_000)
    expect(autocompactFlag({ enabled: true, unit: "percent", value: 10 }, 200_000)).toBe("100000") // clamped up to the CLI's minimum
    expect(autocompactFlag({ enabled: false, unit: "percent", value: 50 }, null)).toBeNull()
  })
  it("sizes a percent from the task's window, so a wrong window is a wrong --autocompact", () => {
    const quarter = { enabled: true, unit: "percent", value: 25 } as const
    expect(autocompactFlag(quarter, null)).toBe("250000") // no window known yet: 1M
    expect(autocompactFlag(quarter, 1_000_000)).toBe("250000")
    expect(autocompactFlag(quarter, 200_000)).toBe("100000") // the floor, where the CLI compacts at about 67k
  })
  it("the migration forgets a stored 200k window on Claude Code tasks, the one an old CLI assumed for an unknown model", () => {
    const dataDir = tmpDir()
    const db = new Database(path.join(dataDir, "box-yard.sqlite"))
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("SET context_window = NULL WHERE context_window = 200000")))
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_old', 'old', 1, 1)").run()
    const add = db.prepare(
      "INSERT INTO tasks (id, project_id, title, prompt, status, session_id, created_at, updated_at, last_active_at, context_window, agent_cli) VALUES (?, 'prj_old', 'old', 'x', 'idle', 's', 1, 1, 1, ?, ?)",
    )
    add.run("task_guessed", 200_000, "claude")
    add.run("task_older", 200_000, null) // before tasks had an agent CLI: Claude Code
    add.run("task_codex", 200_000, "codex")
    add.run("task_wide", 1_000_000, "claude")
    add.run("task_new", null, "claude")
    db.close()

    const store = new Store(openDb(dataDir))
    const window = (id: string) => store.getTask(id)!.contextWindow
    expect([window("task_guessed"), window("task_older")]).toEqual([null, null])
    expect([window("task_codex"), window("task_wide"), window("task_new")]).toEqual([200_000, 1_000_000, null])
    // Sized from the default window again, as it was before the guess was stored.
    expect(autocompactFlag({ enabled: true, unit: "percent", value: 25 }, window("task_guessed"))).toBe("250000")
  })
})

describe("compaction log", () => {
  it("names files so they sort chronologically", () => {
    expect(compactionStamp(Date.UTC(2026, 9, 22, 3, 40, 5, 321))).toBe("2026-10-22T03-40-05.321Z")
    expect(compactionStamp(Date.UTC(2026, 9, 22, 3, 40, 5))).toBe("2026-10-22T03-40-05.000Z")
  })
  it("writes frontmatter and sections, fills in tokens_after, and never overwrites", () => {
    const dir = path.join(tmpDir(), "orchestrator", "compactions")
    const meta = { at: Date.UTC(2026, 9, 22, 3, 40, 5), sessionId: "sess-1", model: "claude-opus-5-5", trigger: "auto" as const, tokensBefore: 412_000 }
    const summary = "## Decisions and preferences\n- short replies\n\n## Projects and repos\n- x\n\n## Ongoing work\n- none\n\n## Open threads and next steps\n- none"
    const task = {
      taskId: "task_abc123",
      title: "Fix bug",
      status: "done" as const,
      projectId: "prj_abc123",
      projectName: "demo",
      branch: "fix/bug",
      prUrl: "https://github.com/acme/demo/pull/1",
      sessionId: "task-session",
      summary: "Fixed the bug and opened a PR.",
      lastActiveAt: meta.at - 1000,
    }
    const first = writeCompaction(dir, meta, summary, [task])
    const file = first.markdownFile
    expect(path.basename(file)).toBe("2026-10-22T03-40-05.000Z.md")
    expect(path.basename(first.jsonFile)).toBe("2026-10-22T03-40-05.000Z.json")
    expect(JSON.parse(fs.readFileSync(first.jsonFile, "utf8")).tasks[0].taskId).toBe("task_abc123")
    const second = writeCompaction(dir, meta, summary)
    expect(path.basename(second.markdownFile)).toBe("2026-10-22T03-40-05.000Z-2.md")
    finishCompaction(file, 38_000)
    const text = fs.readFileSync(file, "utf8")
    expect(text).toMatch(/^---\ntimestamp: 2026-10-22T03:40:05\.000Z\nsession_id: sess-1\nmodel: claude-opus-5-5\ntrigger: auto\ntokens_before: 412000\ntokens_after: 38000\ntask_ids: task_abc123\n---/)
    expect(JSON.parse(fs.readFileSync(first.jsonFile, "utf8")).tokensAfter).toBe(38_000)
    for (const h of ["## Decisions and preferences", "## Projects and repos", "## Ongoing work", "## Open threads and next steps"]) expect(text).toContain(h)
    // The -2 file was written second, so it lists after the first.
    expect(listCompactions(dir)).toEqual(["2026-10-22T03-40-05.000Z.md", "2026-10-22T03-40-05.000Z-2.md"])
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false)
    expect(lastCompaction(dir)).toMatchObject({ trigger: "auto", tokensBefore: 412_000 })
  })
  it("orders compactions from the same second by their suffix, so the newest comes last (#50)", () => {
    const dir = path.join(tmpDir(), "orchestrator", "compactions")
    const summary = "## Decisions and preferences\n- a"
    const at = Date.UTC(2026, 9, 22, 3, 40, 5)
    for (let n = 1; n <= 11; n++) writeCompaction(dir, { at, sessionId: "s", model: "m", trigger: "button", tokensBefore: n }, summary)
    writeCompaction(dir, { at: at - 1000, sessionId: "s", model: "m", trigger: "button", tokensBefore: 0 }, summary)
    const names = listCompactions(dir)
    expect(names[0]).toBe("2026-10-22T03-40-04.000Z.md")
    expect(names.slice(1, 4)).toEqual(["2026-10-22T03-40-05.000Z.md", "2026-10-22T03-40-05.000Z-2.md", "2026-10-22T03-40-05.000Z-3.md"])
    expect(names.at(-1)).toBe("2026-10-22T03-40-05.000Z-11.md")
    expect(lastCompaction(dir)).toMatchObject({ tokensBefore: 11 })
    const store = new Store(openDb(dir, ":memory:"))
    expect(compactionIndexPrompt(new CompactionIndex(store, "coordinator", dir))).toContain("2026-10-22T03-40-05.000Z-11")
    store.db.close()
  })
  it("cleans and validates summaries", () => {
    expect(cleanSummary("Sure!\n\n## Decisions and preferences\n- a")).toBe("## Decisions and preferences\n- a")
    expect(cleanSummary("```markdown\n## Decisions and preferences\n- a\n```")).toBe("## Decisions and preferences\n- a")
    expect(summaryLooksValid("ok")).toBe(false)
    expect(summaryLooksValid(`## Decisions and preferences\n${"- a thing\n".repeat(10)}`)).toBe(true)
    expect(SUMMARY_PROMPT).toContain("## Open threads and next steps")
  })
  it("the prompt gives a bounded dated index and navigation to every older entry", () => {
    const dir = path.join(tmpDir(), "orchestrator", "compactions")
    const store = new Store(openDb(tmpDir(), ":memory:"))
    try {
      const index = new CompactionIndex(store, "coordinator", dir)
      expect(compactionIndexPrompt(index)).toContain("Retained: 0")
      for (let i = 0; i < 7; i++) writeCompaction(dir, { at: Date.UTC(2026, 0, 1, 0, 0, i), sessionId: "s", model: "m", trigger: "button", tokensBefore: 1 }, "## Decisions and preferences\n- Keep dated navigation.")
      const p = compactionIndexPrompt(index)
      expect(p).toMatch(/chronological/); expect(p).toMatch(/newest first/)
      expect(p).toContain("Retained: 7")
      expect(p).toContain("Keep dated navigation.")
      expect(p).toContain("nextBefore: 2026-01-01T00-00-02.000Z")
      expect(p).toContain("2026-01-01T00:00:00.000Z") // Coverage reaches the oldest.
      expect(p).not.toContain('"id":"2026-01-01T00-00-00.000Z"')
    } finally { store.db.close() }
  })
})
