// Small WebP copies of hosted images (uploads, artifacts) for chat thumbnails and file chips: `?w=320` on a hosted
// image's URL (shared/thumbs.ts). Each is made on first request with sharp, an optional dependency, and kept in a
// `thumbs` folder beside its file, so it goes wherever the file goes. Without sharp, or for an image sharp can't
// read, the original is served, as before.
import fs from "node:fs"
import path from "node:path"
import type { Request, Response } from "express"
import { THUMB_MIMES, THUMB_WIDTHS, type ThumbWidth } from "../shared/thumbs.js"

/** The part of sharp this and project icons (server/projectIcons.ts) use. */
export type Sharp = (input: string | Buffer, options: { limitInputPixels: number }) => SharpImage
interface SharpImage {
  rotate(): SharpImage
  resize(options: { width: number; height?: number; fit?: "cover"; withoutEnlargement?: boolean }): SharpImage
  webp(options: { quality: number }): SharpImage
  toBuffer(): Promise<Buffer>
}

/** Larger images (beyond a 48 MP phone photo) are served as they are, so one file can't take the server's memory. */
export const MAX_INPUT_PIXELS = 64_000_000

/** Hosted files never change once saved (a new upload or publish gets a new id), so the browser keeps them. */
export const HOSTED_CACHE_CONTROL = "private, max-age=31536000, immutable"

/** `?w=` read as one of THUMB_WIDTHS, or null for none (serve the original). */
export function thumbWidth(w: unknown): ThumbWidth | null {
  const n = Number(w)
  return (THUMB_WIDTHS as readonly number[]).includes(n) ? (n as ThumbWidth) : null
}

/** Where `file`'s thumbnails live: a folder beside it, so deleting the file's folder deletes them too. */
export const thumbsDir = (file: string) => path.join(path.dirname(file), "thumbs")

export async function loadSharp(): Promise<Sharp> {
  // A variable specifier, so builds and type checks work where the optional dependency isn't installed.
  const name = "sharp"
  const mod = (await import(name)) as { default: Sharp & { cache(on: boolean): void } }
  // Thumbnails are written once and then served from disk: nothing for sharp to keep in memory.
  mod.default.cache(false)
  return mod.default
}

export class Thumbs {
  private sharp: Promise<Sharp | null> | null = null
  private readonly making = new Map<string, Promise<string | null>>()
  /** Files sharp couldn't read, so a broken image isn't retried on every request. */
  private readonly unreadable = new Set<string>()
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    private readonly load: () => Promise<Sharp> = loadSharp,
    /** Thumbnails made at once; a page opening with 20 new images queues the rest. */
    private readonly concurrency = 2,
  ) {}

  /** The path of `file`'s thumbnail at `width`, made on first use, or null to serve the original. */
  async get(file: string, mime: string, width: ThumbWidth | null): Promise<string | null> {
    if (width === null || !THUMB_MIMES.has(mime) || this.unreadable.has(file)) return null
    const out = path.join(thumbsDir(file), `${width}.webp`)
    if (fs.existsSync(out)) return out
    let job = this.making.get(out)
    if (!job) {
      job = this.make(file, out, width).finally(() => this.making.delete(out))
      this.making.set(out, job)
    }
    return job
  }

  private loadOnce(): Promise<Sharp | null> {
    this.sharp ??= this.load().catch((err: unknown) => {
      console.warn(`[box-yard] image thumbnails are off, images are sent full size: sharp didn't load (${err instanceof Error ? err.message : String(err)})`)
      return null
    })
    return this.sharp
  }

  private async make(file: string, out: string, width: ThumbWidth): Promise<string | null> {
    const sharp = await this.loadOnce()
    if (!sharp) return null
    await this.slot()
    const tmp = `${out}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      // rotate() applies a phone photo's EXIF orientation, which the thumbnail doesn't carry.
      const data = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
      fs.mkdirSync(path.dirname(out), { recursive: true })
      // Written aside and renamed, so a request never gets half a thumbnail.
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, out)
      return out
    } catch {
      fs.rmSync(tmp, { force: true })
      this.unreadable.add(file)
      return null
    } finally {
      this.release()
    }
  }

  private slot(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private release() {
    const next = this.waiting.shift()
    if (next) next()
    else this.running--
  }
}

/** Send untrusted hosted bytes with the same policy for originals, thumbnail fallbacks and thumbnails. */
export async function sendHosted(
  req: Request,
  res: Response,
  file: { path: string; mime: string },
  thumbs: Thumbs,
  { interactive = false }: { interactive?: boolean } = {},
) {
  res.setHeader("Content-Type", file.mime)
  res.setHeader("X-Content-Type-Options", "nosniff")
  // Sandbox every type, including navigated SVGs and future active formats. Never allow-same-origin:
  // artifact demos may run scripts/forms/popups, but must keep an opaque origin instead of the app's identity.
  res.setHeader("Content-Security-Policy", interactive ? "sandbox allow-scripts allow-forms allow-popups" : "sandbox")
  res.setHeader("Cache-Control", HOSTED_CACHE_CONTROL)
  const thumb = await thumbs.get(file.path, file.mime, thumbWidth(req.query.w))
  if (thumb) res.setHeader("Content-Type", "image/webp")
  // The path is Box Yard's own (the artifact or upload store), never the URL's. send's default (dotfiles: "ignore")
  // would 404 every file under a dot folder, such as a BOXYARD_DATA_DIR of ~/.local/share/box-yard, and `{ root }`
  // alone wouldn't do either: safeFilename keeps a leading dot, so a published ".env.example" would still 404.
  res.sendFile(thumb ?? file.path, { dotfiles: "allow" })
}
