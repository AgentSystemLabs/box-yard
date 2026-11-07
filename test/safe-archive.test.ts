import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { execFileSync } from "node:child_process"
import { validateTaskArchive, ARCHIVE_BOUNDS } from "../server/safeArchive.js"
import { tmpDir } from "./helpers.js"
import { testConfig } from "./helpers.js"
import { createBoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { vi } from "vitest"

const id = "task_example123"
interface Member { name: string; data?: string; type?: string; link?: string }
function archive(members: Member[]) {
  const chunks: Buffer[] = []
  for (const m of members) {
    const bytes = Buffer.from(m.data ?? "")
    const header = Buffer.alloc(512)
    header.write(m.name, 0, 100)
    header.write("0000700\0", 100)
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156)
    header.write(m.type ?? "0", 156)
    header.write(m.link ?? "", 157, 100)
    header.write("ustar\0", 257)
    const sum = [...header].reduce((a, b) => a + b, 0)
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  const file = path.join(tmpDir(), "input.tgz")
  fs.writeFileSync(file, gzipSync(Buffer.concat(chunks)))
  return file
}
const root = { name: id, type: "5" }

describe("validated archive staging", () => {
  it("rejects siblings, traversal, hard/symbolic links, devices, duplicate files and truncated streams", async () => {
    for (const member of [
      { name: "task_sibling/work/file", data: "hostile" }, { name: `${id}/../outside`, data: "hostile" },
      { name: `${id}/turn.json`, type: "2", link: "/outside" }, { name: `${id}/work/link`, type: "1", link: `${id}/work/file` },
      { name: `${id}/work/fifo`, type: "6" }, { name: `${id}/work/device`, type: "3" },
      { name: `${id}/work/.git`, data: "gitdir: /outside" },
    ]) await expect(validateTaskArchive(archive([root, member]), id)).rejects.toThrow()
    await expect(validateTaskArchive(archive([root, { name: `${id}/work/file` }, { name: `${id}/work/file` }]), id)).rejects.toThrow(/Duplicate/)
    const broken = archive([root]); fs.truncateSync(broken, 30)
    await expect(validateTaskArchive(broken, id)).rejects.toThrow()
  })

  it("enforces expanded/file/member bounds before extraction", async () => {
    const file = archive([root, { name: `${id}/work/file`, data: "x".repeat(4096) }])
    await expect(validateTaskArchive(file, id, { ...ARCHIVE_BOUNDS, expandedBytes: 2048 })).rejects.toThrow(/expanded/)
    await expect(validateTaskArchive(file, id, { ...ARCHIVE_BOUNDS, fileBytes: 1024 })).rejects.toThrow(/member/)
    await expect(validateTaskArchive(file, id, { ...ARCHIVE_BOUNDS, members: 1 })).rejects.toThrow(/member/)
  })

  it("repackages normal task data without server metadata, Git hooks/config/redirects or foreign alternates", async () => {
    const validated = await validateTaskArchive(archive([
      root, { name: `${id}/work/example.txt`, data: "preserved" }, { name: `${id}/events.seq`, data: "42" },
      { name: `${id}/turn.json`, data: "worker controlled metadata" },
      { name: `${id}/work/.git/config`, data: "[core]\nfsmonitor = example-host-command\n[include]\npath = /outside\n" },
      { name: `${id}/work/.git/hooks/post-checkout`, data: "example-host-command" },
      { name: `${id}/work/.git/commondir`, data: "/outside" },
      { name: `${id}/work/.git/objects/info/alternates`, data: "/outside" },
      { name: `${id}/work/.git/HEAD`, data: "ref: refs/heads/example\n" },
    ]), id)
    try {
      const dest = tmpDir()
      execFileSync("tar", ["xzf", validated.file, "-C", dest])
      expect(fs.readFileSync(path.join(dest, id, "work/example.txt"), "utf8")).toBe("preserved")
      expect(fs.readFileSync(path.join(dest, id, "events.seq"), "utf8")).toBe("42")
      for (const name of ["turn.json", "work/.git/hooks", "work/.git/commondir"]) expect(fs.existsSync(path.join(dest, id, name))).toBe(false)
      expect(fs.readFileSync(path.join(dest, id, "work/.git/config"), "utf8")).not.toMatch(/fsmonitor|include|outside/)
      expect(fs.readFileSync(path.join(dest, id, "work/.git/objects/info/alternates"), "utf8")).toBe("")
    } finally { validated.cleanup() }
  })

  it("accepts real platform tar output including long PAX names", async () => {
    const dir = tmpDir(); fs.mkdirSync(path.join(dir, id, "work"), { recursive: true })
    fs.writeFileSync(path.join(dir, id, "work", "a".repeat(150)), "long name")
    const file = path.join(tmpDir(), "real.tgz")
    execFileSync("tar", ["czf", file, "-C", dir, id], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" } })
    const validated = await validateTaskArchive(file, id)
    validated.cleanup()
  })

  it("uses validated staging through real TaskManager restore before any upload or Git execution", async () => {
    const config = testConfig({ mock: true })
    const provider = new LocalProvider(path.join(config.dataDir, "boxes"))
    const yard = createBoxYard(config, { provider, webDir: "/nonexistent" })
    vi.spyOn(yard.tasks as never, "schedule").mockImplementation(() => {})
    try {
      const project = yard.store.createProject({ name: "example" })
      const task = yard.tasks.createTask({ projectId: project.id, title: "Example", prompt: "Example" })
      const box = await provider.create()
      const dir = path.join(provider.root(box), "tasks", task.id)
      const internals = yard.tasks as unknown as { restoreArchive(row: unknown, project: unknown, box: string, dir: string, mirror: null): Promise<unknown>; provider: LocalProvider }
      const upload = vi.spyOn(internals.provider, "uploadFile")
      const hostile = archive([{ name: task.id, type: "5" }, { name: "task_sibling/work/file", data: "hostile" }])
      yard.store.updateTask(task.id, { archivePath: hostile })
      await expect(internals.restoreArchive(yard.store.getTaskRow(task.id), project, box, dir, null)).rejects.toThrow(/escapes/)
      expect(upload).not.toHaveBeenCalled()

      const marker = path.join(config.dataDir, "unexpected-hook")
      const valid = archive([
        { name: task.id, type: "5" }, { name: `${task.id}/work/example.txt`, data: "preserved" },
        { name: `${task.id}/turn.json`, data: "hostile turn" }, { name: `${task.id}/events.seq`, data: "42" },
        { name: `${task.id}/work/.git/config`, data: `[core]\nfsmonitor = touch ${marker}\n` },
        { name: `${task.id}/work/.git/hooks/post-checkout`, data: `#!/bin/sh\ntouch '${marker}'\n` },
      ])
      yard.store.updateTask(task.id, { archivePath: valid })
      await internals.restoreArchive(yard.store.getTaskRow(task.id), project, box, dir, null)
      expect(upload).toHaveBeenCalledOnce()
      expect(fs.readFileSync(path.join(dir, "work/example.txt"), "utf8")).toBe("preserved")
      expect(fs.readFileSync(path.join(dir, "events.seq"), "utf8")).toBe("42")
      expect(fs.existsSync(path.join(dir, "turn.json"))).toBe(false)
      expect(fs.existsSync(path.join(dir, "work/.git/hooks"))).toBe(false)
      expect(fs.readFileSync(path.join(dir, "work/.git/config"), "utf8")).not.toContain("fsmonitor")
      expect(fs.existsSync(marker)).toBe(false)
      // A pre-existing symlink destination is rejected without following it or altering its target.
      fs.rmSync(dir, { recursive: true })
      const outside = tmpDir(); fs.writeFileSync(path.join(outside, "sentinel"), "unchanged")
      fs.symlinkSync(outside, dir)
      await expect(internals.restoreArchive(yard.store.getTaskRow(task.id), project, box, dir, null)).rejects.toThrow(/unpacking/)
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("unchanged")
    } finally { yard.stop(); yard.store.db.close() }
  })
})
