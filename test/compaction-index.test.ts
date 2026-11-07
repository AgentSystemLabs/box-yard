import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { CompactionIndex, compactionExcerpt, compactionIndexPrompt, EXCERPT_SAMPLE_BYTES, FULL_CHUNK_MAX } from "../server/compactionIndex.js"
import { writeCompaction } from "../server/compactions.js"
import { tmpDir } from "./helpers.js"

const stores: Store[] = []
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.db.close() })
function fixture() {
  const dir = tmpDir()
  const store = new Store(openDb(dir, ":memory:")); stores.push(store)
  return { dir, store, index: new CompactionIndex(store, "captain:example", dir) }
}
const at = Date.parse("2026-10-20T10:00:00Z")
const save = (dir: string, text: string, time = at) => writeCompaction(dir, { at: time, sessionId: "example", model: "example", trigger: "auto", tokensBefore: null }, text)
const narrative = "## Decisions and preferences\n- Keep drafts until Save.\n\n## Ongoing work\n- Add dated history navigation to retained compactions.\n\n## Open threads and next steps\n- Review the date filters."

describe("dated compaction catalog", () => {
  it("extracts actual topics, bounds each level, and never changes the original", () => {
    const { dir, index } = fixture()
    const f = save(dir, narrative + "\n" + "long detail ☀️ ".repeat(10_000))
    const page = index.page()
    expect(page.entries[0]).toMatchObject({ id: f.id, title: "Add dated history navigation to retained compactions.", at: new Date(at).toISOString() })
    expect(page.entries[0]!.description!.length).toBeLessThanOrEqual(200)
    const summary = index.read(f.id)
    expect(summary).toMatchObject({ extractive: true, sampleLimited: true })
    expect("summary" in summary && summary.summary!.length).toBeLessThanOrEqual(2400)
    let offset = 0, restored = ""
    do {
      const chunk = index.read(f.id, "full", offset, FULL_CHUNK_MAX)
      if (!("markdown" in chunk)) throw new Error("Expected full content")
      restored += chunk.markdown
      if (chunk.nextOffset === null) break
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    } while (true)
    expect(restored).toBe(f.markdown)
    expect(fs.readFileSync(f.markdownFile, "utf8")).toBe(f.markdown)
  })

  it("keeps one-character UTF-8 reads advancing, including malformed legacy tails", () => {
    const { dir, index } = fixture()
    fs.writeFileSync(path.join(dir, "legacy saved note.md"), "☀️ Work on history.")
    let offset = 0, restored = ""
    do {
      const chunk = index.read("legacy saved note", "full", offset, 1)
      if (!("markdown" in chunk)) throw new Error("Expected full content")
      restored += chunk.markdown
      if (chunk.nextOffset === null) break
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    } while (true)
    expect(restored).toBe("☀️ Work on history.")
    fs.writeFileSync(path.join(dir, "broken.md"), Buffer.from([0xf0, 0x9f]))
    expect(index.read("broken", "full", 0, 1)).toMatchObject({ nextOffset: null })
    expect(compactionExcerpt("---\r\ntimestamp: 2020-01-01\r\n---\r\n# Old\r\n\r\nActual legacy work.").title).toBe("Actual legacy work.")
  })

  it("pages every same-timestamp collision, mixed second precision, and inclusive dates without omissions", () => {
    const { dir, index } = fixture()
    const ids = Array.from({ length: 12 }, (_, i) => save(dir, narrative + `\n- Change ${i}`).id)
    fs.writeFileSync(path.join(dir, "2026-10-20T10-00-00Z.md"), narrative)
    save(dir, narrative, at + 500)
    const found: string[] = []
    let before: string | undefined
    do {
      const p = index.page({ limit: 3, before, since: "2026-10-20", until: "2026-10-20T10:00:00.500Z" })
      expect(p.total).toBe(14); expect(p.matched).toBe(14)
      found.push(...p.entries.map(e => e.id))
      before = p.nextBefore ?? undefined
    } while (before)
    expect(new Set(found).size).toBe(14)
    expect(found.filter(id => ids.includes(id))).toEqual([...ids].reverse())
    expect(index.page({ since: "2026-10-21" })).toMatchObject({ total: 14, matched: 0, entries: [] })
    expect(() => index.page({ before: "later" })).toThrow(/ISO/)
    expect(() => index.page({ before: "2026-10-20T10-00-00.000Z-999" })).toThrow(/retained before cursor/)
  })

  it("backfills legacy filenames by saved time and invalidates changed files without following symlinks", () => {
    const { dir, index } = fixture()
    const legacy = path.join(dir, "legacy-note.md")
    fs.writeFileSync(legacy, `---\ntimestamp: 2020-01-01T00:00:00Z\n---\n# Old summary\n\n${narrative}`)
    fs.writeFileSync(path.join(dir, "undated.md"), "Legacy work kept without a date.")
    const outside = path.join(tmpDir(), "private.md"); fs.writeFileSync(outside, "PRIVATE")
    fs.symlinkSync(outside, path.join(dir, "escape.md"))
    expect(index.page().total).toBe(2)
    const old = index.page({ until: "2020-01-01T00:00:00Z" })
    expect(old.entries[0]).toMatchObject({ id: "legacy-note", dateSource: "saved timestamp" })
    expect(() => index.read("../private")).toThrow(/No saved compaction/)
    expect(() => index.read("escape")).toThrow(/No saved compaction/)
    fs.writeFileSync(legacy, "---\ntimestamp: 2020-01-01T00:00:00Z\n---\n# Old\n\nRevised actual work.")
    expect(index.read("legacy-note").title).toBe("Revised actual work.")
    fs.unlinkSync(legacy)
    expect(index.page().total).toBe(1)
    expect(() => index.read("legacy-note")).toThrow(/No saved compaction/)
  })

  it("indexes DB-only Coordinator and task recaps, including same-length corrections and deleted entries", () => {
    const { dir, store } = fixture()
    const p = store.createProject({ name: "example" })
    const t = store.createTask({ projectId: p.id, title: "Example", prompt: "Example" })
    const c = store.addTaskCompaction({ taskId: t.id, sessionId: "s", at, statusBefore: null, statusAfter: null, tokensBefore: null, tokensAfter: null, summary: "Saved task recap.", archivePath: null, archiveAvailable: false })
    const task = new CompactionIndex(store, `task:${t.id}`)
    expect(task.page().entries[0]!.title).toBe("Saved task recap.")
    store.db.prepare("UPDATE task_compactions SET summary = ? WHERE id = ?").run("Other task recap.", c.id)
    expect(task.read(c.id).title).toBe("Other task recap.")
    expect(() => new CompactionIndex(store, "task:another").read(c.id)).toThrow(/No saved/)
    const f = save(dir, narrative)
    store.addOrchestratorCompaction({ id: f.id, at, sessionId: "s", model: "m", trigger: "auto", tokensBefore: null, markdownPath: f.markdownFile, jsonPath: f.jsonFile, markdown: f.markdown, tasks: [] })
    const coordinator = new CompactionIndex(store, "coordinator", dir)
    coordinator.page()
    const read = vi.spyOn(fs, "readSync")
    coordinator.page(); coordinator.page()
    expect(read).not.toHaveBeenCalled() // DB copy wins without invalidating the cache each turn.
    fs.unlinkSync(f.markdownFile)
    expect(coordinator.read(f.id, "full")).toMatchObject({ markdown: f.markdown })
    store.db.prepare("DELETE FROM task_compactions WHERE id = ?").run(c.id)
    expect(task.page().total).toBe(0)
  })

  it("persists excerpts across a reopened database, keeps new entries current and rebuilds a lost cache", () => {
    const data = tmpDir(), dir = path.join(data, "compactions")
    const first = new Store(openDb(data)); stores.push(first)
    const f = save(dir, narrative)
    const original = new CompactionIndex(first, "captain:example", dir).page()
    first.db.close(); stores.splice(stores.indexOf(first), 1)
    const reopened = new Store(openDb(data)); stores.push(reopened)
    const index = new CompactionIndex(reopened, "captain:example", dir)
    const read = vi.spyOn(fs, "readSync")
    expect(index.page()).toEqual(original)
    expect(read).not.toHaveBeenCalled()
    const latest = save(dir, "Newly completed history work.", at + 1000)
    expect(index.page()).toMatchObject({ total: 2, entries: [{ id: latest.id }, { id: f.id }] })
    reopened.db.exec("DELETE FROM compaction_index")
    expect(index.page().entries.map(e => e.id)).toEqual([latest.id, f.id])
    expect(fs.readFileSync(f.markdownFile, "utf8")).toBe(f.markdown)
  })

  it("keeps many-entry context and content work bounded and reuses the persistent cache after restart", () => {
    const { dir, store, index } = fixture()
    for (let i = 0; i < 500; i++) save(dir, narrative + "\n" + "Long saved detail. ".repeat(3000), at + i * 1000)
    const read = vi.spyOn(fs, "readSync")
    const start = performance.now()
    const initial = compactionIndexPrompt(index)
    const coldMs = performance.now() - start
    expect(initial.length).toBeLessThan(4000)
    expect(initial).toContain("Retained: 500"); expect(initial).toContain("nextBefore: 2026-10-20T10-08-15.000Z")
    // One 1KiB header per newly discovered file, five bounded samples. No full history reads.
    expect(read.mock.calls.reduce((n, c) => n + Number(c[3]), 0)).toBeLessThanOrEqual(500 * 1024 + 5 * EXCERPT_SAMPLE_BYTES)
    read.mockClear()
    const warmStart = performance.now()
    const warm = compactionIndexPrompt(new CompactionIndex(store, "captain:example", dir))
    const warmMs = performance.now() - warmStart
    expect(warm).toBe(initial); expect(read).not.toHaveBeenCalled()
    read.mockClear()
    const page = index.page({ limit: 100 })
    expect(page.entries).toHaveLength(20)
    expect(JSON.stringify(page).length).toBeLessThan(10_000)
    expect(read.mock.calls.length).toBe(15)
    process.stdout.write(JSON.stringify({ fixture: "500 entries, ~28MB originals", initialChars: initial.length, pageChars: JSON.stringify(page).length, coldMs: Math.round(coldMs), warmMs: Math.round(warmMs), warmContentReads: 0 }) + "\n")
  })

  it("derives excerpts from prose and handles empty/legacy headings without invented topics", () => {
    expect(compactionExcerpt("# Orchestrator compaction summary\n\nActual old work.").title).toBe("Actual old work.")
    expect(compactionExcerpt("## Ongoing work\n- none\n\n## Decisions and preferences\n- Keep changes small.").title).toBe("Keep changes small.")
    expect(compactionExcerpt("# Empty\n").title).toBe("No saved narrative available")
  })
})
