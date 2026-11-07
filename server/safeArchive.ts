import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createGunzip } from "node:zlib"
import { spawn } from "node:child_process"

export interface ArchiveBounds { expandedBytes: number; fileBytes: number; members: number }
export const ARCHIVE_BOUNDS: ArchiveBounds = { expandedBytes: 512 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, members: 50_000 }
const SERVER_FILES = new Set(["task.json", "turn.json", "signing.key", "codex-auth.json", "codex-login.json", "run.json", "turn.pid", "stop", "steer.json", "prompt.md"])

function safeName(name: string, taskId: string) {
  const clean = name.replace(/^(\.\/)+/, "").replace(/\/$/, "")
  if (!clean || clean.length > 4096 || clean.includes("\\") || /[\x00-\x1f\x7f]/.test(clean) || clean.startsWith("/")) throw new Error("Unsafe archive member path")
  const parts = clean.split("/")
  if (parts[0] !== taskId || parts.some(p => !p || p === "." || p === "..")) throw new Error("Archive member escapes its task")
  // These alias Git control paths on case-insensitive filesystems.
  if (parts.some(p => p.toLowerCase() === ".git" && p !== ".git")) throw new Error("Ambiguous Git metadata path")
  return clean
}
function number(field: Buffer) {
  const value = field.toString("ascii").replace(/\0.*$/, "").trim()
  if (!/^[0-7]*$/.test(value)) throw new Error("Unsupported archive number")
  const n = parseInt(value || "0", 8)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid archive size")
  return n
}
function text(field: Buffer) { return field.subarray(0, field.indexOf(0) < 0 ? field.length : field.indexOf(0)).toString("utf8") }
function pax(data: Buffer) {
  const values: Record<string, string> = {}
  for (let i = 0; i < data.length;) {
    const space = data.indexOf(32, i)
    if (space < 0) throw new Error("Invalid PAX header")
    const raw = data.subarray(i, space).toString()
    const length = /^\d+$/.test(raw) ? Number(raw) : 0
    if (!Number.isSafeInteger(length) || length <= space - i + 1 || i + length > data.length || data[i + length - 1] !== 10) throw new Error("Invalid PAX length")
    const entry = data.subarray(space + 1, i + length - 1).toString("utf8")
    const eq = entry.indexOf("=")
    if (eq < 1) throw new Error("Invalid PAX entry")
    const key = entry.slice(0, eq)
    if (/sparse|linkpath/i.test(key)) throw new Error("Unsupported archive metadata")
    // Repacking deliberately drops ACLs, xattrs and all other platform metadata.
    if (key === "path" || key === "size") values[key] = entry.slice(eq + 1)
    i += length
  }
  return values
}

/**
 * Parse into a fresh private staging directory, then emit a canonical tar. Never feed untrusted headers to tar.
 * Links are rejected deliberately: legacy archives remain retained for manual recovery, not extracted unsafely.
 */
export async function validateTaskArchive(input: string, taskId: string, bounds: ArchiveBounds = ARCHIVE_BOUNDS): Promise<{ file: string; cleanup(): void }> {
  if (!/^task_[A-Za-z0-9-]{6,40}$/.test(taskId)) throw new Error("Invalid task archive identity")
  const compressed = fs.lstatSync(input)
  if (!compressed.isFile() || compressed.size > ARCHIVE_BOUNDS.expandedBytes) throw new Error("Archive exceeds compressed byte limit or is not a regular file")
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "boxyard-restore-"))
  const staging = path.join(scratch, "staging")
  fs.mkdirSync(staging, { mode: 0o700 })
  const cleanup = () => fs.rmSync(scratch, { recursive: true, force: true })
  const source = fs.createReadStream(input)
  const unzip = createGunzip()
  source.on("error", e => unzip.destroy(e))
  source.pipe(unzip)
  const deadline = setTimeout(() => unzip.destroy(new Error("Archive validation timed out")), 60_000)
  let buffer: Buffer = Buffer.alloc(0)
  let pending: { name: string; size: number; left: number; pad: number; fd: number | null; metadata: Buffer[] | null; type: string } | null = null
  let extended: Record<string, string> = {}
  let total = 0, members = 0, endBlocks = 0
  const seen = new Map<string, string>()
  const configs = new Set<string>()
  const alternates = new Set<string>()
  try {
    for await (const chunk of unzip) {
      total += chunk.length
      if (total > bounds.expandedBytes) throw new Error("Archive exceeds expanded byte limit")
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (pending) {
          const take = Math.min(buffer.length, pending.left)
          if (take) {
            const bytes = buffer.subarray(0, take)
            if (pending.fd !== null) {
              for (let written = 0; written < bytes.length;) written += fs.writeSync(pending.fd, bytes, written, bytes.length - written)
            }
            pending.metadata?.push(Buffer.from(bytes))
            pending.left -= take; buffer = buffer.subarray(take)
          }
          if (pending.left || buffer.length < pending.pad) break
          buffer = buffer.subarray(pending.pad)
          if (pending.fd !== null) { fs.closeSync(pending.fd); pending.fd = null }
          if (pending.metadata) {
            const bytes = Buffer.concat(pending.metadata)
            if (pending.type === "x") extended = { ...extended, ...pax(bytes) }
            else if (pending.type === "L") extended.path = text(bytes)
          }
          pending = null
          continue
        }
        if (buffer.length < 512) break
        const header = buffer.subarray(0, 512); buffer = buffer.subarray(512)
        if (header.every(b => b === 0)) { endBlocks++; continue }
        if (endBlocks) throw new Error("Archive contains members after its end marker")
        let sum = 0
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
        if (number(header.subarray(148, 156)) !== sum) throw new Error("Invalid archive checksum")
        if (++members > bounds.members) throw new Error("Archive exceeds member limit")
        const type = String.fromCharCode(header[156] || 48)
        const size = number(header.subarray(124, 136))
        const metadata = type === "x" || type === "L"
        if (size > (metadata ? 64 * 1024 : bounds.fileBytes)) throw new Error("Archive member exceeds byte limit")
        if (!metadata && type !== "0" && type !== "5") throw new Error("Archive links and special files are not supported")
        let fd: number | null = null
        let name = ""
        if (!metadata) {
          const prefix = text(header.subarray(345, 500))
          name = safeName(extended.path ?? `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`, taskId)
          if (extended.size !== undefined && extended.size !== String(size)) throw new Error("Conflicting archive sizes")
          extended = {}
          if (type === "5" && size !== 0) throw new Error("Archive directory has content")
          const alias = name.normalize("NFC").toLowerCase()
          const previous = seen.get(alias)
          if (previous && (previous !== name || type !== "5")) throw new Error("Duplicate or aliased archive member")
          seen.set(alias, name)
          const relative = name.slice(taskId.length + 1)
          const parts = relative.split("/")
          const git = parts.indexOf(".git")
          if (git >= 0 && parts[git + 1] === undefined && type !== "5") throw new Error("Git indirection files are not supported")
          // Discard every executable/redirecting Git control file before any Git command sees it.
          const gitControl = git >= 0 && ["config", "config.worktree", "hooks", "worktrees", "modules", "commondir", "gitdir", "shallow.lock"].includes(parts[git + 1]?.toLowerCase() ?? "")
          const alternate = git >= 0 && ["objects/info/alternates", "objects/info/http-alternates"].includes(parts.slice(git + 1).join("/").toLowerCase())
          if (alternate && parts.at(-1) === "alternates") alternates.add(path.join(staging, name))
          const server = parts.length === 1 && SERVER_FILES.has(parts[0]!.toLowerCase())
          if (git >= 0) configs.add(path.join(staging, ...name.split("/").slice(0, taskId.split("/").length + git + 1)))
          if (!server && !gitControl && !alternate) {
            const dest = path.join(staging, name)
            if (type === "5") fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
            else {
              fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
              fd = fs.openSync(dest, "wx", number(header.subarray(100, 108)) & 0o111 ? 0o700 : 0o600)
            }
          }
        }
        pending = { name, size, left: size, pad: (512 - size % 512) % 512, fd, metadata: metadata ? [] : null, type }
      }
    }
    if (pending || buffer.some(b => b !== 0) || endBlocks < 2 || !seen.size || !fs.existsSync(path.join(staging, taskId))) throw new Error("Incomplete task archive")
    for (const git of configs) {
      fs.mkdirSync(git, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(git, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = true\n", { flag: "wx", mode: 0o600 })
    }
    for (const file of alternates) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "", { flag: "wx" }) }
    const file = path.join(scratch, "validated.tgz")
    await new Promise<void>((resolve, reject) => {
      const child = spawn("tar", ["czf", file, "-C", staging, taskId], { stdio: "ignore", env: { PATH: process.env.PATH, COPYFILE_DISABLE: "1" } })
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
      child.on("error", reject)
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Canonical archive creation failed")) })
    })
    return { file, cleanup }
  } catch (e) {
    if (pending?.fd !== null && pending?.fd !== undefined) fs.closeSync(pending.fd)
    cleanup()
    throw e
  } finally { clearTimeout(deadline); source.destroy(); unzip.destroy() }
}
