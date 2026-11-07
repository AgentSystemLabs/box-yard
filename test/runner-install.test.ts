import { afterEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { FAKE_CLAUDE, testConfig, tmpDir } from "./helpers.js"

afterEach(() => vi.restoreAllMocks())

async function setup() {
  const provider = new LocalProvider(tmpDir("runner-install-"), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig(), { provider, webDir: "/nonexistent" })
  const boxId = await provider.create()
  const file = path.join(provider.root(boxId), ".boxyard", "box-runner.mjs")
  const source = fs.readFileSync(path.resolve("runner/box-runner.mjs"), "utf8")
  const install = () => (yard.tasks as unknown as { installCleanupRunner(id: string): Promise<string> }).installCleanupRunner(boxId)
  return { provider, yard, boxId, file, source, install }
}

describe("shared runner installation", () => {
  it("keeps the previous program executable while another turn uploads its replacement", async () => {
    const r = await setup()
    fs.writeFileSync(r.file, 'console.log("complete previous program")\n')
    const write = r.provider.writeFile.bind(r.provider)
    const reads: string[] = []
    vi.spyOn(r.provider, "writeFile").mockImplementation(async (id, destination, content) => {
      // A different Node process can read between truncation and the first write, even with writeFileSync.
      fs.writeFileSync(destination, "")
      reads.push(execFileSync(process.execPath, [r.file], { encoding: "utf8" }).trim())
      await write(id, destination, content)
    })
    try {
      expect(await r.install()).toBe(r.file)
      expect(reads).toEqual(["complete previous program"])
      expect(fs.readFileSync(r.file, "utf8")).toBe(r.source)
      expect(fs.readdirSync(path.dirname(r.file))).toEqual(["box-runner.mjs"])
    } finally {
      r.yard.stop()
    }
  })

  it("reuses an unchanged runner without GNU hash tools or a disk write", async () => {
    const r = await setup()
    fs.writeFileSync(r.file, r.source)
    const exec = r.provider.exec.bind(r.provider)
    vi.spyOn(r.provider, "exec").mockImplementation((id, command) => command.includes("sha256sum")
      ? Promise.resolve({ exitCode: 127, stdout: "", stderr: "sha256sum: command not found" })
      : exec(id, command))
    const write = vi.spyOn(r.provider, "writeFile")
    try {
      expect(await r.install()).toBe(r.file)
      expect(write.mock.calls.length).toBe(0)
    } finally {
      r.yard.stop()
    }
  })

  it("keeps the previous program and removes the staged file if publication fails", async () => {
    const r = await setup()
    const previous = 'console.log("complete previous program")\n'
    fs.writeFileSync(r.file, previous)
    const exec = r.provider.exec.bind(r.provider)
    vi.spyOn(r.provider, "exec").mockImplementation((id, command) => command.startsWith("mv -f ")
      ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "permission denied" })
      : exec(id, command))
    try {
      await expect(r.install()).rejects.toThrow("Couldn't publish task runner: permission denied")
      expect(fs.readFileSync(r.file, "utf8")).toBe(previous)
      expect(fs.readdirSync(path.dirname(r.file))).toEqual(["box-runner.mjs"])
    } finally {
      r.yard.stop()
    }
  })
})
