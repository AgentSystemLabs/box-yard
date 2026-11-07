import { describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard } from "../server/app.js"
import { GIT_PREP_MARK } from "../server/gitFirst.js"
import { LocalProvider } from "../server/providers/local.js"
import { FAKE_CLAUDE, testConfig, tmpDir } from "./helpers.js"

describe("shutdown during an archive", () => {
  it.each(["push", "stream"])("finishes %s cleanup without accessing the closed database", async (phase) => {
    const provider = new LocalProvider(tmpDir("boxes-"), FAKE_CLAUDE)
    const config = testConfig()
    const yard = createBoxYard(config, { provider, webDir: "/nonexistent" })
    const boxId = await provider.create()
    const project = yard.store.createProject({ name: "archive", repo: phase === "push" ? "https://example.invalid/unused.git" : null })
    const task = yard.store.createTask({ projectId: project.id, title: "saved work", prompt: "hello" })
    yard.store.updateTask(task.id, { boxId, status: "done" })
    const dir = yard.tasks.taskDir(boxId, task.id)
    fs.mkdirSync(path.join(dir, "work"), { recursive: true })
    fs.writeFileSync(path.join(dir, "work", "notes.txt"), "keep this work")
    let reached!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { reached = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const exec = provider.exec.bind(provider)
    const stream = provider.execStream.bind(provider)
    vi.spyOn(provider, "exec").mockImplementation(async (id, command) => {
      if (phase !== "push" || !command.includes(GIT_PREP_MARK)) return exec(id, command)
      reached()
      await gate
      return { exitCode: 0, stdout: `${GIT_PREP_MARK} status=skipped\n`, stderr: "" }
    })
    vi.spyOn(provider, "execStream").mockImplementation(async (...args) => {
      const result = await stream(...args)
      reached()
      await gate
      return result
    })
    const warning = vi.spyOn(console, "warn")
    const archiving = yard.tasks.archive(task.id)
    try {
      await started
      yard.stop()
    } finally {
      release()
      await archiving
      if (yard.store.db.open) yard.stop()
    }
    try {
      expect(warning.mock.calls.flat().join("\n")).not.toContain("database connection is not open")
      expect(fs.readFileSync(path.join(dir, "work", "notes.txt"), "utf8")).toBe("keep this work")
      const file = path.join(config.dataDir, "archives", `${task.id}.tgz`)
      expect(fs.existsSync(`${file}.part`)).toBe(false)
      if (phase === "stream") expect(fs.statSync(file).size).toBeGreaterThan(0)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
