import { randomUUID } from "node:crypto"
import { q, type BoxProvider } from "./providers/types.js"

export const MAX_WORKER_FILE_BYTES = 32 * 1024 * 1024
export interface WorkerReadOptions { maxBytes?: number; root?: string }

/** Runs on the worker; opening a regular file prevents FIFO/device hangs and checks symlink destinations. */
function boundedFileRead(file: string, root: string | null, max: number) {
  const fs = require("node:fs") as typeof import("node:fs")
  const path = require("node:path") as typeof import("node:path")
  const resolved = fs.realpathSync(file)
  if (root) {
    const relative = path.relative(fs.realpathSync(root), resolved)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File is outside the task workspace")
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > max) throw new Error("Worker file is not regular or exceeds its byte limit")
    let total = 0
    const chunk = Buffer.alloc(Math.min(max + 1, 128 * 1024))
    const parts: Buffer[] = []
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, max + 1 - total), null)
      if (!n) break
      total += n
      if (total > max) throw new Error("Worker file exceeds its byte limit")
      parts.push(Buffer.from(chunk.subarray(0, n)))
    }
    process.stdout.write(Buffer.concat(parts).toString("base64"))
  } finally { fs.closeSync(fd) }
}

/** The host enforces its own stream limit even when a hostile worker lies about stat or ignores the script. */
export async function readWorkerFile(provider: Pick<BoxProvider, "nodeBin" | "execStream">, boxId: string, file: string, opts: WorkerReadOptions = {}): Promise<Buffer> {
  const max = opts.maxBytes ?? MAX_WORKER_FILE_BYTES
  if (!Number.isSafeInteger(max) || max < 0 || max > MAX_WORKER_FILE_BYTES) throw new Error("Invalid worker file byte limit")
  const limit = Math.ceil(max / 3) * 4
  let bytes = 0
  const parts: string[] = []
  const args = Buffer.from(JSON.stringify([file, opts.root ?? null, max])).toString("base64")
  const script = `/* boxyard-bounded-read */ try { (${boundedFileRead.toString()})(...JSON.parse(Buffer.from(process.argv[1], "base64").toString())) } catch(e) { process.exitCode = e.code === "ENOENT" ? 44 : 1 }`
  const result = await provider.execStream(boxId, `${q(provider.nodeBin)} -e ${q(script)} -- ${q(args)}`, chunk => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limit) throw new Error("Worker file stream exceeds its byte limit")
    parts.push(chunk)
  })
  if (result.exitCode === 44) throw Object.assign(new Error("Worker file is missing"), { code: "ENOENT" })
  if (result.exitCode !== 0) throw new Error("Worker file read failed (missing, outside workspace, non-regular or too large)")
  const encoded = parts.join("")
  if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) || /=/.test(encoded.slice(0, -2))) throw new Error("Invalid worker file encoding")
  const data = Buffer.from(encoded, "base64")
  if (data.length > max) throw new Error("Worker file exceeds its byte limit")
  return data
}

/** For APIs that otherwise return the worker's complete stdout as one unbounded JSON/string result. */
export async function boundedWorkerExec(provider: Pick<BoxProvider, "execStream">, boxId: string, command: string) {
  const parts: string[] = []
  let bytes = 0
  const marker = `\n__BOXYARD_STDERR_${randomUUID()}__\n`
  const wrapped = `e=$(mktemp) || exit 1; trap 'rm -f "$e"' EXIT; bash -c ${q(command)} 2>"$e"; c=$?; printf %s ${q(marker)}; tail -c 64000 "$e"; exit "$c"`
  try {
    const result = await provider.execStream(boxId, wrapped, chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 8 * 1024 * 1024) throw new Error("Command output exceeds its byte limit")
      parts.push(chunk)
    })
    const output = parts.join("")
    const split = output.lastIndexOf(marker)
    if (split < 0) return { exitCode: result.exitCode, stdout: output, stderr: "" }
    return { exitCode: result.exitCode, stdout: output.slice(0, split), stderr: output.slice(split + marker.length) }
  } catch (err) {
    if (bytes > 8 * 1024 * 1024) return { exitCode: 153, stdout: "", stderr: "Command output exceeds its byte limit" }
    throw err
  }
}
