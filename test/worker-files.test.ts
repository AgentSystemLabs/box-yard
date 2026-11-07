import { describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { LocalProvider } from "../server/providers/local.js"
import { readWorkerFile } from "../server/workerFiles.js"
import { boundedWorkerExec } from "../server/workerFiles.js"
import { docker } from "../server/docker/cli.js"
import { q } from "../server/providers/types.js"
import { tmpDir, testConfig } from "./helpers.js"
import { createBoxYard } from "../server/app.js"

describe("bounded worker file reads", () => {
  it("checks actual size and real path with real worker read code", async () => {
    const dir = tmpDir()
    const provider = new LocalProvider(dir)
    const box = await provider.create()
    const work = path.join(provider.root(box), "tasks", "task_example", "work")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "good"), "hello")
    expect(await provider.readFile(box, path.join(work, "good"), { root: work, maxBytes: 5 })).toEqual(Buffer.from("hello"))
    await expect(provider.readFile(box, path.join(work, "good"), { root: work, maxBytes: 4 })).rejects.toThrow()
    fs.writeFileSync(path.join(dir, "outside"), "fixture outside")
    fs.symlinkSync(path.join(dir, "outside"), path.join(work, "escape"))
    await expect(provider.readFile(box, path.join(work, "escape"), { root: work })).rejects.toThrow()
    await expect(provider.readFile(box, work, { root: work })).rejects.toThrow()
  })

  it("caps dishonest transport output without trusting stat or event size", async () => {
    let delivered = 0
    const provider = { nodeBin: "node", execStream: async (_id: string, _command: string, output: (s: string) => void) => {
      for (let i = 0; i < 100; i++) { delivered++; output("a".repeat(8)) }
      return { exitCode: 0 }
    } }
    await expect(readWorkerFile(provider, "example", "/example", { maxBytes: 16 })).rejects.toThrow(/byte limit/)
    expect(delivered).toBe(4)
  })

  it("bounds real subprocess buffering and streaming callback failures without a daemon", async () => {
    const provider = new LocalProvider(tmpDir())
    const box = await provider.create()
    const script = "process.stdout.write('x'.repeat(9 * 1024 * 1024))"
    const command = `${q(process.execPath)} -e ${q(script)}`
    expect(await provider.exec(box, command)).toMatchObject({ exitCode: 153, stdout: "" })
    const result = await docker(process.execPath, ["-e", script])
    expect(result.code).toBe(153)
    expect(result.stdout.length).toBe(0)
    await expect(provider.execStream(box, command, () => { throw new Error("fixture stopped reading") })).rejects.toThrow(/fixture stopped/)
    expect(await boundedWorkerExec(provider, box, "printf fixture-out; printf fixture-err >&2; exit 7")).toEqual({ exitCode: 7, stdout: "fixture-out", stderr: "fixture-err" })
    expect(await boundedWorkerExec(provider, box, command)).toMatchObject({ exitCode: 153, stdout: "" })
  })

  it("enforces actual artifact limits through task dispatch despite a forged zero size", async () => {
    const config = testConfig({ mock: true })
    const provider = new LocalProvider(path.join(config.dataDir, "boxes"))
    const yard = createBoxYard(config, { provider, webDir: "/nonexistent" })
    vi.spyOn(yard.tasks as never, "schedule").mockImplementation(() => {})
    vi.spyOn(yard.tasks as never, "publishDirectory").mockImplementation(() => {})
    try {
      const project = yard.store.createProject({ name: "example" })
      const task = yard.tasks.createTask({ projectId: project.id, title: "Example", prompt: "Example" })
      const box = await provider.create()
      yard.store.updateTask(task.id, { boxId: box })
      const work = path.join(yard.tasks.taskDir(box, task.id), "work")
      fs.mkdirSync(work, { recursive: true })
      const emit = (file: string) => yard.tasks.apply(task.id, { t: "artifact", seq: 1, ts: 1, turnId: null, path: file, size: 0 })
      const good = path.join(work, "example.txt"); fs.writeFileSync(good, "example")
      await emit(good)
      expect(yard.store.listArtifacts()).toHaveLength(1)
      const large = path.join(work, "oversize"); fs.closeSync(fs.openSync(large, "w")); fs.truncateSync(large, 26 * 1024 * 1024)
      await emit(large)
      const outside = path.join(config.dataDir, "outside.txt"); fs.writeFileSync(outside, "fixture outside workspace")
      fs.symlinkSync(outside, path.join(work, "link"))
      await emit(path.join(work, "link"))
      await emit(outside)
      expect(yard.store.listArtifacts()).toHaveLength(1)
    } finally { yard.stop(); yard.store.db.close() }
  })
})
