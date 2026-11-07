import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cacheStatements, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

function memoryDb(max?: number) {
  const db = cacheStatements(new Database(":memory:"), max)
  cleanups.push(() => db.open && db.close())
  db.exec("CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'one'), (2, 'two')")
  return db
}

describe("prepared statement cache", () => {
  it("compiles each SQL text once and reuses it", () => {
    const db = memoryDb()
    const first = db.prepare("SELECT b FROM t WHERE a = ?")
    expect(db.prepare("SELECT b FROM t WHERE a = ?")).toBe(first)
    expect(first.get(2)).toEqual({ b: "two" })
    expect(db.prepare("SELECT b FROM t WHERE a = ?").get(1)).toEqual({ b: "one" })
  })

  it("sees schema changes made after the statement was cached", () => {
    const db = memoryDb()
    expect(db.prepare("SELECT * FROM t WHERE a = 1").get()).toEqual({ a: 1, b: "one" })
    db.exec("ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT 'new'")
    expect(db.prepare("SELECT * FROM t WHERE a = 1").get()).toEqual({ a: 1, b: "one", c: "new" })
    db.exec("CREATE TABLE t2 (a INTEGER, d TEXT); INSERT INTO t2 VALUES (1, 'swapped'); DROP TABLE t; ALTER TABLE t2 RENAME TO t")
    expect(db.prepare("SELECT * FROM t WHERE a = 1").get()).toEqual({ a: 1, d: "swapped" })
  })

  it("keeps pluck, raw, expand and bind to the caller that asked for them", () => {
    const db = memoryDb()
    const sql = "SELECT b FROM t WHERE a = ?"
    expect(db.prepare(sql).pluck().get(1)).toBe("one")
    expect(db.prepare(sql).raw().get(1)).toEqual(["one"])
    expect(db.prepare(sql).expand().get(1)).toEqual({ t: { b: "one" } })
    expect(db.prepare(sql).bind(2).get()).toEqual({ b: "two" })
    // Everyone else still gets plain rows and passes their own parameters.
    expect(db.prepare(sql).get(1)).toEqual({ b: "one" })
    // Write statements still refuse modes that only make sense for reads.
    expect(() => db.prepare("UPDATE t SET b = ? WHERE a = ?").pluck()).toThrow(/only for statements that return data/)
  })

  it("hands out a fresh statement while the cached one is still being iterated", () => {
    const db = memoryDb()
    const sql = "SELECT a FROM t ORDER BY a"
    const seen: number[][] = []
    for (const row of db.prepare(sql).iterate() as Iterable<{ a: number }>) {
      seen.push([row.a, ...(db.prepare(sql).all() as { a: number }[]).map((r) => r.a)])
    }
    expect(seen).toEqual([
      [1, 1, 2],
      [2, 1, 2],
    ])
    expect(db.prepare(sql).all()).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("drops the least recently used statement past its size", () => {
    const db = memoryDb(2)
    const a = db.prepare("SELECT 1 AS n")
    const b = db.prepare("SELECT 2 AS n")
    expect(db.prepare("SELECT 1 AS n")).toBe(a) // a is now the most recent
    db.prepare("SELECT 3 AS n") // evicts b
    expect(db.prepare("SELECT 1 AS n")).toBe(a)
    expect(db.prepare("SELECT 2 AS n")).not.toBe(b)
  })

  it("still refuses a closed database", () => {
    const db = memoryDb()
    db.prepare("SELECT a FROM t").all()
    db.close()
    expect(() => db.prepare("SELECT a FROM t")).toThrow(/not open/)
  })

  it("lets the Store list tasks again without compiling any SQL", () => {
    const compile = vi.spyOn(Database.prototype, "prepare")
    const db = openDb(tmpDir())
    cleanups.push(() => db.close())
    const store = new Store(db)
    const project = store.createProject({ name: "yard" })
    for (let i = 0; i < 20; i++) store.createTask({ projectId: project.id, title: `Task ${i}`, prompt: "Do it" })
    store.listTasks()
    store.listProjects()
    compile.mockClear()
    expect(store.listTasks()).toHaveLength(20)
    expect(store.listProjects()).toHaveLength(1)
    expect(compile).not.toHaveBeenCalled()
  })
})
